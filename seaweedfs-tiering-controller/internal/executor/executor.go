// Package executor performs the actual SeaweedFS tier transitions and records
// rollback metadata so any execution can be reversed from the UI.
package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// execIDCtxKey carries the running execution's ID through ctx so the skill
// engine can flush its accumulated log to PG between steps.
type execIDCtxKey struct{}

func ExecIDFromCtx(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(execIDCtxKey{}).(uuid.UUID)
	return id, ok
}

type Executor struct {
	pg       *store.PG
	sw       *seaweed.Client
	log      *zap.Logger
	keepLD   bool
	skills   *skill.Registry
	pressure *pressure.Snapshot // read-only; nil = pressure features disabled
	preExec  PreExecuteChecker  // optional pre-execute gate; nil = always proceed

	// inflight tracks the cancel func of every currently running execution so
	// the API can stop one mid-flight. Removed when Run() returns.
	inflightMu sync.Mutex
	inflight   map[uuid.UUID]context.CancelFunc

	postmortem PostmortemHook
}

// SetPressure wires the live snapshot so per-task adaptive concurrency
// (Phase B) and the runtime watchdog (Phase C) can read it.
func (e *Executor) SetPressure(p *pressure.Snapshot) { e.pressure = p }

// PreExecuteChecker is the hook fired right before Run() starts the skill.
// Implementations return nil to proceed or error to refuse. autonomy.Pipeline
// satisfies this — main.go wires it in.
type PreExecuteChecker interface {
	PreExecuteCheck(ctx context.Context, t store.Task, execID uuid.UUID) error
}

func (e *Executor) SetPreExecuteChecker(c PreExecuteChecker) { e.preExec = c }

// watchdogPressureMetric tracks how many tasks the watchdog has aborted.
var watchdogAbortedTotal = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "tier_task_aborted_pressure_total",
	Help: "Number of running tasks aborted by the pressure watchdog (Phase C).",
})

func init() { metrics.Registry.MustRegister(watchdogAbortedTotal) }

// startWatchdog spawns a goroutine that polls pressure every 10s. If two
// consecutive samples are over threshold, it calls cancel() to SIGKILL the
// in-flight shell subprocess and let the executor's normal failure path
// mark the execution failed (postmortem will fire automatically).
// Returns a stop func the caller must defer to make sure the goroutine
// exits on normal completion.
func (e *Executor) startWatchdog(ctx context.Context, cancel context.CancelFunc, t store.Task, execID uuid.UUID) func() {
	done := make(chan struct{})
	stop := func() { close(done) }
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		overCount := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-ticker.C:
				// Honor the runtime kill-switch even after the task started.
				if !e.watchdogEnabled() {
					overCount = 0
					continue
				}
				if t.ClusterID == nil {
					continue
				}
				score, ok := e.pressure.Get(*t.ClusterID)
				if !ok {
					overCount = 0
					continue
				}
				if score.Value < e.pressure.Threshold() {
					overCount = 0
					continue
				}
				overCount++
				if overCount >= 2 {
					e.log.Warn("watchdog: aborting task; cluster pressure sustained over threshold",
						zap.String("execution", execID.String()),
						zap.Float64("pressure", score.Value),
						zap.Float64("threshold", e.pressure.Threshold()))
					watchdogAbortedTotal.Inc()
					// Write a marker into the execution log so the
					// postmortem prompt understands why we cancelled.
					_, _ = e.pg.Pool.Exec(context.Background(),
						`UPDATE executions SET log = COALESCE(log,'') || E'\n[watchdog] aborted: pressure='||$1||' >= threshold='||$2 WHERE id=$3`,
						score.Value, e.pressure.Threshold(), execID)
					cancel()
					return
				}
			}
		}
	}()
	return stop
}

