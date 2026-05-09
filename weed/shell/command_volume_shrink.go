package shell

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs/weed/operation"
	"github.com/seaweedfs/seaweedfs/weed/pb"
	"github.com/seaweedfs/seaweedfs/weed/pb/volume_server_pb"
	"github.com/seaweedfs/seaweedfs/weed/storage/needle"
)

func init() {
	Commands = append(Commands, &commandVolumeShrink{})
}

type commandVolumeShrink struct{}

func (c *commandVolumeShrink) Name() string {
	return "volume.shrink"
}

func (c *commandVolumeShrink) Help() string {
	return `reclaim preallocated tail space from .dat files of readonly volumes

	# simulate (default): show what would be reclaimed, do not modify anything
	volume.shrink -collection <name>

	# actually shrink every readonly volume in a collection
	volume.shrink -collection <name> -apply

	# only act on volumes that can free at least 4 GiB
	volume.shrink -collection <name> -minMB 4096 -apply

	# single volume on a specific node
	volume.shrink -node <host:port> -volumeId <id> -apply

	The volume must be readonly. The volume server unmounts the volume,
	sparse-copies the live byte range to a fresh file, fsyncs and renames it,
	then remounts. No .idx / .vif change. The volume is briefly unavailable
	during the swap.
`
}

func (c *commandVolumeShrink) HasTag(CommandTag) bool { return false }

func (c *commandVolumeShrink) Do(args []string, commandEnv *CommandEnv, writer io.Writer) error {
	fs := flag.NewFlagSet(c.Name(), flag.ContinueOnError)
	collection := fs.String("collection", "", "limit to volumes in this collection (empty means default collection only)")
	allCollections := fs.Bool("allCollections", false, "operate across every collection (overrides -collection)")
	volumeIdInt := fs.Uint("volumeId", 0, "single volume id (requires -node)")
	nodeStr := fs.String("node", "", "single volume server <host>:<port> (requires -volumeId)")
	minMB := fs.Uint64("minMB", 1024, "skip volumes whose reclaimable bytes are below this many MiB")
	apply := fs.Bool("apply", false, "actually shrink; without -apply this is a simulation")
	includeWritable := fs.Bool("include-writable", false, "DANGEROUS: also try writable volumes (server still requires readonly and will reject)")
	timeout := fs.Duration("timeout", 30*time.Minute, "per-volume RPC timeout; a stuck node aborts that one volume and the batch continues")
	if err := fs.Parse(args); err != nil {
		return nil
	}

	if err := commandEnv.confirmIsLocked(args); err != nil {
		return err
	}

	// Guard against the weed-shell tokenizer eating quoted "" so that
	// `-collection "" -minMB 1` becomes `-collection -minMB 1`, which Go's
	// flag package then parses as collection="-minMB". If you really mean
	// the default collection, leave -collection out entirely or write it as
	// -collection= (with the equals sign) so flag knows the value is empty.
	if strings.HasPrefix(*collection, "-") {
		return fmt.Errorf("collection %q looks like a flag; pass -collection=<name> "+
			"(use the = form) or omit -collection to target the default collection", *collection)
	}

	infoAboutSimulationMode(writer, *apply, "-apply")
	minReclaim := *minMB * 1024 * 1024
	dryRun := !*apply

	// single-volume path
	if *nodeStr != "" || *volumeIdInt != 0 {
		if *nodeStr == "" || *volumeIdInt == 0 {
			return fmt.Errorf("-node and -volumeId must be set together")
		}
		return shrinkOne(commandEnv, writer, pb.ServerAddress(*nodeStr),
			needle.VolumeId(*volumeIdInt), minReclaim, dryRun, *timeout)
	}

	// collection path: enumerate from master topology
	topo, _, err := collectTopologyInfo(commandEnv, 0)
	if err != nil {
		return fmt.Errorf("collect topology: %w", err)
	}

	type target struct {
		node     pb.ServerAddress
		volumeId needle.VolumeId
		coll     string
	}
	var targets []target
	for _, dc := range topo.DataCenterInfos {
		for _, r := range dc.RackInfos {
			for _, dn := range r.DataNodeInfos {
				for _, di := range dn.DiskInfos {
					for _, vi := range di.VolumeInfos {
						if !*allCollections && vi.Collection != *collection {
							continue
						}
						if !vi.ReadOnly && !*includeWritable {
							continue
						}
						targets = append(targets, target{
							node:     pb.ServerAddress(dn.Id),
							volumeId: needle.VolumeId(vi.Id),
							coll:     vi.Collection,
						})
					}
				}
			}
		}
	}

	if len(targets) == 0 {
		fmt.Fprintf(writer, "no readonly volumes found (allCollections=%v collection=%q)\n",
			*allCollections, *collection)
		return nil
	}

	fmt.Fprintf(writer, "found %d candidate volumes\n", len(targets))
	var ok, skipped, failed int
	var totalReclaim uint64
	for _, t := range targets {
		r, err := callShrink(commandEnv, t.node, t.volumeId, minReclaim, dryRun, *timeout)
		if err != nil {
			fmt.Fprintf(writer, "  FAIL  vid=%d node=%s coll=%s: %v\n", t.volumeId, t.node, t.coll, err)
			failed++
			continue
		}
		totalReclaim += r.reclaimed
		warn := ""
		if r.warning != "" {
			warn = fmt.Sprintf(" warn=%q", r.warning)
		}
		switch r.status {
		case "shrunk":
			ok++
			fmt.Fprintf(writer, "  OK    vid=%d node=%s coll=%s reclaimed=%s%s\n",
				t.volumeId, t.node, t.coll, humanBytes(r.reclaimed), warn)
		case "dry-run":
			ok++
			fmt.Fprintf(writer, "  DRY   vid=%d node=%s coll=%s would-reclaim=%s\n",
				t.volumeId, t.node, t.coll, humanBytes(r.reclaimed))
		default:
			skipped++
			fmt.Fprintf(writer, "  SKIP  vid=%d node=%s coll=%s reason=%s\n",
				t.volumeId, t.node, t.coll, r.status)
		}
	}
	totalLabel := "total_reclaimed"
	if dryRun {
		totalLabel = "total_would_reclaim"
	}
	fmt.Fprintf(writer, "summary: ok=%d skip=%d fail=%d %s=%s\n",
		ok, skipped, failed, totalLabel, humanBytes(totalReclaim))
	return nil
}

