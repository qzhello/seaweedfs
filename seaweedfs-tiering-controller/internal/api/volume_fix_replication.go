package api

// `volume.fix.replication` — finds under-replicated / over-replicated /
// misplaced volumes and (with -apply) restores them. Same dual-mode
// shape as ec.rebuild/ec.balance: dry-run returns a parsed summary,
// apply streams stdout via SSE so the dashboard can show progress.

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// volumeFixReplicationBody mirrors `weed shell volume.fix.replication`
// flags. Every field is optional; non-zero values get forwarded as CLI
// args. `Apply` is gated by `forceApply` middleware at the route, not
// trusted from the body.
type volumeFixReplicationBody struct {
	CollectionPattern  string `json:"collectionPattern"`
	DoDelete           *bool  `json:"doDelete"`
	DoCheck            *bool  `json:"doCheck"`
	Verbose            bool   `json:"verbose"`
	MaxParallelization int    `json:"maxParallelization"`
	Retry              int    `json:"retry"`
	VolumesPerStep     int    `json:"volumesPerStep"`
	Apply              bool   `json:"apply"`
}

func buildVolumeFixReplicationArgs(body volumeFixReplicationBody) []string {
	var args []string
	if p := strings.TrimSpace(body.CollectionPattern); p != "" {
		args = append(args, "-collectionPattern="+p)
	}
	if body.DoDelete != nil && !*body.DoDelete {
		args = append(args, "-doDelete=false")
	}
	if body.DoCheck != nil && !*body.DoCheck {
		args = append(args, "-doCheck=false")
	}
	if body.Verbose {
		args = append(args, "-verbose")
	}
	if body.MaxParallelization > 0 {
		args = append(args, "-maxParallelization="+strconv.Itoa(body.MaxParallelization))
	}
	if body.Retry > 0 {
		args = append(args, "-retry="+strconv.Itoa(body.Retry))
	}
	if body.VolumesPerStep > 0 {
		args = append(args, "-volumesPerStep="+strconv.Itoa(body.VolumesPerStep))
	}
	if body.Apply {
		args = append(args, "-apply")
	}
	return args
}

// VolumeRepairResult is the end-state for one volume after running
// `volume.fix.replication`. Before/After are the replica counts observed
// in the first and last "checking volume X has N replicas" lines for
// that volume; the apply loop re-collects topology after each fix so
// the second snapshot tells us whether the repair actually landed.
type VolumeRepairResult struct {
	VolumeID  uint32 `json:"volume_id"`
	Placement string `json:"placement"` // e.g. "010"
	Kind      string `json:"kind"`      // under | over | misplaced
	Before    int    `json:"before"`    // initial replica count
	After     int    `json:"after"`     // final replica count
	Status    string `json:"status"`    // fixed | failed | detected | pending
	Error     string `json:"error,omitempty"`
}

// PlacementStat aggregates results by replica-placement strategy
// ("010", "001", …) so the dashboard can show e.g. "010: 1 fixed".
type PlacementStat struct {
	Placement string `json:"placement"`
	Detected  int    `json:"detected"`
	Fixed     int    `json:"fixed"`
	Failed    int    `json:"failed"`
}

// VolumeFixReplicationSummary is the structured result of one
// volume.fix.replication run, both dry-run and apply.
type VolumeFixReplicationSummary struct {
	Results      []VolumeRepairResult `json:"results"`
	ByPlacement  []PlacementStat      `json:"by_placement"`
	Detected     int                  `json:"detected"`
	Fixed        int                  `json:"fixed"`
	Failed       int                  `json:"failed"`
	Pending      int                  `json:"pending"`
	UnderReplica int                  `json:"under_replicated"`
	OverReplica  int                  `json:"over_replicated"`
	Misplaced    int                  `json:"misplaced"`
}

