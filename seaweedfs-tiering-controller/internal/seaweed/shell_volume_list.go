package seaweed

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// ListVolumesShellAt invokes `weed shell volume.list` against the given
// master and parses the indented text output into the same VolumeInfo +
// NodeDiskStats slices that the gRPC ListVolumesAt / ListNodesAt pair
// returns. A single shell call yields both, so the cache layer can fold
// two RPCs into one subprocess invocation.
//
// Why text parsing instead of gRPC: master_pb.VolumeList has changed
// fields and required permissions across SeaweedFS releases. `weed shell
// volume.list` is the user-facing CLI surface and stays stable; running
// the cluster's own `weed` binary (per cluster.weed_bin_path) guarantees
// the parser sees output that matches the cluster version.
//
// The lock/unlock dance is skipped for this read-only call so concurrent
// dashboard refreshes don't serialise on the cluster-wide shell lock.
func (c *Client) ListVolumesShellAt(ctx context.Context, master, binPath string) ([]VolumeInfo, []NodeDiskStats, error) {
	out, err := c.RunShellReadOnly(ctx, master, binPath, "volume.list", nil)
	if err != nil {
		return nil, nil, err
	}
	return parseVolumeListOutput(out), parseNodeDiskStats(out), nil
}

// `volume id:N key:value ...` — keys and values are space-separated key:value
// pairs; collection / remote_storage_* may carry quoted strings. The regex
// captures either a quoted run (handling escaped quotes) or a non-whitespace
// run as the value.
var volumeFieldRE = regexp.MustCompile(`([a-z_]+):("(?:\\.|[^"\\])*"|\S+)`)

// parseVolumeListOutput walks the tree-shaped output of `volume.list`,
// emitting one VolumeInfo per "volume ..." line and inheriting DC / rack /
// node / disk context from the surrounding indentation level.
func parseVolumeListOutput(out string) []VolumeInfo {
	var (
		dc, rack, node, disk string
		vols                 []VolumeInfo
	)
	for _, raw := range strings.Split(out, "\n") {
		trim := strings.TrimLeft(raw, " \t")
		if trim == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trim, "DataCenter "):
			dc = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Rack "):
			rack = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "DataNode "):
			node = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Disk "):
			disk = diskTypeFromLine(trim)
		case strings.HasPrefix(trim, "volume "):
			v := parseVolumeFields(trim)
			v.Server = node
			v.Rack = rack
			v.DataCenter = dc
			if v.DiskType == "" {
				v.DiskType = disk
			}
			vols = append(vols, v)
		}
	}
	return vols
}

// parseNodeDiskStats walks the same output and collects one row per
// (node, disk-type) tuple. The summary line carries counts; bytes are
// summed from the volumes nested below.
func parseNodeDiskStats(out string) []NodeDiskStats {
	type key struct{ node, disk string }
	stats := map[key]*NodeDiskStats{}
	var dc, rack, node, disk string
	for _, raw := range strings.Split(out, "\n") {
		trim := strings.TrimLeft(raw, " \t")
		if trim == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trim, "DataCenter "):
			dc = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Rack "):
			rack = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "DataNode "):
			node = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Disk "):
			disk = diskTypeFromLine(trim)
			ns := &NodeDiskStats{
				Server: node, Rack: rack, DataCenter: dc, DiskType: disk,
			}
			fillDiskCounts(ns, trim)
			stats[key{node, disk}] = ns
		case strings.HasPrefix(trim, "volume "):
			v := parseVolumeFields(trim)
			if ns, ok := stats[key{node, disk}]; ok {
				ns.UsedBytes += v.Size
			}
		}
	}
	out2 := make([]NodeDiskStats, 0, len(stats))
	for _, ns := range stats {
		out2 = append(out2, *ns)
	}
	return out2
}

// `Disk hdd(volume:5/200 active:5 free:195 remote:0)` → "hdd".
func diskTypeFromLine(line string) string {
	rest := strings.TrimPrefix(line, "Disk ")
	if i := strings.Index(rest, "("); i > 0 {
		return strings.TrimSpace(rest[:i])
	}
	return strings.TrimSpace(rest)
}

// fillDiskCounts pulls the volume:N/M / active:N / free:N / remote:N counts
// from the parenthesised summary on a Disk line.
func fillDiskCounts(ns *NodeDiskStats, line string) {
	lp := strings.Index(line, "(")
	rp := strings.LastIndex(line, ")")
	if lp < 0 || rp <= lp {
		return
	}
	for _, kv := range strings.Fields(line[lp+1 : rp]) {
		colon := strings.Index(kv, ":")
		if colon <= 0 {
			continue
		}
		k, v := kv[:colon], kv[colon+1:]
		if k == "volume" {
			if slash := strings.Index(v, "/"); slash > 0 {
				ns.VolumeCount, _ = strconv.ParseInt(v[:slash], 10, 64)
				ns.MaxVolumeCount, _ = strconv.ParseInt(v[slash+1:], 10, 64)
			}
			continue
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		switch k {
		case "active":
			ns.ActiveVolumeCount = n
		case "free":
			ns.FreeVolumeCount = n
		case "remote":
			ns.RemoteVolumeCount = n
		}
	}
}

func parseVolumeFields(line string) VolumeInfo {
	var v VolumeInfo
	for _, m := range volumeFieldRE.FindAllStringSubmatch(line, -1) {
		key, val := m[1], m[2]
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "id":
			n, _ := strconv.ParseUint(val, 10, 32)
			v.ID = uint32(n)
		case "size":
			v.Size, _ = strconv.ParseUint(val, 10, 64)
		case "collection":
			v.Collection = val
		case "file_count":
			v.FileCount, _ = strconv.ParseUint(val, 10, 64)
		case "delete_count":
			v.DeleteCount, _ = strconv.ParseUint(val, 10, 64)
		case "deleted_byte_count":
			v.DeletedBytes, _ = strconv.ParseUint(val, 10, 64)
		case "read_only":
			v.ReadOnly = val == "true"
		case "modified_at_second":
			v.ModifiedAtSec, _ = strconv.ParseInt(val, 10, 64)
		case "replica_placement":
			n, _ := strconv.ParseUint(val, 10, 32)
			v.ReplicaPlace = uint32(n)
		case "disk_type":
			v.DiskType = val
		case "remote_storage_name":
			v.RemoteStorageName = val
		case "remote_storage_key":
			v.RemoteStorageKey = val
		}
	}
	return v
}

func fieldAt(line string, idx int) string {
	f := strings.Fields(line)
	if idx < 0 || idx >= len(f) {
		return ""
	}
	return f[idx]
}
