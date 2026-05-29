package api

// Persistent drain jobs for volumeServer.leave.
//
// Design — the synchronous /clusters/:id/volume-server/leave/stream
// endpoint is kept as-is for ad-hoc one-shot drains. This file adds a
// durable variant where the operator records a job, walks away, and
// comes back to a status that survives page reloads (and orchestrator
// restarts as a `failed` row so they can retry).
//
// Lifecycle is owned by drainRunner. SSE consumers subscribe to a
// per-job in-memory broadcaster; the runner pushes log lines and
// progress events as they happen, and the DB row carries the durable
// state for everyone who isn't currently subscribed.

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// drainEvent is one SSE-shaped tuple. `kind` aligns with the SSE event
// name the UI listens to: line / progress / status / done.
type drainEvent struct {
	Kind    string      `json:"kind"`
	Payload interface{} `json:"payload"`
}

// drainHub fans out events from the runner to any number of live SSE
// consumers. Subscribers buffer 64 events; if a slow client falls
// behind we drop events for that subscriber only — we never block the
// runner. The DB row remains the source of truth so a dropped event
// just means a reconnect re-reads the persisted state.
type drainHub struct {
	mu     sync.Mutex
	subs   map[uuid.UUID]map[int]chan drainEvent
	nextID int
}

func newDrainHub() *drainHub {
	return &drainHub{subs: map[uuid.UUID]map[int]chan drainEvent{}}
}

func (h *drainHub) subscribe(id uuid.UUID) (int, chan drainEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch := make(chan drainEvent, 64)
	sid := h.nextID
	h.nextID++
	if h.subs[id] == nil {
		h.subs[id] = map[int]chan drainEvent{}
	}
	h.subs[id][sid] = ch
	return sid, ch
}

func (h *drainHub) unsubscribe(id uuid.UUID, sid int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m, ok := h.subs[id]; ok {
		if ch, ok := m[sid]; ok {
			close(ch)
			delete(m, sid)
		}
		if len(m) == 0 {
			delete(h.subs, id)
		}
	}
}

func (h *drainHub) publish(id uuid.UUID, evt drainEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs[id] {
		select {
		case ch <- evt:
		default:
			// drop — slow consumer; the persisted log will fill the gap
		}
	}
}

// drainController is the long-lived component wiring the hub + cancel
// signals together. Held by Deps.Drains so handlers can talk to it.
type drainController struct {
	hub     *drainHub
	mu      sync.Mutex
	cancels map[uuid.UUID]context.CancelFunc
}

// NewDrainController returns a controller and runs a one-shot startup
// cleanup so stale running/verifying rows from a previous process
// don't appear active forever.
func NewDrainController(ctx context.Context, pg *store.PG) (*drainController, error) {
	if n, err := pg.ResetStaleDrains(ctx); err != nil {
		return nil, err
	} else if n > 0 {
		// Best-effort signal: log via stderr-style audit. Not fatal.
		_ = n
	}
	return &drainController{
		hub:     newDrainHub(),
		cancels: map[uuid.UUID]context.CancelFunc{},
	}, nil
}

func (c *drainController) registerCancel(id uuid.UUID, cancel context.CancelFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancels[id] = cancel
}

func (c *drainController) cancel(id uuid.UUID) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cn, ok := c.cancels[id]; ok {
		cn()
		delete(c.cancels, id)
		return true
	}
	return false
}

func (c *drainController) clearCancel(id uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.cancels, id)
}

// ---------------- handlers ----------------

// listDrains returns recent drain rows. Optional filters: cluster_id,
// status (comma-separated).
func listDrains(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var cid *uuid.UUID
		if s := c.Query("cluster_id"); s != "" {
			id, err := uuid.Parse(s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
				return
			}
			cid = &id
		}
		var statuses []string
		if s := c.Query("status"); s != "" {
			for _, p := range strings.Split(s, ",") {
				if p = strings.TrimSpace(p); p != "" {
					statuses = append(statuses, p)
				}
			}
		}
		limit := 100
		if s := c.Query("limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 500 {
				limit = n
			}
		}
		rows, err := d.PG.ListDrains(c.Request.Context(), cid, statuses, limit)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

func getDrain(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		row, err := d.PG.GetDrain(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, row)
	}
}

