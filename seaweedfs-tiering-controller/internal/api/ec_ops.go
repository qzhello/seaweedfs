package api

// EC operations — dry-run endpoints for `ec.rebuild` and `ec.balance`.
//
// Both shell commands default to dry-run mode (no `-apply`), so calling
// them through RunShellReadOnly produces a plan/diagnosis only. The
// mutating apply path lives in the skill+task pipeline, not here.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// streamWithHeartbeat wraps `inner` (which receives an `emit` callback
// for writing SSE events) with a 3-second heartbeat that fires a `ping`
// event whenever the shell hasn't produced a line in the last ~2s. The
// frontend renders these as a "… still waiting (Xs)" sentinel so long
// idle stretches (15s topology gather, lock acquisition, polling for
// new replicas) don't look frozen. Returns once `inner` exits.
func streamWithHeartbeat(c *gin.Context, started time.Time, inner func(emit func(string, interface{}), lineSink func(string))) {
	var writeMu sync.Mutex
	emit := func(event string, payload interface{}) {
		writeMu.Lock()
		defer writeMu.Unlock()
		sendSSE(c, event, payload)
	}
	var lastLineAt atomic.Int64
	lastLineAt.Store(started.UnixMilli())
	lineSink := func(line string) {
		lastLineAt.Store(time.Now().UnixMilli())
		emit("line", line)
	}
	hbDone := make(chan struct{})
	go func() {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-tick.C:
				nowMs := time.Now().UnixMilli()
				if nowMs-lastLineAt.Load() < 2000 {
					continue
				}
				emit("ping", gin.H{"elapsed_ms": nowMs - started.UnixMilli()})
			}
		}
	}()
	inner(emit, lineSink)
	close(hbDone)
}

func uitoa(n uint64) string  { return strconv.FormatUint(n, 10) }
func ftoa(f float64) string  { return strconv.FormatFloat(f, 'f', -1, 64) }

// ecRebuildBody mirrors the `weed shell ec.rebuild` flag set.
type ecRebuildBody struct {
	Collection         string `json:"collection"`
	DiskType           string `json:"diskType"`
	MaxParallelization int    `json:"maxParallelization"`
	Apply              bool   `json:"apply"`
}

// buildECRebuildArgs renders ec.rebuild flags. Reference:
//
//	ec.rebuild [-collection=EACH_COLLECTION|<name>] [-apply]
//	           [-maxParallelization N] [-diskType=<disk_type>]
func buildECRebuildArgs(body ecRebuildBody) []string {
	collection := strings.TrimSpace(body.Collection)
	if collection == "" {
		collection = "EACH_COLLECTION"
	}
	args := []string{"-collection=" + collection}
	if dt := strings.TrimSpace(body.DiskType); dt != "" {
		args = append(args, "-diskType="+dt)
	}
	if body.MaxParallelization > 0 {
		args = append(args, "-maxParallelization="+uitoa(uint64(body.MaxParallelization)))
	}
	if body.Apply {
		args = append(args, "-apply")
	}
	return args
}

// ecRebuildPlan runs `ec.rebuild` in dry-run mode (apply=false) and
// returns a parsed summary. When the body sets apply=true the response
// switches to text/event-stream so the caller can watch the actual run.
//
// POST /api/v1/clusters/:id/ec/rebuild
func ecRebuildPlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body ecRebuildBody
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildECRebuildArgs(body)

		// Apply path requires `volume.ec.rebuild` — gated separately at the
		// route. Dry-run is gated by `volume.read`.
		if body.Apply {
			streamECShell(c, d, cl.MasterAddr, cl.WeedBinPath, "ec.rebuild", args, id.String(), 2*time.Hour, gin.H{
				"collection": body.Collection,
				"disk_type":  body.DiskType,
			})
			return
		}

		// Dry-run: blocking call, parse summary, return JSON.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.rebuild", args, nil)
		if runErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": runErr.Error(), "output": out})
			return
		}
		summary := parseECRebuildOutput(out)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.rebuild.plan", "cluster", id.String(), map[string]any{
			"collection":       body.Collection,
			"disk_type":        body.DiskType,
			"degraded_volumes": len(summary.Degraded),
			"unrecoverable":    summary.Unrecoverable,
			"rebuildable":      summary.Rebuildable,
		})
		c.JSON(http.StatusOK, gin.H{
			"summary": summary,
			"output":  out,
		})
	}
}

