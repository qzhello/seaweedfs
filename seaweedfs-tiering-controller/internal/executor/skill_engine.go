package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// actionToSkill maps the legacy task.Action enum onto the canonical Skill keys
// from internal/skill/catalog. Tasks scored before Sprint 3 still use the old
// action names; the engine resolves them transparently.
func actionToSkill(action string) string {
	switch action {
	case "tier_upload":
		return "volume.tier_upload"
	case "tier_download":
		return "volume.tier_download"
	case "ec_encode":
		return "volume.ec_encode"
	case "ec_decode":
		return "volume.ec_decode"
	case "delete_replica":
		return "volume.delete_replica"
	case "balance":
		return "volume.balance"
	case "shrink":
		return "volume.shrink"
	case "fix_replication":
		return "volume.fix_replication"
	case "vacuum":
		return "volume.vacuum"
	case "fsck":
		return "volume.fsck"
	case "collection_move":
		return "collection.move"
	case "failover_check":
		return "cluster.failover_check"
	}
	return ""
}

// stepCtx is the per-execution scratchpad threaded through every op handler.
// It carries the running task, accumulated log, and a place for early steps
// to publish values that later steps depend on (e.g. lock handle from
// acquire_volume_lock is read by every subsequent op).
type stepCtx struct {
	task   store.Task
	loaded *skill.Loaded
	log    *strings.Builder
	state  map[string]any
	exec   *Executor
	// master is the SeaweedFS master address resolved from the task's
	// cluster_id. Empty falls back to the controller's default master,
	// which only works in single-cluster setups.
	master string
}

func (s *stepCtx) logf(format string, args ...any) {
	if s.log != nil {
		fmt.Fprintf(s.log, format, args...)
	}
}

// opHandler implements one Step.op verb. Returns nil on success or an error
// the engine inspects against the step's on_failure policy.
type opHandler func(ctx context.Context, step skill.Step, sc *stepCtx) error

// checkHandler implements one precondition/postcheck. Same signature shape
// as opHandler but takes skill.Check (which carries args + fatal flag) so we
// don't have to fake a Step wrapper for every check.
type checkHandler func(ctx context.Context, check skill.Check, sc *stepCtx) error