// createDrain inserts the row, snapshots the initial volume count,
// then spawns the runner in the background. Returns the id immediately
// so the UI can navigate to the detail/stream page.
func createDrain(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Node   string `json:"node"`
			Force  bool   `json:"force,omitempty"`
			Reason string `json:"reason,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Node) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "node host:port required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		// Draining a server mutates placement (moves every volume off the
		// node); gate it through the safety Guard before queueing the job.
		if !guardAllow(d, c, &id) {
			return
		}

		// Snapshot the current footprint so the dashboard can show
		// "% drained" as the count walks down. Best-effort: if the
		// topology call fails we still create the job, the runner
		// will retry the count.
		initVols, initBytes := countVolumesOnNode(c.Request.Context(), d, cl, body.Node)

		p, _ := auth.Of(c)
		drain := store.VolumeServerDrain{
			ClusterID:      id,
			Node:           strings.TrimSpace(body.Node),
			Status:         "pending",
			Force:          body.Force,
			Reason:         strings.TrimSpace(body.Reason),
			RequestedBy:    p.Email,
			InitialVolumes: initVols,
			InitialBytes:   initBytes,
		}
		drainID, err := d.PG.CreateDrain(c.Request.Context(), drain)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), p.Email, "drain.create", "cluster", id.String(), map[string]any{
			"drain_id": drainID.String(),
			"node":     drain.Node,
			"force":    drain.Force,
			"reason":   drain.Reason,
		})

		// Detach from the request context — the drain can outlive the
		// HTTP roundtrip by hours. Bound at 2h max.
		bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		d.Drains.registerCancel(drainID, cancel)
		go runDrain(bgCtx, d, cl, drainID, drain)

		c.JSON(http.StatusAccepted, gin.H{"id": drainID})
	}
}

func cancelDrain(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		row, err := d.PG.GetDrain(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if row.Status == "done" || row.Status == "failed" || row.Status == "cancelled" {
			c.JSON(http.StatusOK, gin.H{"ok": true, "noop": true})
			return
		}
		// Cancel the runner's context (interrupts the shell). The
		// runner finishes the lifecycle by writing cancelled status.
		if !d.Drains.cancel(id) {
			// No in-memory cancel registered (orchestrator may have
			// restarted). Mark the row directly.
			_ = d.PG.UpdateDrainStatus(c.Request.Context(), id, "cancelled",
				"\n[cancelled by operator]\n", "cancelled by operator",
				false, true)
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "drain.cancel", "drain", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// streamDrain emits the persisted log first, then live events, until
// the runner publishes a `done` event or the client disconnects.
func streamDrain(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		row, err := d.PG.GetDrain(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")

		// Replay snapshot.
		sendSSE(c, "snapshot", row)

		// If the job is already terminal, send done immediately so the
		// UI doesn't sit waiting for a finalisation event.
		if row.Status == "done" || row.Status == "failed" || row.Status == "cancelled" {
			sendSSE(c, "done", gin.H{
				"status": row.Status,
				"error":  row.Error,
			})
			return
		}

		// Subscribe to live events.
		sid, ch := d.Drains.hub.subscribe(id)
		defer d.Drains.hub.unsubscribe(id, sid)

		ctx := c.Request.Context()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case evt, ok := <-ch:
				if !ok {
					return
				}
				sendSSE(c, evt.Kind, evt.Payload)
				if evt.Kind == "done" {
					return
				}
			case <-ticker.C:
				// Heartbeat so proxies don't kill an idle stream.
				sendSSE(c, "ping", gin.H{"t": time.Now().UnixMilli()})
			}
		}
	}
}

// ---------------- runner ----------------

// runDrain owns the lifecycle of a single drain job. Safe to call from
// a goroutine. It updates DB state, broadcasts events to subscribers,
// and always finalises with a terminal status + done event.
func runDrain(ctx context.Context, d Deps, cl *store.Cluster, id uuid.UUID, drain store.VolumeServerDrain) {
	defer d.Drains.clearCancel(id)

	pub := func(kind string, payload interface{}) {
		d.Drains.hub.publish(id, drainEvent{Kind: kind, Payload: payload})
	}

	// --- Phase 1: shell ---
	args := []string{"-node=" + drain.Node}
	if drain.Force {
		args = append(args, "-force")
	}
	startMsg := fmt.Sprintf("[%s] starting volumeServer.leave %s\n",
		time.Now().Format(time.RFC3339), strings.Join(args, " "))
	_ = d.PG.UpdateDrainStatus(ctx, id, "running", startMsg, "-", true, false)
	pub("status", gin.H{"status": "running"})
	pub("line", strings.TrimRight(startMsg, "\n"))

	// Buffer lines so we batch-write to DB (one row update per ~1s of
	// output instead of one per line). The hub still gets every line
	// live so the UI feels real-time.
	var bufMu sync.Mutex
	var buf strings.Builder
	flushTick := time.NewTicker(1 * time.Second)
	defer flushTick.Stop()
	flushDone := make(chan struct{})
	go func() {
		for {
			select {
			case <-flushDone:
				return
			case <-flushTick.C:
				bufMu.Lock()
				if buf.Len() > 0 {
					chunk := buf.String()
					buf.Reset()
					bufMu.Unlock()
					_ = d.PG.UpdateDrainStatus(ctx, id, "running", chunk, "", false, false)
				} else {
					bufMu.Unlock()
				}
			}
		}
	}()

	lineSink := func(line string) {
		bufMu.Lock()
		buf.WriteString(line)
		buf.WriteByte('\n')
		bufMu.Unlock()
		pub("line", line)
	}
	_, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
		"volumeServer.leave", args, lineSink)
	close(flushDone)
	// Final flush of any remaining buffered bytes before we move on.
	bufMu.Lock()
	if buf.Len() > 0 {
		_ = d.PG.UpdateDrainStatus(ctx, id, "running", buf.String(), "", false, false)
		buf.Reset()
	}
	bufMu.Unlock()

	if runErr != nil {
		errStr := runErr.Error()
		// Distinguish operator cancel from any other shell failure so
		// the UI can show a useful message.
		status := "failed"
		if ctx.Err() != nil {
			status = "cancelled"
		}
		_ = d.PG.UpdateDrainStatus(ctx, id, status,
			fmt.Sprintf("\n[%s] shell failed: %s\n", time.Now().Format(time.RFC3339), errStr),
			errStr, false, true)
		pub("done", gin.H{"status": status, "error": errStr})
		return
	}

	// --- Phase 2: verification ---
	_ = d.PG.UpdateDrainStatus(ctx, id, "verifying",
		fmt.Sprintf("\n[%s] shell finished; verifying node is empty\n", time.Now().Format(time.RFC3339)),
		"", false, false)
	pub("status", gin.H{"status": "verifying"})

	verifyDeadline := time.Now().Add(5 * time.Minute)
	emptyStreak := 0
	const requiredEmptyPolls = 2 // 2 consecutive zero counts to confirm
	pollInterval := 5 * time.Second
	for {
		if ctx.Err() != nil {
			_ = d.PG.UpdateDrainStatus(ctx, id, "cancelled",
				fmt.Sprintf("\n[%s] verification cancelled\n", time.Now().Format(time.RFC3339)),
				"cancelled by operator", false, true)
			pub("done", gin.H{"status": "cancelled"})
			return
		}
		vols, bytes := countVolumesOnNode(ctx, d, cl, drain.Node)
		_ = d.PG.UpdateDrainProgress(ctx, id, vols, bytes)
		pub("progress", gin.H{"volumes": vols, "bytes": bytes})
		if vols == 0 {
			emptyStreak++
			if emptyStreak >= requiredEmptyPolls {
				_ = d.PG.UpdateDrainStatus(ctx, id, "done",
					fmt.Sprintf("\n[%s] verified: node is empty\n", time.Now().Format(time.RFC3339)),
					"-", false, true)
				pub("done", gin.H{"status": "done"})
				return
			}
		} else {
			emptyStreak = 0
		}
		if time.Now().After(verifyDeadline) {
			msg := fmt.Sprintf("verification timed out with %d volume(s) still on node", vols)
			_ = d.PG.UpdateDrainStatus(ctx, id, "failed",
				fmt.Sprintf("\n[%s] %s\n", time.Now().Format(time.RFC3339), msg),
				msg, false, true)
			pub("done", gin.H{"status": "failed", "error": msg})
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(pollInterval):
		}
	}
}

// countVolumesOnNode returns (volumes, total_bytes) for a single
// server in the cluster topology. EC shard bags count as one row each
// the same way the dashboard does.
func countVolumesOnNode(ctx context.Context, d Deps, cl *store.Cluster, node string) (int, int64) {
	vols, err := d.Sw.ListVolumesAt(ctx, cl.MasterAddr)
	if err != nil {
		return -1, -1
	}
	n := 0
	var total int64
	for _, v := range vols {
		if v.Server == node {
			n++
			total += int64(v.Size)
		}
	}
	return n, total
}
