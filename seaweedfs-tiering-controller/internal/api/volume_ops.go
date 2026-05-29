package api

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

// VolumeOps groups the higher-level volume operation endpoints used by
// the dedicated /volumes/balance, /volumes/grow, /volumes/delete-empty
// pages. Each one wraps a `weed shell` command with parsing + audit so
// the frontend can render structured UI instead of raw text output.

// ---------------- balance plan ----------------

// VolumeMove is one planned migration extracted from `volume.balance`
// dry-run output.
type VolumeMove struct {
	VolumeID   uint64 `json:"volume_id"`
	From       string `json:"from"`
	To         string `json:"to"`
	Collection string `json:"collection,omitempty"`
	SizeMB     uint64 `json:"size_mb,omitempty"`
}

// `volume.balance` (without -force) prints lines describing the moves
// it WOULD perform. The exact format varies slightly across SeaweedFS
// versions but the canonical shape is:
//
//	volume 42 from 10.0.0.5:8080 to 10.0.0.6:8080
//	plan: moving volume 42 collection logs size 1024MB from 10.0.0.5:8080 to 10.0.0.6:8080
//
// We accept either shape via a permissive regex; anything we can't
// parse is preserved in the raw output for the operator to inspect.
var balanceMoveRE = regexp.MustCompile(
	`volume\s+(\d+)` +
		`(?:\s+collection\s+(\S+))?` +
		`(?:\s+size\s+(\d+)\s*MB)?` +
		`\s+from\s+(\S+)\s+to\s+(\S+)`,
)

func parseBalancePlan(raw string) []VolumeMove {
	var moves []VolumeMove
	for _, line := range strings.Split(raw, "\n") {
		m := balanceMoveRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		vol, _ := strconv.ParseUint(m[1], 10, 64)
		size, _ := strconv.ParseUint(m[3], 10, 64)
		moves = append(moves, VolumeMove{
			VolumeID:   vol,
			Collection: m[2],
			SizeMB:     size,
			From:       m[4],
			To:         m[5],
		})
	}
	return moves
}

// volumeBalancePlan runs `volume.balance` WITHOUT -force, captures the
// dry-run plan, parses moves, and returns both the structured list and
// the raw output so the UI can still surface anything we missed.
func volumeBalancePlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		// Optional knobs forwarded to the shell command. Empty values
		// fall back to weed's own defaults.
		var body struct {
			Collection string `json:"collection,omitempty"`
			DataCenter string `json:"data_center,omitempty"`
			Rack       string `json:"rack,omitempty"`
		}
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{}
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.DataCenter != "" {
			args = append(args, "-dataCenter="+body.DataCenter)
		}
		if body.Rack != "" {
			args = append(args, "-rack="+body.Rack)
		}
		// Long-running plans can take a minute on big clusters; cap it.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.balance", args)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		moves := parseBalancePlan(out)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.balance.plan", "cluster", id.String(), map[string]any{
			"moves":      len(moves),
			"collection": body.Collection,
		})
		c.JSON(http.StatusOK, gin.H{
			"moves":  moves,
			"output": out,
		})
	}
}

// volumeBalanceBody mirrors the full `weed shell volume.balance` flag set
// (see `volume.balance -h`):
//
//	-collection  string  (default ALL_COLLECTIONS; EACH_COLLECTION supported)
//	-dataCenter  string
//	-racks       string  (comma separated)
//	-nodes       string  (comma separated)
//	-writable    bool    (only balance writable volumes)
//	-apply / -force
//	-noLock              (skip the admin shell lock — operator's risk)
type volumeBalanceBody struct {
	Collection string `json:"collection,omitempty"`
	DataCenter string `json:"dataCenter,omitempty"`
	Racks      string `json:"racks,omitempty"`
	Nodes      string `json:"nodes,omitempty"`
	Writable   bool   `json:"writable,omitempty"`
	NoLock     bool   `json:"noLock,omitempty"`
	Apply      bool   `json:"apply,omitempty"`
}

func buildVolumeBalanceArgs(b volumeBalanceBody) []string {
	args := []string{}
	if c := strings.TrimSpace(b.Collection); c != "" {
		args = append(args, "-collection="+c)
	}
	if dc := strings.TrimSpace(b.DataCenter); dc != "" {
		args = append(args, "-dataCenter="+dc)
	}
	if r := strings.TrimSpace(b.Racks); r != "" {
		args = append(args, "-racks="+r)
	}
	if n := strings.TrimSpace(b.Nodes); n != "" {
		args = append(args, "-nodes="+n)
	}
	if b.Writable {
		args = append(args, "-writable")
	}
	if b.NoLock {
		args = append(args, "-noLock")
	}
	if b.Apply {
		args = append(args, "-apply")
	}
	return args
}