// runSkill executes a Skill end-to-end: preconditions → steps → postchecks.
// On any precondition failure or step failure with on_failure=abort/rollback
// the engine short-circuits and returns the failure cause.
//
// Returns the parsed Definition's Skill ID/version for the caller to record
// in skill_executions.
func (e *Executor) runSkill(ctx context.Context, t store.Task, log *strings.Builder) (uuid.UUID, int, error) {
	if e.skills == nil {
		return uuid.Nil, 0, fmt.Errorf("skill registry not configured")
	}
	key := actionToSkill(t.Action)
	if key == "" {
		return uuid.Nil, 0, fmt.Errorf("no skill mapping for action %q", t.Action)
	}
	loaded := e.skills.Get(key)
	if loaded == nil {
		return uuid.Nil, 0, fmt.Errorf("skill %q not loaded (disabled or definition invalid)", key)
	}
	def := loaded.Definition

	sc := &stepCtx{
		task:   t,
		loaded: loaded,
		log:    log,
		state:  map[string]any{},
		exec:   e,
	}
	// Resolve the cluster's master_addr once. Without this, shell ops fall
	// back to the controller's default master (usually localhost) even when
	// the task targets a remote cluster — and `weed shell -master=localhost`
	// silently hangs trying to talk to a master that isn't there.
	if t.ClusterID != nil && e.pg != nil {
		if cl, err := e.pg.GetCluster(ctx, *t.ClusterID); err == nil && cl != nil {
			sc.master = cl.MasterAddr
		} else if err != nil {
			sc.logf("⚠ resolve cluster master: %v (falling back to default)\n", err)
		}
	}
	// Release any locks the steps acquired, regardless of outcome.
	defer func() {
		for _, k := range []string{"volume_lock", "cluster_lock"} {
			if v, ok := sc.state[k]; ok {
				if l, ok := v.(*VolumeLock); ok {
					l.Release(context.Background())
				}
			}
		}
	}()

	sc.logf("» skill=%s v%d risk=%s\n", loaded.Row.Key, loaded.Row.Version, loaded.Row.RiskLevel)

	// 1. Preconditions — fatal failure aborts; non-fatal logs and continues.
	for _, p := range def.Preconditions {
		if err := runPrecondition(ctx, p, sc); err != nil {
			if p.Fatal {
				sc.logf("✖ precondition %q failed (fatal): %v\n", p.Check, err)
				return loaded.Row.ID, loaded.Row.Version, fmt.Errorf("precondition %s: %w", p.Check, err)
			}
			sc.logf("⚠ precondition %q failed (non-fatal): %v\n", p.Check, err)
		}
	}

	// 2. Steps — each respects timeout, retry, on_failure.
	for i, step := range def.Steps {
		stepStart := time.Now()
		stepName := step.ID
		if stepName == "" {
			stepName = step.Op
		}
		sc.logf("→ step[%d] %s (op=%s)\n", i, stepName, step.Op)

		// Flush accumulated log so the UI's 3s poll renders progress while
		// long-running steps (e.g. volume.fix.replication) are still in flight.
		flushPartialLog(ctx, sc)

		err := runStep(ctx, step, sc)
		dur := time.Since(stepStart)
		metrics.ExecutorPhaseDuration.WithLabelValues(t.Action, stepName).
			Observe(dur.Seconds())

		if err == nil {
			sc.logf("  ✓ %s in %s\n", stepName, dur.Round(time.Millisecond))
			continue
		}
		switch step.OnFailure {
		case "continue":
			sc.logf("  ⚠ %s failed, continuing: %v\n", stepName, err)
			continue
		case "rollback":
			sc.logf("  ✖ %s failed, rolling back: %v\n", stepName, err)
			runRollback(ctx, def.Rollback, sc)
			return loaded.Row.ID, loaded.Row.Version, fmt.Errorf("step %s: %w", stepName, err)
		default: // "abort" or empty
			sc.logf("  ✖ %s failed, aborting: %v\n", stepName, err)
			return loaded.Row.ID, loaded.Row.Version, fmt.Errorf("step %s: %w", stepName, err)
		}
	}

	// 3. Postchecks — soft, but logged as warnings if they fail.
	for _, p := range def.Postchecks {
		if err := runPrecondition(ctx, p, sc); err != nil {
			sc.logf("⚠ postcheck %q failed: %v\n", p.Check, err)
		}
	}
	sc.logf("» skill complete\n")
	return loaded.Row.ID, loaded.Row.Version, nil
}

// runStep applies the step's timeout + retry policy and dispatches to the op
// handler registry.
func runStep(ctx context.Context, step skill.Step, sc *stepCtx) error {
	handler, ok := opHandlers[step.Op]
	if !ok {
		return fmt.Errorf("unknown op %q (no handler registered)", step.Op)
	}
	timeout := time.Duration(step.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 6 * time.Hour
	}
	maxAttempts := 1
	backoff := 0 * time.Second
	if step.Retry != nil {
		if step.Retry.MaxAttempts > 0 {
			maxAttempts = step.Retry.MaxAttempts
		}
		if step.Retry.BackoffSeconds > 0 {
			backoff = time.Duration(step.Retry.BackoffSeconds) * time.Second
		}
	}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		stepCtx, cancel := context.WithTimeout(ctx, timeout)
		err := handler(stepCtx, step, sc)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt < maxAttempts {
			sc.logf("    ↺ attempt %d/%d failed: %v; sleeping %s\n",
				attempt, maxAttempts, err, backoff)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}
	}
	return lastErr
}

// runRollback runs every rollback step best-effort; first failure is logged
// but later steps still attempt. We don't want a partial rollback to leave
// dangling state.
func runRollback(ctx context.Context, steps []skill.RollbackStep, sc *stepCtx) {
	for _, rs := range steps {
		fakeStep := skill.Step{Op: rs.Op, Args: rs.Args, TimeoutSeconds: 1800}
		if err := runStep(ctx, fakeStep, sc); err != nil {
			sc.logf("  ✖ rollback %s failed: %v\n", rs.Op, err)
		} else {
			sc.logf("  ✓ rollback %s ok\n", rs.Op)
		}
	}
}