// Line shapes from weed/shell/command_volume_fix_replication.go.
// We anchor each pattern to fields it MUST contain so noisy verbose
// output (locations list etc.) doesn't false-match.
var (
	reChecking        = regexp.MustCompile(`^checking\s+volume\s+(\d+)\s+replication\s+(\S+)\s+has\s+(\d+)\s+replica`)
	reUnderReplicated = regexp.MustCompile(`^volume\s+(\d+)\s+replication\s+(\S+),\s*but\s+under\s+replicated\s+\+?(\d+)`)
	reOverReplicated  = regexp.MustCompile(`^volume\s+(\d+)\s+replication\s+(\S+),\s*but\s+over\s+replicated\s+-?(\d+)`)
	reMisplaced       = regexp.MustCompile(`^volume\s+(\d+)\s+replication\s+(\S+)\s+is\s+not\s+well\s+placed`)
	reReplicating     = regexp.MustCompile(`^replicating\s+volume\s+(\d+)\s+(\S+)\s+from\s+\S+\s+to\s+dataNode\s+(\S+)`)
	reDeleting        = regexp.MustCompile(`^deleting\s+volume\s+(\d+)\s+from\s+(.+?)(?:\s*:\s*(.+))?$`)
	reFixUnderErr     = regexp.MustCompile(`^fixing\s+under\s+replicated\s+volume\s+(\d+):\s*(.*)`)
	reFailedToPlace   = regexp.MustCompile(`^failed\s+to\s+place\s+volume\s+(\d+)\s+replica`)
)

// volRepairState accumulates per-volume signals during the scan.
// The summary derives Before/After/Status from this once parsing
// completes.
type volRepairState struct {
	placement string
	kind      string // under | over | misplaced
	counts    []int  // every "has N replicas" snapshot, in order
	attempted bool   // saw a replicating/deleting line
	err       string // non-empty = a recognised failure was logged
}

func parseVolumeFixReplicationOutput(out string) VolumeFixReplicationSummary {
	byID := map[uint32]*volRepairState{}
	get := func(id uint32) *volRepairState {
		s, ok := byID[id]
		if !ok {
			s = &volRepairState{}
			byID[id] = s
		}
		return s
	}

	for _, ln := range strings.Split(out, "\n") {
		l := strings.TrimSpace(ln)
		if l == "" {
			continue
		}
		if m := reChecking.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.placement = m[2]
			n, _ := strconv.Atoi(m[3])
			s.counts = append(s.counts, n)
			continue
		}
		if m := reUnderReplicated.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.placement = m[2]
			s.kind = "under"
			continue
		}
		if m := reOverReplicated.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.placement = m[2]
			s.kind = "over"
			continue
		}
		if m := reMisplaced.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.placement = m[2]
			s.kind = "misplaced"
			continue
		}
		if m := reReplicating.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.placement = m[2]
			s.attempted = true
			continue
		}
		if m := reDeleting.FindStringSubmatch(l); m != nil {
			s := get(parseUint32(m[1]))
			s.attempted = true
			// `deleting volume X from server : ERROR` → 3rd group has err.
			if m[3] != "" {
				s.err = m[3]
			}
			continue
		}
		if m := reFixUnderErr.FindStringSubmatch(l); m != nil {
			get(parseUint32(m[1])).err = m[2]
			continue
		}
		if m := reFailedToPlace.FindStringSubmatch(l); m != nil {
			get(parseUint32(m[1])).err = "no available placement"
			continue
		}
	}

	sum := VolumeFixReplicationSummary{Results: []VolumeRepairResult{}}
	byPlacement := map[string]*PlacementStat{}
	for id, s := range byID {
		// Skip volumes that only ever appeared as healthy "checking"
		// lines (no issue, no action) — operator doesn't need to see them.
		if s.kind == "" && !s.attempted && s.err == "" {
			continue
		}

		before, after := 0, 0
		if len(s.counts) > 0 {
			before = s.counts[0]
			after = s.counts[len(s.counts)-1]
		}

		// Status derivation:
		//   - error logged  → failed
		//   - issue detected, no fix attempted → detected (dry-run shape)
		//   - fix attempted + count changed in the right direction → fixed
		//   - fix attempted but counts didn't change → pending
		status := "detected"
		switch {
		case s.err != "":
			status = "failed"
		case s.attempted && s.kind == "under" && after > before:
			status = "fixed"
		case s.attempted && s.kind == "over" && after < before:
			status = "fixed"
		case s.attempted && s.kind == "misplaced":
			// Misplaced fixes rebuild the replica elsewhere; the
			// total count usually stays the same, so we trust the
			// shell's "attempted, no error" as success.
			status = "fixed"
		case s.attempted:
			status = "pending"
		}

		sum.Results = append(sum.Results, VolumeRepairResult{
			VolumeID:  id,
			Placement: s.placement,
			Kind:      s.kind,
			Before:    before,
			After:     after,
			Status:    status,
			Error:     s.err,
		})

		ps, ok := byPlacement[s.placement]
		if !ok {
			ps = &PlacementStat{Placement: s.placement}
			byPlacement[s.placement] = ps
		}
		ps.Detected++
		switch status {
		case "fixed":
			ps.Fixed++
			sum.Fixed++
		case "failed":
			ps.Failed++
			sum.Failed++
		default:
			sum.Pending++
		}
		sum.Detected++
		switch s.kind {
		case "under":
			sum.UnderReplica++
		case "over":
			sum.OverReplica++
		case "misplaced":
			sum.Misplaced++
		}
	}

	for _, ps := range byPlacement {
		sum.ByPlacement = append(sum.ByPlacement, *ps)
	}
	return sum
}