// volumeBalanceStream wraps `weed shell volume.balance` in SSE. Both
// dry-run and apply share the same stream — Apply is decided by the
// `forceApply` middleware at the route. The plan summary is parsed
// from the streamed output and tucked into the final `done` event.
//
// POST /api/v1/clusters/:id/volume/balance/stream
func volumeBalanceStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body volumeBalanceBody
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildVolumeBalanceArgs(body)

		// Only the apply path mutates; gate it through the safety Guard
		// while leaving dry-run planning available during a freeze. Must
		// run before SSE headers so the 423 body is well-formed JSON.
		if body.Apply && !guardAllow(d, c, &id) {
			return
		}

		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		started := time.Now()

		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Minute)
		defer cancel()

		var runErr error
		var outBuf strings.Builder
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"args":       args,
				"command":    "volume.balance",
				"apply":      body.Apply,
				"started_at": started.UnixMilli(),
			})
			sink := func(line string) {
				outBuf.WriteString(line)
				outBuf.WriteByte('\n')
				lineSink(line)
			}
			_, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
				"volume.balance", args, sink)

			moves := parseBalancePlan(outBuf.String())
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
			}
			emit("done", gin.H{
				"ok":          runErr == nil,
				"error":       errStr,
				"duration_ms": time.Since(started).Milliseconds(),
				"moves":       moves,
				"move_count":  len(moves),
			})
		})

		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}
		op := "volume.balance.plan"
		if body.Apply {
			op = "volume.balance.apply"
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, op, "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"data_center": body.DataCenter,
			"racks":       body.Racks,
			"nodes":       body.Nodes,
			"writable":    body.Writable,
			"no_lock":     body.NoLock,
			"apply":       body.Apply,
			"ok":          runErr == nil,
			"error":       errStr,
		})
	}
}

// ---------------- grow ----------------