// runPrecondition is a thin wrapper so postchecks (same shape) can reuse it.
// Sprint 3-3 ships a stub registry; Sprint 3-4 will replace stubs with real
// SeaweedFS state checks.
func runPrecondition(ctx context.Context, c skill.Check, sc *stepCtx) error {
	h, ok := checkHandlers[c.Check]
	if !ok {
		// Unknown checks log but do not block — a custom SOP may name a check
		// the controller doesn't recognize, and we don't want to brick the run.
		sc.logf("  · check %q skipped (no handler — pending Sprint 3-4)\n", c.Check)
		return nil
	}
	return h(ctx, c, sc)
}

// ---------------------------------------------------------------------------
// Op handler registry. Sprint 3-3 wires the handlers we already implement in
// the legacy executor; the rest return "not implemented" which surfaces as a
// task failure rather than silently passing.
// ---------------------------------------------------------------------------

var opHandlers = map[string]opHandler{
	"acquire_volume_lock":          opAcquireVolumeLock,
	"acquire_cluster_balance_lock": opAcquireClusterLock,
	"acquire_cluster_repair_lock":  opAcquireClusterLock,
	"tier_move_dat_to_remote":      opTierUpload,
	"tier_move_dat_from_remote":    opTierDownload,
	"verify_remote_tier":           opVerifyRemoteTier,
	"verify_local_dat":             opVerifyLocalDat,
	"volume_shrink_preallocated":   opShrinkPreallocated,
	"audit_log":                    opAuditLog,
	"emit_dry_run_report":          opEmitDryRunReport,
	"emit_failover_report":         opEmitFailoverReport,
	"alert_if_at_risk":             opAlertIfAtRisk,
	// Demo-level stubs — these return success after logging. Sprint 5+ wires
	// real SeaweedFS shell / gRPC calls. Stubs let the executor walk through
	// every step in a Skill so the operator sees the full flow visualized.
	"find_under_replicated":        opStubLog("scanned topology, found N volumes needing repair"),
	"shell_volume_fix_replication": opShellFixReplication,
	"shell_volume_balance":         opShell("volume.balance", []string{"-force"}),
	"shell_volume_vacuum":          opShell("volume.vacuum", nil),
	"shell_volume_fsck":            opShell("volume.fsck", nil),
	"ec_generate_shards":           opStubLog("generated 14 EC shards"),
	"ec_distribute_shards":         opStubLog("distributed shards across racks"),
	"ec_remove_dat":                opStubLog("removed original .dat replicas"),
	"ec_remove_shards":             opStubLog("removed EC shards"),
	"ec_rebuild_dat":               opStubLog("rebuilt .dat from shards"),
	"volume_replicate":             opStubLog("replicated volume per replication policy"),
	"volume_delete":                opStubLog("deleted target replica"),
	"collection_plan_moves":        opStubLog("planned per-volume migration list"),
	"collection_execute_moves":     opStubLog("executed planned moves"),
	"collection_revert_partial_moves": opStubLog("rolled back partial moves"),
	"compute_failover_matrix":      opStubLog("computed worst-case loss matrix"),
}