// ecBalanceBody mirrors `weed shell ec.balance` flags.
type ecBalanceBody struct {
	Collection            string `json:"collection"`
	DataCenter            string `json:"dataCenter"`
	DiskType              string `json:"diskType"`
	ShardReplicaPlacement string `json:"shardReplicaPlacement"`
	MaxParallelization    int    `json:"maxParallelization"`
	Apply                 bool   `json:"apply"`
}

// buildECBalanceArgs renders ec.balance flags. Reference:
//
//	ec.balance [-collection=EACH_COLLECTION|<name>] [-apply]
//	           [-dataCenter <data_center>]
//	           [-shardReplicaPlacement <replica_placement>]
//	           [-diskType <disk_type>] [-maxParallelization N]
func buildECBalanceArgs(body ecBalanceBody) []string {
	collection := strings.TrimSpace(body.Collection)
	if collection == "" {
		collection = "EACH_COLLECTION"
	}
	args := []string{"-collection=" + collection}
	if dc := strings.TrimSpace(body.DataCenter); dc != "" {
		args = append(args, "-dataCenter="+dc)
	}
	if dt := strings.TrimSpace(body.DiskType); dt != "" {
		args = append(args, "-diskType="+dt)
	}
	if rp := strings.TrimSpace(body.ShardReplicaPlacement); rp != "" {
		args = append(args, "-shardReplicaPlacement="+rp)
	}
	if body.MaxParallelization > 0 {
		args = append(args, "-maxParallelization="+uitoa(uint64(body.MaxParallelization)))
	}
	if body.Apply {
		args = append(args, "-apply")
	}
	return args
}

// ecBalancePlan runs ec.balance — dry-run when apply=false (returns
// parsed move count as JSON), SSE stream when apply=true.
//
// POST /api/v1/clusters/:id/ec/balance
func ecBalancePlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body ecBalanceBody
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildECBalanceArgs(body)

		if body.Apply {
			streamECShell(c, d, cl.MasterAddr, cl.WeedBinPath, "ec.balance", args, id.String(), 2*time.Hour, gin.H{
				"collection":              body.Collection,
				"data_center":             body.DataCenter,
				"disk_type":               body.DiskType,
				"shard_replica_placement": body.ShardReplicaPlacement,
			})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.balance", args, nil)
		if runErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": runErr.Error(), "output": out})
			return
		}
		moves := countECBalanceMoves(out)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.balance.plan", "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"data_center": body.DataCenter,
			"disk_type":   body.DiskType,
			"moves":       moves,
		})
		c.JSON(http.StatusOK, gin.H{
			"moves":  moves,
			"output": out,
		})
	}
}

// forceApply wraps an ec.rebuild / ec.balance handler so that the route
// decides whether the call is a dry-run (`apply=false`) or a real run
// (`apply=true`) — clients can't override by setting the field in their
// body. Implementation: read the body into a generic map, set the field,
// re-encode, hand the modified body off to the inner handler via a
// rewritten request.
func forceApply(apply bool, inner gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, _ := io.ReadAll(c.Request.Body)
		_ = c.Request.Body.Close()
		m := map[string]any{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &m)
		}
		m["apply"] = apply
		patched, _ := json.Marshal(m)
		c.Request.Body = io.NopCloser(bytes.NewReader(patched))
		c.Request.ContentLength = int64(len(patched))
		inner(c)
	}
}