// volumeGrow runs `volume.grow` with structured params. The master
// decides actual placement; we return whatever weed printed so the UI
// can show the new volume IDs.
func volumeGrow(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		if !guardAllow(d, c, &id) {
			return
		}
		var body struct {
			Collection  string `json:"collection"`
			Replication string `json:"replication,omitempty"`
			DataCenter  string `json:"data_center,omitempty"`
			Rack        string `json:"rack,omitempty"`
			Count       int    `json:"count"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Count <= 0 || body.Count > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "count must be 1..100"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var args []string
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.Replication != "" {
			args = append(args, "-replication="+body.Replication)
		}
		if body.DataCenter != "" {
			args = append(args, "-dataCenter="+body.DataCenter)
		}
		if body.Rack != "" {
			args = append(args, "-rack="+body.Rack)
		}
		args = append(args, "-count="+strconv.Itoa(body.Count))

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.grow", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.grow", "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"replication": body.Replication,
			"count":       body.Count,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "args": strings.Join(args, " ")})
	}
}

// volumeGrowStream is the SSE variant. weed shell `volume.grow` itself
// prints very little — it only fires a gRPC VolumeGrowRequest at the
// master and returns. The master then asynchronously assigns new
// volumes on volume servers and waits for heartbeats to surface them
// in its topology. That gap is exactly why the previous blocking JSON
// route reported "Allocated 0 volumes" — we re-fetched too soon.
//
// The streaming flow:
//  1. start  : echo the constructed `weed shell -- volume.grow ...`
//  2. line   : surface every line the shell prints (rare but possible:
//     error messages, "collection not found", etc.)
//  3. progress: after the shell exits, poll the master's volume list
//     every ~500ms and emit a `progress` event with the new
//     counts. Stop when we observe count >= target or after
//     ~20s — newer than the typical heartbeat interval.
//  4. done   : final added count + before/after snapshot.
//
// POST /api/v1/clusters/:id/volume/grow/stream
func volumeGrowStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		if !guardAllow(d, c, &id) {
			return
		}
		var body struct {
			Collection  string `json:"collection"`
			Replication string `json:"replication,omitempty"`
			DataCenter  string `json:"data_center,omitempty"`
			Rack        string `json:"rack,omitempty"`
			Count       int    `json:"count"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Count <= 0 || body.Count > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "count must be 1..100"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var args []string
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.Replication != "" {
			args = append(args, "-replication="+body.Replication)
		}
		if body.DataCenter != "" {
			args = append(args, "-dataCenter="+body.DataCenter)
		}
		if body.Rack != "" {
			args = append(args, "-rack="+body.Rack)
		}
		args = append(args, "-count="+strconv.Itoa(body.Count))

		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")

		started := time.Now()
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		// BEFORE snapshot: count volumes for the target collection so
		// we can detect arrival with a single integer comparison.
		// (Per-node diff lives on the client, computed from the same
		// list endpoint after our `done` event.)
		beforeCount := -1
		if vols, err := d.Sw.ListVolumesAt(ctx, cl.MasterAddr); err == nil {
			beforeCount = countCollection(vols, body.Collection)
		}

		var runErr error
		var shellOut strings.Builder
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"args":       args,
				"command":    "volume.grow",
				"started_at": started.UnixMilli(),
				"before":     beforeCount,
				"target":     beforeCount + body.Count,
			})

			// volume.grow itself is fast (a master gRPC). Run with a
			// short timeout and stream whatever it prints; on error
			// the shell wrapper surfaces stderr via the returned err.
			shellCtx, shellCancel := context.WithTimeout(ctx, 30*time.Second)
			defer shellCancel()
			out, e := d.Sw.RunShellCommandAtWithBin(shellCtx, cl.MasterAddr, cl.WeedBinPath,
				"volume.grow", args, func(line string) {
					shellOut.WriteString(line)
					shellOut.WriteByte('\n')
					lineSink(line)
				})
			runErr = e
			if runErr != nil {
				// Surface stderr-style errors as a final line so
				// they show up in the tail even when the wrapper
				// returns early.
				lineSink("ERROR: " + runErr.Error())
				if out != "" && !strings.Contains(shellOut.String(), out) {
					lineSink(out)
				}
				emit("done", gin.H{
					"ok":          false,
					"error":       runErr.Error(),
					"added":       0,
					"duration_ms": time.Since(started).Milliseconds(),
				})
				return
			}

			lineSink("master accepted volume.grow — waiting for assignment to propagate…")

			// Poll the master's volume list until we observe >= target
			// or a 20s budget elapses. Master heartbeats are typically
			// 5s so 20s is comfortable.
			target := beforeCount + body.Count
			deadline := time.Now().Add(20 * time.Second)
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()
			lastCount := beforeCount
			finalCount := beforeCount
			for time.Now().Before(deadline) {
				select {
				case <-ctx.Done():
					goto pollDone
				case <-ticker.C:
				}
				pollCtx, pollCancel := context.WithTimeout(ctx, 3*time.Second)
				vols, e := d.Sw.ListVolumesAt(pollCtx, cl.MasterAddr)
				pollCancel()
				if e != nil {
					continue
				}
				cur := countCollection(vols, body.Collection)
				finalCount = cur
				if cur != lastCount {
					emit("progress", gin.H{
						"before":  beforeCount,
						"current": cur,
						"target":  target,
						"added":   cur - beforeCount,
					})
					lastCount = cur
				}
				if cur >= target {
					break
				}
			}
		pollDone:
			added := finalCount - beforeCount
			if added < 0 {
				added = 0
			}
			emit("done", gin.H{
				"ok":          true,
				"before":      beforeCount,
				"after":       finalCount,
				"added":       added,
				"target":      beforeCount + body.Count,
				"duration_ms": time.Since(started).Milliseconds(),
			})
		})

		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.grow.stream", "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"replication": body.Replication,
			"count":       body.Count,
			"ok":          runErr == nil,
			"error":       errStr,
		})
	}
}

// countCollection returns the number of volume rows whose Collection
// matches `name`. Empty `name` counts every volume (matches when the
// operator left the form's collection field blank, which is invalid
// for grow anyway but lets the helper stay generic).
func countCollection(vols []seaweed.VolumeInfo, name string) int {
	n := 0
	for _, v := range vols {
		if name == "" || v.Collection == name {
			n++
		}
	}
	return n
}

// ---------------- delete-empty ----------------

// volumeDeleteEmpty deletes one specific empty volume replica via
// `volume.delete`. The frontend computes the candidate list from the
// existing /volumes endpoint (Size==0) and calls this per row so each
// deletion is independently auditable.
func volumeDeleteEmpty(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		if !guardAllow(d, c, &id) {
			return
		}
		var body struct {
			VolumeID uint64 `json:"volume_id"`
			Node     string `json:"node"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.VolumeID == 0 || body.Node == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "volume_id + node required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{
			"-volumeId=" + strconv.FormatUint(body.VolumeID, 10),
			"-node=" + body.Node,
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.delete", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.delete-empty", "volume",
			fmt.Sprintf("%d@%s", body.VolumeID, body.Node), map[string]any{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out})
	}
}