// volumeFixReplicationHandler always streams via SSE — both dry-run and
// apply mode. Unlike ec.rebuild's dry-run (which is fast), this shell
// command blocks for ~15s on topology collection before printing
// anything, so blocking JSON would feel frozen. Streaming lets the
// dashboard show "wait 15 seconds and then collect topology..." the
// moment the operator clicks Run. The parsed summary is included in
// the final `done` event so the dialog can render counts after exit.
//
// Apply vs dry-run is decided by the route's forceApply middleware
// (sets body.Apply); clients can't override.
//
// POST /api/v1/clusters/:id/volume/fix-replication/{plan,apply}
func volumeFixReplicationHandler(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body volumeFixReplicationBody
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildVolumeFixReplicationArgs(body)

		// Only the apply path mutates; gate it through the safety Guard
		// while leaving dry-run planning open. Must run before SSE headers
		// so the 423 body is well-formed JSON.
		if body.Apply && !guardAllow(d, c, &id) {
			return
		}

		// SSE headers + start marker.
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		started := time.Now()

		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()

		var outBuf strings.Builder
		var runErr error
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"args":       args,
				"apply":      body.Apply,
				"started_at": started.UnixMilli(),
				"command":    "volume.fix.replication",
			})
			// Tee subprocess stdout into both the SSE stream and a
			// buffer so we can parse a structured summary at exit.
			sink := func(line string) {
				outBuf.WriteString(line)
				outBuf.WriteByte('\n')
				lineSink(line)
			}
			_, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
				"volume.fix.replication", args, sink)

			summary := parseVolumeFixReplicationOutput(outBuf.String())
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
			}
			dur := time.Since(started).Milliseconds()
			emit("done", gin.H{
				"ok":          runErr == nil,
				"error":       errStr,
				"duration_ms": dur,
				"summary":     summary,
			})
		})
		// Audit AFTER the stream completes — re-parse the buffer for
		// the final counts (the inner closure already wrote them into
		// the SSE `done` event for the dashboard).
		summary := parseVolumeFixReplicationOutput(outBuf.String())
		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}
		op := "volume.fix.replication.plan"
		if body.Apply {
			op = "volume.fix.replication.apply"
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, op, "cluster", id.String(), map[string]any{
			"collection_pattern": body.CollectionPattern,
			"under_replicated":   summary.UnderReplica,
			"over_replicated":    summary.OverReplica,
			"misplaced":          summary.Misplaced,
			"ok":                 runErr == nil,
			"error":              errStr,
		})
	}
}