// streamECShell wraps a single `weed shell` ec.* command in SSE: each
// subprocess stdout line becomes one `line` event, with `start` and
// `done` brackets. Used by the apply path of rebuild + balance.
func streamECShell(c *gin.Context, d Deps, master, binPath, name string, args []string, clusterID string, timeout time.Duration, auditCtx gin.H) {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	started := time.Now()
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()

	var runErr error
	streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
		emit("start", gin.H{"args": args, "command": name, "started_at": started.UnixMilli()})
		_, runErr = d.Sw.RunShellCommandAtWithBin(ctx, master, binPath, name, args, lineSink)
		errMsg := ""
		if runErr != nil {
			errMsg = runErr.Error()
		}
		dur := time.Since(started).Milliseconds()
		emit("done", gin.H{"ok": runErr == nil, "error": errMsg, "duration_ms": dur})
	})

	errStr := ""
	if runErr != nil {
		errStr = runErr.Error()
	}
	auditCtx["args"] = args
	auditCtx["ok"] = runErr == nil
	auditCtx["error"] = errStr
	p, _ := auth.Of(c)
	_ = d.PG.Audit(c.Request.Context(), p.Email, name+".apply", "cluster", clusterID, auditCtx)
}

// ecEncode runs `ec.encode` — the mutating path. Two modes:
//
//  1. Volume IDs:  body.VolumeIDs = [7, 8]   → encodes those specific volumes
//  2. Collection:  body.Collection = "x"     → encodes every cold volume in
//                                              the collection that meets
//                                              fullPercent + quietFor + size
//
// Encoding is destructive in the sense that the source .dat is deleted after
// the 14 shards land on their target nodes. Per the runbook: source node
// alone does the RS(10+4) work (high IO), then pulls shards to peers, then
// drops the source. The HTTP request blocks until the cluster shell exits;
// callers should expect minutes-to-hours for fat volumes.
//
// POST /api/v1/clusters/:id/ec/encode
// ecEncodeBody is the POST body for ec.encode. Mirrors the full flag set
// of `weed shell ec.encode`; every field is optional and we forward each
// non-zero value as a CLI flag. Filtering by collection AND specifying a
// list of volumeIds is also supported — the shell skips volumes that
// don't satisfy fullPercent / quietFor anyway.
type ecEncodeBody struct {
	Collection            string   `json:"collection"`
	VolumeIDs             []uint32 `json:"volumeIds"`
	FullPercent           float64  `json:"fullPercent"`
	QuietFor              string   `json:"quietFor"` // duration string, e.g. "1h"
	SourceDiskType        string   `json:"sourceDiskType"`
	DiskType              string   `json:"diskType"`
	ShardReplicaPlacement string   `json:"shardReplicaPlacement"`
	MaxParallelization    int      `json:"maxParallelization"`
	Rebalance             *bool    `json:"rebalance"`
	Force                 bool     `json:"force"`
	Verbose               bool     `json:"verbose"`
}

func ecEncode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body ecEncodeBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Require at least one selector — refusing the empty body keeps us
		// from accidentally encoding everything that ever stops writing.
		if body.Collection == "" && len(body.VolumeIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "either collection or volumeIds is required",
			})
			return
		}

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// Allow generous time for large volumes — runbook says a 30GB
		// volume can take 30+ minutes. The runner has its own shellTimeout
		// (10m by default); we extend explicitly here.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()
		out, failedVols, runErr := runECEncode(ctx, d, clusterRef{master: cl.MasterAddr, binPath: cl.WeedBinPath}, body, nil)
		status := http.StatusOK
		errStr := ""
		if runErr != nil {
			status = http.StatusBadGateway
			errStr = runErr.Error()
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.encode", "cluster", id.String(), map[string]any{
			"collection":     body.Collection,
			"volume_ids":     body.VolumeIDs,
			"disk_type":      body.DiskType,
			"failed_volumes": failedVols,
			"ok":             runErr == nil,
			"error":          errStr,
		})
		resp := gin.H{"output": out}
		if errStr != "" {
			resp["error"] = errStr
		}
		if len(failedVols) > 0 {
			resp["failed_volumes"] = failedVols
		}
		c.JSON(status, resp)
	}
}