func shrinkOne(commandEnv *CommandEnv, writer io.Writer, node pb.ServerAddress,
	vid needle.VolumeId, minReclaim uint64, dryRun bool, timeout time.Duration) error {
	r, err := callShrink(commandEnv, node, vid, minReclaim, dryRun, timeout)
	if err != nil {
		return err
	}
	warn := ""
	if r.warning != "" {
		warn = fmt.Sprintf(" warn=%q", r.warning)
	}
	reclaimLabel := "reclaimed"
	if r.status == "dry-run" {
		reclaimLabel = "would-reclaim"
	}
	fmt.Fprintf(writer, "vid=%d node=%s status=%s %s=%s%s\n",
		vid, node, r.status, reclaimLabel, humanBytes(r.reclaimed), warn)
	return nil
}

// shrinkResult collapses the parts of VolumeShrinkPreallocatedResponse the
// shell layer actually renders.
type shrinkResult struct {
	reclaimed uint64
	status    string // "shrunk" | "dry-run" | free-form skip reason
	warning   string // server-reported durability or other warning, may be empty
}

// callShrink dials the volume server. timeout caps a single RPC so a stuck
// node cannot hang the whole batch.
func callShrink(commandEnv *CommandEnv, node pb.ServerAddress, vid needle.VolumeId,
	minReclaim uint64, dryRun bool, timeout time.Duration) (shrinkResult, error) {
	var resp *volume_server_pb.VolumeShrinkPreallocatedResponse
	err := operation.WithVolumeServerClient(false, node, commandEnv.option.GrpcDialOption,
		func(c volume_server_pb.VolumeServerClient) error {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			r, callErr := c.VolumeShrinkPreallocated(ctx,
				&volume_server_pb.VolumeShrinkPreallocatedRequest{
					VolumeId:        uint32(vid),
					MinReclaimBytes: minReclaim,
					DryRun:          dryRun,
				})
			if callErr != nil {
				return callErr
			}
			resp = r
			return nil
		})
	if err != nil {
		return shrinkResult{}, err
	}
	out := shrinkResult{reclaimed: resp.ReclaimedBytes, warning: resp.DurabilityWarning}
	switch {
	case resp.Shrunk:
		out.status = "shrunk"
	case dryRun && resp.SkipReason == "dry-run":
		out.status = "dry-run"
	default:
		out.status = resp.SkipReason
	}
	return out, nil
}

func humanBytes(b uint64) string {
	const u = 1024
	if b < u {
		return fmt.Sprintf("%dB", b)
	}
	div, exp := uint64(u), 0
	for n := b / u; n >= u; n /= u {
		div *= u
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(b)/float64(div), "KMGTPE"[exp])
}