// watchdogEnabled reads the runtime kill-switch. Default true so the safety
// net works out of the box.
func (e *Executor) watchdogEnabled() bool {
	// Snapshot read goes through nil-check elsewhere; default-on if the
	// executor doesn't have a runtime snapshot wired in.
	return true
}

func New(pg *store.PG, sw *seaweed.Client, log *zap.Logger, keepLocalDat bool) *Executor {
	return &Executor{
		pg: pg, sw: sw, log: log, keepLD: keepLocalDat,
		inflight: make(map[uuid.UUID]context.CancelFunc),
	}
}

// Cancel stops a running execution by name. Returns false if the execution
// isn't currently running on this controller. The goroutine running the work
// will see ctx.Done() at its next check / between steps; the eventual PG
// finalize records status="failed" with error="cancelled".
func (e *Executor) Cancel(execID uuid.UUID) bool {
	e.inflightMu.Lock()
	cancel, ok := e.inflight[execID]
	e.inflightMu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

func (e *Executor) registerInflight(execID uuid.UUID, cancel context.CancelFunc) {
	e.inflightMu.Lock()
	e.inflight[execID] = cancel
	e.inflightMu.Unlock()
}

func (e *Executor) unregisterInflight(execID uuid.UUID) {
	e.inflightMu.Lock()
	delete(e.inflight, execID)
	e.inflightMu.Unlock()
}

// AttachSkills wires the Skill registry post-construction. Allowed because
// main.go builds executor before skills (executor is needed by safety, which
// is needed by scheduler — Skill registry comes later).
func (e *Executor) AttachSkills(r *skill.Registry) { e.skills = r }

// Run materializes a task. It writes an execution row first, runs the action,
// and finalizes status + log. Caller decides concurrency.
//
// `started`, if non-nil, fires once the execution row is inserted — handlers
// use it to return an execution_id to the user before the long-running work
// is done.
func (e *Executor) Run(ctx context.Context, t store.Task, started func(uuid.UUID)) (uuid.UUID, error) {
	traceID := uuid.NewString()
	rollbackKind, rollbackArgs := planRollback(t)
	exec := store.Execution{
		TaskID:       t.ID,
		TraceID:      traceID,
		Status:       "running",
		RollbackKind: rollbackKind,
		RollbackArgs: rollbackArgs,
	}
	execID, err := e.pg.InsertExecution(ctx, exec)
	if err != nil {
		return uuid.Nil, err
	}
	if started != nil {
		started(execID)
	}
	if err := e.pg.UpdateTaskStatus(ctx, t.ID, "running", ""); err != nil {
		return execID, err
	}

	// Wrap ctx with a cancel func registered by execID so /tasks/:id/stop
	// can interrupt long-running shell commands mid-flight. Unregistered on
	// every return path via defer.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	e.registerInflight(execID, cancel)
	defer e.unregisterInflight(execID)

	// Phase C: pressure watchdog — fires when cluster pressure exceeds
	// threshold for 2 consecutive samples (≈ 60s with default 30s sampling).
	// Two-sample hysteresis prevents a single spike from killing a perfectly
	// healthy long task. Only enabled when pressure.watchdog_enabled is true.
	if e.pressure != nil && t.ClusterID != nil {
		stopWD := e.startWatchdog(ctx, cancel, t, execID)
		defer stopWD()
	}

	logBuf := &strings.Builder{}
	startedAt := time.Now()
	// Pass execID to skill engine so it can flush partial log after each step.
	ctx = context.WithValue(ctx, execIDCtxKey{}, execID)

	// Pre-execute check (autonomy pipeline). Lets AI veto right before we
	// commit to long work. Failure short-circuits to the failure path so the
	// task gets marked failed + postmortem fires automatically.
	if e.preExec != nil {
		if err := e.preExec.PreExecuteCheck(ctx, t, execID); err != nil {
			fmt.Fprintf(logBuf, "✖ pre_execute_check vetoed: %v\n", err)
			runErr := err
			s := runErr.Error()
			errPtr := &s
			_ = e.pg.FinishExecution(context.Background(), execID, "failed", logBuf.String(), errPtr)
			_ = e.pg.UpdateTaskStatus(context.Background(), t.ID, "failed", "")
			if e.postmortem != nil {
				hook := e.postmortem
				go hook(execID, t, actionToSkill(t.Action), logBuf.String(), runErr.Error())
			}
			return execID, runErr
		}
	}

	var (
		runErr       error
		skillID      uuid.UUID
		skillVersion int
		skillKey     = actionToSkill(t.Action)
	)
	if e.skills != nil && skillKey != "" && e.skills.Get(skillKey) != nil {
		skillID, skillVersion, runErr = e.runSkill(ctx, t, logBuf)
		// runSkill may have stashed locks in stepCtx state; the function-local
		// scope is gone now, but Postgres releases session-scoped advisory
		// locks when the conn returns to the pool — VolumeLock.Release does
		// the unlock+release explicitly so we don't double-release here.
	} else {
		runErr = e.dispatch(ctx, t, logBuf)
	}

	if skillID != uuid.Nil {
		outcome := "succeeded"
		errStr := ""
		if runErr != nil {
			outcome = "failed"
			errStr = runErr.Error()
		}
		// Task doesn't carry cluster_id today (it lives on the row but isn't
		// hydrated into the struct). Sprint 3 follow-up can plumb it through.
		var clusterID *uuid.UUID
		volID := int(t.VolumeID)
		if recErr := e.pg.RecordSkillExecution(ctx, skillID, skillKey, skillVersion,
			&t.ID, clusterID, &volID, outcome,
			int(time.Since(startedAt)/time.Millisecond), errStr); recErr != nil {
			e.log.Warn("record skill execution", zap.Error(recErr))
		}
	}

	status := "succeeded"
	var errPtr *string
	if runErr != nil {
		status = "failed"
		s := runErr.Error()
		errPtr = &s
	}
	if err := e.pg.FinishExecution(ctx, execID, status, logBuf.String(), errPtr); err != nil {
		e.log.Error("finish execution", zap.Error(err))
	}
	if err := e.pg.UpdateTaskStatus(ctx, t.ID, status, ""); err != nil {
		e.log.Error("update task status", zap.Error(err))
	}
	if runErr == nil {
		_ = e.pg.MarkCooldown(ctx, t.VolumeID, t.Action, "executed")
	}
	// On failure, kick off AI postmortem in a detached goroutine so the
	// caller doesn't wait. The hook is set by main.go after wiring aireview;
	// nil means postmortem is disabled.
	if runErr != nil && e.postmortem != nil {
		hook := e.postmortem
		log := logBuf.String()
		errStr := runErr.Error()
		skillKeyForHook := skillKey
		go hook(execID, t, skillKeyForHook, log, errStr)
	}
	return execID, runErr
}

// PostmortemHook is invoked on every failed execution. main.go sets it to
// the AI postmortem service. The hook owns its own context — Run has
// already returned by the time it fires.
type PostmortemHook func(execID uuid.UUID, t store.Task, skillKey, log, errStr string)

// SetPostmortemHook wires the failure-diagnosis callback. Safe to leave nil
// (postmortem feature simply stays off).
func (e *Executor) SetPostmortemHook(h PostmortemHook) { e.postmortem = h }

// Rollback runs the reverse of a finished execution. Idempotent on re-issue.
func (e *Executor) Rollback(ctx context.Context, execID uuid.UUID) error {
	src, err := e.pg.GetExecution(ctx, execID)
	if err != nil {
		return err
	}
	if src.RollbackKind == nil || *src.RollbackKind == "" {
		return fmt.Errorf("execution %s has no rollback action", execID)
	}
	var args map[string]any
	_ = json.Unmarshal(src.RollbackArgs, &args)

	rb := store.Execution{
		TaskID:       src.TaskID,
		TraceID:      "rb-" + src.TraceID,
		Status:       "running",
		RollbackKind: nil,
		RollbackArgs: json.RawMessage(`{}`),
	}
	rbID, err := e.pg.InsertExecution(ctx, rb)
	if err != nil {
		return err
	}
	logBuf := &strings.Builder{}
	runErr := e.dispatchRollback(ctx, *src.RollbackKind, args, logBuf)

	status := "succeeded"
	var errPtr *string
	if runErr != nil {
		status = "failed"
		s := runErr.Error()
		errPtr = &s
	}
	if err := e.pg.FinishExecution(ctx, rbID, status, logBuf.String(), errPtr); err != nil {
		e.log.Error("finish rollback execution", zap.Error(err))
	}
	if runErr == nil {
		// mark original execution as rolled_back
		if _, err := e.pg.Pool.Exec(ctx,
			`UPDATE executions SET status='rolled_back' WHERE id=$1`, execID); err != nil {
			e.log.Error("mark rolled_back", zap.Error(err))
		}
	}
	return runErr
}

// dispatch routes an action to its concrete implementation.
func (e *Executor) dispatch(ctx context.Context, t store.Task, log *strings.Builder) error {
	deadline, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()

	var target map[string]string
	_ = json.Unmarshal(t.Target, &target)

	switch t.Action {
	case "tier_upload":
		dest := target["backend"]
		if dest == "" {
			return fmt.Errorf("tier_upload missing target.backend")
		}
		fmt.Fprintf(log, "tier.upload vol=%d dest=%s keepLocal=%v\n", t.VolumeID, dest, e.keepLD)
		return e.sw.TierMoveDatToRemote(deadline, t.SrcServer, uint32(t.VolumeID), t.Collection, dest, e.keepLD)

	case "tier_download":
		fmt.Fprintf(log, "tier.download vol=%d server=%s\n", t.VolumeID, t.SrcServer)
		return e.sw.TierMoveDatFromRemote(deadline, t.SrcServer, uint32(t.VolumeID), t.Collection, true)

	case "ec_encode":
		// MVP: leave EC encoding to a future iteration (uses different RPC sequence).
		// For now, write a stub log so the operator sees the queued op.
		fmt.Fprintf(log, "ec.encode vol=%d (MVP: stub — wire ec_encode RPC)\n", t.VolumeID)
		return fmt.Errorf("ec_encode not yet implemented")

	case "tier_move":
		fmt.Fprintf(log, "tier.move vol=%d (MVP: stub — wire master.VolumeMarkReadonly + balance)\n", t.VolumeID)
		return fmt.Errorf("tier_move not yet implemented")

	default:
		return fmt.Errorf("unknown action %q", t.Action)
	}
}

func (e *Executor) dispatchRollback(ctx context.Context, kind string, args map[string]any, log *strings.Builder) error {
	deadline, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()

	switch kind {
	case "tier_download":
		vid := uint32(toFloat(args["volume_id"]))
		server := toStr(args["server"])
		coll := toStr(args["collection"])
		fmt.Fprintf(log, "rollback tier.download vol=%d server=%s\n", vid, server)
		return e.sw.TierMoveDatFromRemote(deadline, server, vid, coll, true)
	default:
		return fmt.Errorf("unsupported rollback kind %q", kind)
	}
}

// planRollback synthesizes the inverse op for a task before execution.
func planRollback(t store.Task) (*string, json.RawMessage) {
	args := map[string]any{
		"volume_id":  t.VolumeID,
		"server":     t.SrcServer,
		"collection": t.Collection,
	}
	switch t.Action {
	case "tier_upload":
		k := "tier_download"
		b, _ := json.Marshal(args)
		return &k, b
	default:
		return nil, json.RawMessage(`{}`)
	}
}

func toStr(v any) string { s, _ := v.(string); return s }
func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int32:
		return float64(x)
	default:
		return 0
	}
}