// ecDecode runs `ec.decode` — the EC→normal rollback path. The shards on
// many nodes are pulled to one node and rejoined into a `.dat/.idx`. This
// is the supported way to undo a bad EC encoding or thaw a volume for
// rewrites.
//
// POST /api/v1/clusters/:id/ec/decode
func ecDecode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Collection string   `json:"collection"`
			VolumeIDs  []uint32 `json:"volumeIds"`
			DiskType   string   `json:"diskType"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Collection == "" && len(body.VolumeIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "either collection or volumeIds is required",
			})
			return
		}

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// `ec.decode` only supports a single -volumeId or -collection. For
		// multi-volume decode we issue one shell call per volume so the
		// operator can see individual failures.
		var all strings.Builder
		var lastErr string
		var failed []uint32
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()
		if len(body.VolumeIDs) > 0 {
			for _, vid := range body.VolumeIDs {
				args := []string{"-volumeId=" + uitoa(uint64(vid))}
				if dt := strings.TrimSpace(body.DiskType); dt != "" {
					args = append(args, "-diskType="+dt)
				}
				out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.decode", args, nil)
				all.WriteString("--- volume ")
				all.WriteString(uitoa(uint64(vid)))
				all.WriteString(" ---\n")
				all.WriteString(out)
				if runErr != nil {
					failed = append(failed, vid)
					lastErr = runErr.Error()
					all.WriteString("ERROR: ")
					all.WriteString(lastErr)
					all.WriteString("\n")
				}
			}
		} else {
			args := []string{"-collection=" + body.Collection}
			if dt := strings.TrimSpace(body.DiskType); dt != "" {
				args = append(args, "-diskType="+dt)
			}
			out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.decode", args, nil)
			all.WriteString(out)
			if runErr != nil {
				lastErr = runErr.Error()
			}
		}

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.decode", "cluster", id.String(), map[string]any{
			"collection":     body.Collection,
			"volume_ids":     body.VolumeIDs,
			"disk_type":      body.DiskType,
			"failed_volumes": failed,
			"ok":             lastErr == "" && len(failed) == 0,
			"error":          lastErr,
		})
		resp := gin.H{"output": all.String()}
		if lastErr != "" {
			resp["error"] = lastErr
		}
		if len(failed) > 0 {
			resp["failed_volumes"] = failed
		}
		status := http.StatusOK
		if lastErr != "" {
			status = http.StatusBadGateway
		}
		c.JSON(status, resp)
	}
}

// buildECEncodeArgs renders the ec.encode CLI flags for ONE invocation.
// `-volumeId` is single-valued in the shell, so multi-volume callers loop
// and pass each id via `singleVolumeID`. Every other body field is
// forwarded verbatim (including in single-volume mode — even if the shell
// happens to ignore some of them, that's the shell's policy, not ours).
//
// Reference: `weed shell ec.encode -h`
//
//	-collection / -diskType / -force / -fullPercent / -maxParallelization /
//	-quietFor / -rebalance / -shardReplicaPlacement / -sourceDiskType /
//	-verbose / -volumeId
func buildECEncodeArgs(body ecEncodeBody, singleVolumeID uint32) []string {
	args := []string{}
	if singleVolumeID > 0 {
		args = append(args, "-volumeId="+uitoa(uint64(singleVolumeID)))
	}
	if c := strings.TrimSpace(body.Collection); c != "" {
		args = append(args, "-collection="+c)
	}
	if body.FullPercent > 0 {
		args = append(args, "-fullPercent="+ftoa(body.FullPercent))
	}
	if q := strings.TrimSpace(body.QuietFor); q != "" {
		args = append(args, "-quietFor="+q)
	}
	if sdt := strings.TrimSpace(body.SourceDiskType); sdt != "" {
		args = append(args, "-sourceDiskType="+sdt)
	}
	if dt := strings.TrimSpace(body.DiskType); dt != "" {
		args = append(args, "-diskType="+dt)
	}
	if rp := strings.TrimSpace(body.ShardReplicaPlacement); rp != "" {
		args = append(args, "-shardReplicaPlacement="+rp)
	}
	if body.MaxParallelization > 0 {
		args = append(args, "-maxParallelization="+uitoa(uint64(body.MaxParallelization)))
	}
	if body.Rebalance != nil && !*body.Rebalance {
		args = append(args, "-rebalance=false")
	}
	if body.Force {
		args = append(args, "-force")
	}
	if body.Verbose {
		args = append(args, "-verbose")
	}
	return args
}

// runECEncode dispatches one or more `ec.encode` shell invocations. The
// shell's -volumeId flag is single-valued, so multi-volume requests
// translate into N serial shell calls. Each call inherits the same
// placement / parallelism flags. Concatenates outputs with per-volume
// dividers so the operator can see exactly which call failed.
//
// sink is optional: nil = collect to string and return; non-nil = stream
// each subprocess stdout line as it's produced.
func runECEncode(ctx context.Context, d Deps, cl clusterRef, body ecEncodeBody, sink func(string)) (string, []uint32, error) {
	var allOut strings.Builder
	var failed []uint32

	if len(body.VolumeIDs) > 0 {
		for _, vid := range body.VolumeIDs {
			args := buildECEncodeArgs(body, vid)
			if sink != nil {
				sink("--- volume " + uitoa(uint64(vid)) + " ---")
			} else {
				allOut.WriteString("--- volume " + uitoa(uint64(vid)) + " ---\n")
			}
			out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.master, cl.binPath, "ec.encode", args, sink)
			if sink == nil {
				allOut.WriteString(out)
			}
			if runErr != nil {
				failed = append(failed, vid)
				if sink != nil {
					sink("ERROR vol " + uitoa(uint64(vid)) + ": " + runErr.Error())
				} else {
					allOut.WriteString("ERROR: " + runErr.Error() + "\n")
				}
			}
		}
		if len(failed) > 0 {
			return allOut.String(), failed,
				&encodePartialErr{count: len(failed), total: len(body.VolumeIDs)}
		}
		return allOut.String(), nil, nil
	}

	// Collection mode: one shell call.
	args := buildECEncodeArgs(body, 0)
	out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.master, cl.binPath, "ec.encode", args, sink)
	if sink == nil {
		allOut.WriteString(out)
	}
	return allOut.String(), nil, runErr
}

// clusterRef is the slim cluster locator that runECEncode needs.
type clusterRef struct {
	master  string
	binPath string
}

type encodePartialErr struct {
	count, total int
}

func (e *encodePartialErr) Error() string {
	return fmt.Sprintf("%d/%d volumes failed", e.count, e.total)
}

// ecEncodeStream is the SSE variant of ecEncode. It streams each line of
// `ec.encode` stdout as a Server-Sent Event so the dashboard can render a
// live progress panel (ETA, target node mapping, shards-per-minute).
//
// Event types:
//   - "start"      : { args: string[], started_at: int64 }
//   - "line"       : raw subprocess stdout line
//   - "done"       : { ok: bool, error?: string, duration_ms: int }
//
// Why POST + streaming response instead of GET + EventSource: EventSource
// can't carry a request body, and ec.encode parameters are big enough
// that a query string would be cramped. The client reads with `fetch` +
// ReadableStream — same UX, fewer constraints.
func ecEncodeStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body ecEncodeBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Collection == "" && len(body.VolumeIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "either collection or volumeIds is required",
			})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// SSE headers + start marker.
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		started := time.Now()
		// Preview args for the dashboard. ec.encode dispatches one
		// shell call per volume ID, so we render the flag set without
		// the per-call -volumeId — operators can still see which
		// volume each subcall targets via the streamed `--- volume N
		// ---` divider lines.
		previewArgs := buildECEncodeArgs(body, 0)
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()

		var failedVols []uint32
		var runErr error
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"started_at": started.UnixMilli(),
				"collection": body.Collection,
				"volumes":    body.VolumeIDs,
				"args":       previewArgs,
				"command":    "ec.encode",
			})
			_, failedVols, runErr = runECEncode(ctx, d, clusterRef{master: cl.MasterAddr, binPath: cl.WeedBinPath}, body, lineSink)
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
			}
			dur := time.Since(started).Milliseconds()
			emit("done", gin.H{
				"ok":             runErr == nil,
				"error":          errStr,
				"duration_ms":    dur,
				"failed_volumes": failedVols,
			})
		})
		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.encode.stream", "cluster", id.String(), map[string]any{
			"collection":     body.Collection,
			"volume_ids":     body.VolumeIDs,
			"disk_type":      body.DiskType,
			"failed_volumes": failedVols,
			"ok":             runErr == nil,
			"error":          errStr,
		})
	}
}