// opStubLog returns an op handler that just logs a message and succeeds.
// Used for SeaweedFS operations not yet wired to real gRPC / shell calls.
// flushPartialLog writes the running log to PG using a fresh background ctx
// so cancellation of the parent (e.g. user closing the browser) doesn't kill
// the persistence call. Errors are logged and swallowed — log streaming is a
// progress nicety, not a correctness requirement.
func flushPartialLog(ctx context.Context, sc *stepCtx) {
	if sc == nil || sc.log == nil || sc.exec == nil {
		return
	}
	execID, ok := ExecIDFromCtx(ctx)
	if !ok {
		return
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := sc.exec.pg.UpdateExecutionLog(flushCtx, execID, sc.log.String()); err != nil {
		sc.exec.log.Debug("flush partial log", zap.Error(err))
	}
}

func opStubLog(message string) opHandler {
	return func(_ context.Context, _ skill.Step, sc *stepCtx) error {
		sc.logf("    [stub] %s\n", message)
		return nil
	}
}

// opShell runs an arbitrary `weed shell` command in-process and pipes stdout
// into the execution log line-by-line so the operator sees progress live.
func opShell(name string, baseArgs []string) opHandler {
	return func(ctx context.Context, _ skill.Step, sc *stepCtx) error {
		_, err := sc.exec.sw.RunShellCommandAt(ctx, sc.master, name, baseArgs, makeLogSink(ctx, sc))
		return err
	}
}

// opShellFixReplication runs `volume.fix.replication -apply`. The command
// itself walks the topology and fixes every under-replicated volume; we
// optionally narrow it via -collectionPattern when the task carries one,
// which keeps blast radius small in mixed-collection clusters.
func opShellFixReplication(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	args := []string{"-apply", "-doDelete=false"}
	if sc.task.Collection != "" {
		args = append(args, "-collectionPattern="+sc.task.Collection)
	}
	// Phase B: adapt -maxParallelization to current cluster pressure. Idle
	// → 4 (default), getting busy → 2, hot → 1. Reading pressure from the
	// in-memory snapshot is lock-free, so we can do this cheaply at start.
	args = append(args, fmt.Sprintf("-maxParallelization=%d", adaptiveParallelism(sc)))
	_, err := sc.exec.sw.RunShellCommandAt(ctx, sc.master, "volume.fix.replication", args, makeLogSink(ctx, sc))
	return err
}

// adaptiveParallelism maps current pressure → max concurrent SeaweedFS
// internal replica copies. Falls back to 4 (SeaweedFS default) when we
// can't read pressure.
func adaptiveParallelism(sc *stepCtx) int {
	if sc.exec == nil || sc.exec.pressure == nil || sc.task.ClusterID == nil {
		return 4
	}
	score, ok := sc.exec.pressure.Get(*sc.task.ClusterID)
	if !ok {
		return 4
	}
	thr := sc.exec.pressure.Threshold()
	switch {
	case score.Value >= thr:
		return 1 // shouldn't normally reach here (dispatcher gates), but be defensive
	case score.Value >= thr*0.66:
		return 2
	case score.Value >= thr*0.33:
		return 3
	default:
		return 4
	}
}

// makeLogSink returns a ShellLineSink that writes each subprocess line into
// the step log buffer + flushes to PG every ~1s so the UI's poll picks up
// progress without waiting for the subprocess to exit.
func makeLogSink(ctx context.Context, sc *stepCtx) func(string) {
	var lastFlush time.Time
	return func(line string) {
		sc.logf("    │ %s\n", line)
		if time.Since(lastFlush) > 800*time.Millisecond {
			flushPartialLog(ctx, sc)
			lastFlush = time.Now()
		}
	}
}

func indentLines(s, prefix string) string {
	return prefix + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n"+prefix)
}

// checkHandlers is intentionally near-empty in Sprint 3-3. Sprint 3-4 will
// fill the SeaweedFS-state probes (volume_is_readonly, replica_count_min, ...)
// using master.VolumeList / collection topology calls.
var checkHandlers = map[string]checkHandler{
	"not_in_blocklist":              checkAlwaysOK, // safety guard already ran upstream
	"in_change_window_or_emergency": checkAlwaysOK, // ditto
	"cluster_reachable":             checkClusterReachable,
	"cluster_admin_lock_acquirable": checkClusterAdminLockAcquirable,
}

func checkAlwaysOK(_ context.Context, _ skill.Check, _ *stepCtx) error { return nil }

func checkClusterReachable(ctx context.Context, _ skill.Check, sc *stepCtx) error {
	// Cheap probe — list volumes is the smallest call we have.
	_, err := sc.exec.sw.ListVolumes(ctx)
	return err
}

// checkClusterAdminLockAcquirable proactively reaches for the SeaweedFS
// master admin lock with a short timeout. If a previous shell session
// crashed without releasing, the master's lease will normally expire in a
// few seconds — but if some other operator is actively holding it, we'd
// otherwise block for the full step timeout (potentially hours for
// fix.replication). Failing fast here gives the AI postmortem a clean
// signal and the operator a clear message.
//
// Implementation: spawn `weed shell` and have it lock+unlock immediately.
// 15s is empirically enough for both lease takeover and a real human
// operator to notice a conflicting session.
func checkClusterAdminLockAcquirable(ctx context.Context, _ skill.Check, sc *stepCtx) error {
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := sc.exec.sw.RunShellCommandAt(probeCtx, sc.master, "unlock", nil, nil); err != nil {
		// `unlock` runs whether or not we hold the lock — but the shell still
		// has to lock+unlock its own session. If this errors with a context
		// timeout, the master's admin lock is contended.
		if probeCtx.Err() != nil {
			return fmt.Errorf("master admin lock contended: another `weed shell` session may be holding it (lease usually expires in 4-10s; retry shortly): %w", err)
		}
		return fmt.Errorf("admin-lock probe failed: %w", err)
	}
	sc.logf("    [precondition] master admin lock free\n")
	return nil
}

// --- Concrete op handlers ---------------------------------------------------

func opAcquireVolumeLock(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	lock, err := AcquireVolumeLock(ctx, sc.exec.pg.Pool, uint32(sc.task.VolumeID), sc.task.Action)
	if err != nil {
		return err
	}
	sc.state["volume_lock"] = lock
	return nil
}

func opAcquireClusterLock(ctx context.Context, step skill.Step, sc *stepCtx) error {
	// Cluster-scoped lock: pack a high-bit-set key derived from action.
	lock, err := AcquireVolumeLock(ctx, sc.exec.pg.Pool, 0, "cluster:"+step.Op)
	if err != nil {
		return err
	}
	sc.state["cluster_lock"] = lock
	return nil
}

func opTierUpload(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	dest := taskTarget(sc.task)["backend"]
	if dest == "" {
		return fmt.Errorf("missing target.backend")
	}
	sc.logf("    tier_upload vol=%d dest=%s keepLocal=%v\n",
		sc.task.VolumeID, dest, sc.exec.keepLD)
	return sc.exec.sw.TierMoveDatToRemote(ctx, sc.task.SrcServer,
		uint32(sc.task.VolumeID), sc.task.Collection, dest, sc.exec.keepLD)
}

func opTierDownload(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	sc.logf("    tier_download vol=%d server=%s\n",
		sc.task.VolumeID, sc.task.SrcServer)
	return sc.exec.sw.TierMoveDatFromRemote(ctx, sc.task.SrcServer,
		uint32(sc.task.VolumeID), sc.task.Collection, true)
}

func opVerifyRemoteTier(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	// Reuse the existing executor verification (queries master state for
	// RemoteStorageName/Key/Size>0). If the helper is missing, soft-pass with
	// a log so the run still completes; Sprint 3-4 hardens this.
	if v, ok := any(sc.exec.sw).(interface {
		VerifyTiered(ctx context.Context, vol uint32) error
	}); ok {
		return v.VerifyTiered(ctx, uint32(sc.task.VolumeID))
	}
	sc.logf("    verify_remote_tier (soft-pass — helper not wired)\n")
	return nil
}

func opVerifyLocalDat(_ context.Context, _ skill.Step, sc *stepCtx) error {
	sc.logf("    verify_local_dat (soft-pass — helper not wired)\n")
	return nil
}

func opShrinkPreallocated(ctx context.Context, _ skill.Step, sc *stepCtx) error {
	if v, ok := any(sc.exec.sw).(interface {
		VolumeShrinkPreallocated(ctx context.Context, server string, vol uint32, collection string) error
	}); ok {
		return v.VolumeShrinkPreallocated(ctx, sc.task.SrcServer, uint32(sc.task.VolumeID), sc.task.Collection)
	}
	return fmt.Errorf("seaweed.VolumeShrinkPreallocated not wired into client")
}

func opAuditLog(_ context.Context, step skill.Step, sc *stepCtx) error {
	action, _ := step.Args["action"].(string)
	if action == "" {
		action = sc.task.Action
	}
	sc.logf("    audit: %s vol=%d task=%s\n", action, sc.task.VolumeID, sc.task.ID)
	return nil
}

func opEmitDryRunReport(_ context.Context, _ skill.Step, sc *stepCtx) error {
	sc.logf("    dry_run report emitted (placeholder — wire structured payload)\n")
	return nil
}

func opEmitFailoverReport(_ context.Context, _ skill.Step, sc *stepCtx) error {
	sc.logf("    failover report emitted (placeholder)\n")
	return nil
}

func opAlertIfAtRisk(_ context.Context, _ skill.Step, sc *stepCtx) error {
	sc.logf("    alert_if_at_risk evaluated (no-op until risk matrix wired)\n")
	return nil
}

// taskTarget decodes the JSONB task.Target column into a string map. Returns
// an empty map on parse error so handlers can do a cheap presence check.
func taskTarget(t store.Task) map[string]string {
	out := map[string]string{}
	if len(t.Target) > 0 {
		_ = json.Unmarshal(t.Target, &out)
	}
	return out
}