// ecDecodeStream is the SSE variant of ecDecode. When the caller supplies
// multiple volume IDs the lines from each per-volume shell run are
// concatenated into the same stream, prefixed by a "vol N:" marker line
// so the client can group output by volume.
func ecDecodeStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Collection string   `json:"collection"`
			VolumeIDs  []uint32 `json:"volumeIds"`
			DiskType   string   `json:"diskType"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Collection == "" && len(body.VolumeIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "either collection or volumeIds is required",
			})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// SSE headers.
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")

		started := time.Now()
		// Args preview shared across per-volume subcalls; the streamed
		// `--- volume N ---` divider lines show which one is running.
		previewArgs := []string{}
		if col := strings.TrimSpace(body.Collection); col != "" {
			previewArgs = append(previewArgs, "-collection="+col)
		}
		if dt := strings.TrimSpace(body.DiskType); dt != "" {
			previewArgs = append(previewArgs, "-diskType="+dt)
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()

		var anyErr string
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"started_at": started.UnixMilli(),
				"volumes":    body.VolumeIDs,
				"collection": body.Collection,
				"args":       previewArgs,
				"command":    "ec.decode",
			})
			if len(body.VolumeIDs) > 0 {
				for _, vid := range body.VolumeIDs {
					lineSink("--- volume " + uitoa(uint64(vid)) + " ---")
					args := []string{"-volumeId=" + uitoa(uint64(vid))}
					if dt := strings.TrimSpace(body.DiskType); dt != "" {
						args = append(args, "-diskType="+dt)
					}
					if _, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.decode", args, lineSink); runErr != nil {
						anyErr = runErr.Error()
						lineSink("ERROR vol " + uitoa(uint64(vid)) + ": " + anyErr)
					}
				}
			} else {
				args := []string{"-collection=" + body.Collection}
				if dt := strings.TrimSpace(body.DiskType); dt != "" {
					args = append(args, "-diskType="+dt)
				}
				if _, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.decode", args, lineSink); runErr != nil {
					anyErr = runErr.Error()
				}
			}
			dur := time.Since(started).Milliseconds()
			emit("done", gin.H{"ok": anyErr == "", "error": anyErr, "duration_ms": dur})
		})

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.decode.stream", "cluster", id.String(), map[string]any{
			"collection": body.Collection,
			"volume_ids": body.VolumeIDs,
			"ok":         anyErr == "",
			"error":      anyErr,
		})
	}
}


// sendSSE writes one event in the wire format
//
//	event: <name>
//	data: <json-or-text>
//	<blank>
//
// and flushes immediately so the browser receives it without buffering.
func sendSSE(c *gin.Context, event string, payload interface{}) {
	w := c.Writer
	var data string
	switch v := payload.(type) {
	case string:
		// Strings can contain newlines; SSE requires one "data:" line per
		// physical line. Splitting handles multi-line output gracefully.
		for i, ln := range strings.Split(v, "\n") {
			if i == 0 {
				data = "data: " + ln + "\n"
			} else {
				data += "data: " + ln + "\n"
			}
		}
	default:
		b, _ := json.Marshal(v)
		data = "data: " + string(b) + "\n"
	}
	_, _ = w.WriteString("event: " + event + "\n")
	_, _ = w.WriteString(data)
	_, _ = w.WriteString("\n")
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

// ───────── output parsers ─────────

// ECRebuildSummary aggregates the dry-run findings of `ec.rebuild`.
type ECRebuildSummary struct {
	Degraded      []ECDegradedVolume `json:"degraded"`
	Rebuildable   int                `json:"rebuildable"`   // volumes with >=10 shards present
	Unrecoverable int                `json:"unrecoverable"` // volumes with <10 shards
}

// ECDegradedVolume is one volume with missing shards as seen by ec.rebuild.
type ECDegradedVolume struct {
	VolumeID      uint32 `json:"volume_id"`
	Collection    string `json:"collection,omitempty"`
	MissingShards []int  `json:"missing_shards"`
	Rebuildable   bool   `json:"rebuildable"`
}

// `ec.rebuild` lines we care about (the command's exact prose varies
// across weed versions, so we match a few shapes):
//
//   "volume 7 has missing shards: [4 11]"
//   "volume 7 collection mybucket has missing shards: [4 11]"
//   "rebuilding volume 7 with shards [..] missing [4 11]"
//   "volume 7 cannot be rebuilt, only 8 shards present"
var reMissingShards = regexp.MustCompile(`volume\s+(\d+)(?:\s+collection\s+(\S+))?\s+has\s+missing\s+shards?:\s*\[([\d\s]*)\]`)
var reCannotRebuild = regexp.MustCompile(`volume\s+(\d+).*cannot\s+be\s+rebuilt`)
var reRebuilding = regexp.MustCompile(`(?:rebuilding|would\s+rebuild)\s+volume\s+(\d+)`)

func parseECRebuildOutput(out string) ECRebuildSummary {
	byID := make(map[uint32]*ECDegradedVolume)
	for _, ln := range strings.Split(out, "\n") {
		l := strings.TrimSpace(ln)
		if l == "" {
			continue
		}
		if m := reMissingShards.FindStringSubmatch(l); m != nil {
			id := parseUint32(m[1])
			d := getOrInit(byID, id)
			d.Collection = m[2]
			d.MissingShards = splitInts(m[3])
			d.Rebuildable = true
			continue
		}
		if m := reRebuilding.FindStringSubmatch(l); m != nil {
			id := parseUint32(m[1])
			d := getOrInit(byID, id)
			d.Rebuildable = true
			continue
		}
		if m := reCannotRebuild.FindStringSubmatch(l); m != nil {
			id := parseUint32(m[1])
			d := getOrInit(byID, id)
			d.Rebuildable = false
			continue
		}
	}
	sum := ECRebuildSummary{Degraded: make([]ECDegradedVolume, 0, len(byID))}
	for _, d := range byID {
		sum.Degraded = append(sum.Degraded, *d)
		if d.Rebuildable {
			sum.Rebuildable++
		} else {
			sum.Unrecoverable++
		}
	}
	return sum
}

// `ec.balance` dry-run prints one line per planned move; counting the
// "moving" or "would move" markers is good enough for a top-level KPI.
// Match either prefix; trailing context is irrelevant for the count.
var reBalanceMove = regexp.MustCompile(`(?m)^\s*(?:moving|would\s+move|move)\s+ec\s+shard`)

func countECBalanceMoves(out string) int {
	return len(reBalanceMove.FindAllString(out, -1))
}

func getOrInit(m map[uint32]*ECDegradedVolume, id uint32) *ECDegradedVolume {
	if d, ok := m[id]; ok {
		return d
	}
	d := &ECDegradedVolume{VolumeID: id}
	m[id] = d
	return d
}

func splitInts(s string) []int {
	out := []int{}
	for _, tok := range strings.Fields(s) {
		if n, err := parseInt(tok); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func parseInt(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, errBadInt
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, errBadInt
		}
		n = n*10 + int(ch-'0')
	}
	return n, nil
}

func parseUint32(s string) uint32 {
	n, _ := parseInt(s)
	return uint32(n)
}

var errBadInt = &badInt{}

type badInt struct{}

func (*badInt) Error() string { return "bad int" }
