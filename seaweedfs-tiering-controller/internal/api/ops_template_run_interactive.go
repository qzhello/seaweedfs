package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// interactiveOpsRunTimeout caps an entire run including any operator
// thinking time at confirmation prompts. A run idle longer than this
// is GC'd: the runner emits a "timeout" event and exits.
const interactiveOpsRunTimeout = 60 * time.Minute

// SSE wire format (one event per line block). Step events carry both
// step_id (DAG identity) and step_index (source-array position) so
// the frontend can address nodes by either. Parallel-friendly:
// multiple step_start / await_confirm events may interleave when
// independent branches run together.
//
//	event: run_id          { run_id }
//	event: schedule        { ready: [step_id...] }              ← which nodes are about to start
//	event: step_start      { step_id, index, command, args }
//	event: line            { step_id, index, text }
//	event: step_done       { step_id, index, ok }
//	event: step_error      { step_id, index, error }
//	event: step_skipped    { step_id, index, reason }           ← upstream failed
//	event: analysis_start  { step_id, index }
//	event: analysis_done   { step_id, index, proposed, analysis }
//	event: analysis_error  { step_id, index, error }
//	event: await_confirm   { step_id, index, ... }
//	event: cancelled       { reason }
//	event: done            { ok }
//
// Approve / cancel:
//
//	POST /api/v1/ops-runs/:run_id/approve   { step_id, vars? }
//	POST /api/v1/ops-runs/:run_id/cancel
func runOpsTemplateInteractive(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		tplID, err := uuid.Parse(c.Param("tid"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad template id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		tpl, err := d.PG.GetOpsTemplate(c.Request.Context(), tplID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		steps, vars, err := decodeStepsBlob(tpl.Steps)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "decode steps: " + err.Error()})
			return
		}
		// Repair legacy templates loaded without DAG fields. Save-time
		// normalization handles new writes, but rows persisted before
		// that landed need the same treatment on read. Bail loudly on
		// cycles since the runner can't safely schedule.
		steps, err = normalizeDAG(steps)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// Seed scope from URL ?var.<key>=<value>. Unlike the legacy
		// runner we DON'T require every variable up front — InferVars
		// and operator approval can fill the gaps mid-flow. Missing
		// required vars become inference inputs, not 400 errors.
		scope := map[string]string{}
		var scopeMu sync.Mutex
		for _, v := range vars {
			val := c.Query("var." + v.Key)
			if val == "" {
				val = v.Default
			}
			scope[v.Key] = val
		}

		// Register the run so the approve/cancel handlers can find it.
		run := d.OpsRuns.register(userOf(c))
		defer d.OpsRuns.remove(run.ID)

		_ = d.PG.Audit(c.Request.Context(), userOf(c), "ops_template.run_interactive",
			"ops_template", tpl.ID.String(), map[string]any{
				"cluster_id": clusterID, "template": tpl.Name, "run_id": run.ID,
			})

		// Simulation mode: dry-run that only invokes read-only shell
		// commands and analyzer scripts. Mutating commands are
		// reported but never executed; confirm pauses + AI inference
		// + alert emission are all skipped so the operator sees a
		// clean trace of what WOULD happen.
		simulate := c.Query("simulate") == "true" || c.Query("dry_run") == "true"

		// Per-template alert routing. May be nil (no alerts configured).
		// We use a detached background context for alert emission so a
		// disconnecting SSE client still gets the success/failure beep.
		// Suppressed entirely in simulation mode — a dry run shouldn't
		// page anyone.
		alertCfg := decodeOpsTemplateAlerts(tpl.Alerts)
		fireAlert := func(status string, v alertTplVars) {
			if simulate {
				return
			}
			emitFlowAlert(context.Background(), d, alertCfg, tpl, cl.Name, run.ID, status, v)
		}
		fireAlert("start", alertTplVars{})

		// SSE headers.
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		c.Writer.WriteHeader(http.StatusOK)
		c.Writer.Flush()

		// Single mutex serialises every event write. Without this,
		// concurrent step goroutines could interleave bytes mid-event
		// and corrupt the SSE stream.
		var sseMu sync.Mutex
		flush := func(event string, payload any) {
			b, _ := json.Marshal(payload)
			sseMu.Lock()
			defer sseMu.Unlock()
			fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, string(b))
			c.Writer.Flush()
		}

		flush("run_id", gin.H{"run_id": run.ID.String(), "simulate": simulate})
		if simulate {
			flush("line", gin.H{
				"index": -1,
				"text":  "[SIMULATION] read-only commands will execute against the live cluster; mutating commands will be reported but skipped. No approval gates, no AI inference, no alerts.",
			})
		}

		// Top-level run context. Cancellation propagates to every
		// nested shell call via ctx.Done().
		ctx, cancel := context.WithTimeout(c.Request.Context(), interactiveOpsRunTimeout)
		defer cancel()
		go func() {
			select {
			case <-run.Cancel:
				cancel()
			case <-ctx.Done():
			}
		}()
		defer run.markDone()

		allow := shellAllowedNames()

		// Per-step state arrays kept in source-array order so we can
		// reference them by index throughout. status drives the
		// scheduling decision; output is captured for downstream
		// substitution + audit.
		status := make([]opsStepStatus, len(steps))
		outputs := make([]string, len(steps))
		stepErr := make([]error, len(steps))

		// indexByID maps step.ID → source-array index for O(1) lookup
		// inside hot loops.
		indexByID := make(map[string]int, len(steps))
		for i, s := range steps {
			indexByID[s.ID] = i
			// Analyzer steps don't appear in the shell catalog — they
			// dispatch to a Python script instead. Skip the catalog
			// check for them.
			if s.Kind == "analyzer" {
				continue
			}
			if _, ok := allow[s.Command]; !ok {
				flush("step_error", gin.H{"step_id": s.ID, "index": i,
					"error": fmt.Sprintf("command %q not in catalog", s.Command)})
				flush("done", gin.H{"ok": false})
				return
			}
		}

		// completed counts terminal states (done/error/skipped). When
		// it reaches len(steps), the run is over. doneCh signals one
		// terminal transition; the scheduler loop drains it before
		// computing the next ready frontier.
		doneCh := make(chan int, len(steps)) // value = step index that finished
		var anyFailed bool

		// Cascade error: when step i fails, mark every descendant as
		// skipped so they never schedule. Returns the count of newly
		// skipped steps so the scheduler can know the run is over.
		cascadeSkip := func(failedIdx int) {
			// Walk the closure: any step whose depends_on includes a
			// failed/skipped step inherits skipped status.
			changed := true
			for changed {
				changed = false
				for i, s := range steps {
					if status[i] != opsStepPending {
						continue
					}
					for _, dep := range s.DependsOn {
						di := indexByID[dep]
						if status[di] == opsStepError || status[di] == opsStepSkipped {
							status[i] = opsStepSkipped
							flush("step_skipped", gin.H{
								"step_id": s.ID, "index": i,
								"reason": fmt.Sprintf("upstream step %q failed or was skipped", dep),
							})
							changed = true
							_ = failedIdx
							break
						}
					}
				}
			}
		}

		// runOneStep executes step i synchronously inside its own
		// goroutine: inference → confirm pause → shell call → audit.
		// Reports terminal status by writing the step index to doneCh
		// and updating status[]/outputs[]/stepErr[] in place. scopeMu
		// guards scope reads/writes because parallel branches may
		// touch shared variables.
		runOneStep := func(i int) {
			s := steps[i]
			cat := allow[s.Command]

			// Analyzer steps short-circuit the entire shell pipeline:
			// no catalog, no inference, no confirm. They read a prior
			// step's stdout and run a Python script.
			if s.Kind == "analyzer" {
				runAnalyzerStep(c.Request.Context(), d, tpl, run, scope, &scopeMu, steps, outputs, indexByID, i, flush)
				if outputs[i] == "__analyzer_error__" {
					status[i] = opsStepError
					stepErr[i] = fmt.Errorf("analyzer failed; see step output")
				} else {
					status[i] = opsStepDone
				}
				doneCh <- i
				return
			}

			// Snapshot scope for substitution. Reads are mutex-guarded
			// even though writes mostly come from earlier completed
			// steps; this keeps the race detector quiet and protects
			// the rare case where two branches finish near-simultaneously
			// and the next-ready step starts before both reads settle.
			snap := func() map[string]string {
				scopeMu.Lock()
				defer scopeMu.Unlock()
				out := make(map[string]string, len(scope))
				for k, v := range scope {
					out[k] = v
				}
				return out
			}

			// --- AI inference -----------------------------------
			proposed := map[string]string{}
			analysis := ""
			validInfers := make([]opsVarInference, 0, len(s.InferVars))
			for _, iv := range s.InferVars {
				// In DAG mode "FromStep" still means 1-based source
				// position; we trust the save-time normalizer to have
				// dropped impossible refs.
				if iv.FromStep > 0 && iv.FromStep-1 >= len(steps) {
					continue
				}
				validInfers = append(validInfers, iv)
			}
			// Simulation skips AI inference so the dry run is fast
			// and deterministic. Operators get a synthetic note.
			if simulate && len(validInfers) > 0 {
				flush("line", gin.H{"step_id": s.ID, "index": i,
					"text": fmt.Sprintf("[SIMULATION] would ask AI to infer %d variable(s); skipped.", len(validInfers))})
				validInfers = nil
			}
			if len(validInfers) > 0 {
				flush("analysis_start", gin.H{"step_id": s.ID, "index": i})
				inferred, infErr := inferVarValues(ctx, d, validInfers, snap(), i)
				if infErr != nil {
					flush("analysis_error", gin.H{"step_id": s.ID, "index": i, "error": infErr.Error()})
				} else if inferred != nil {
					for k, v := range inferred.Values {
						proposed[k] = v
					}
					analysis = inferred.Analysis
					flush("analysis_done", gin.H{
						"step_id": s.ID, "index": i,
						"proposed": proposed, "analysis": analysis,
					})
				}
			}

			// --- Confirmation gate ------------------------------
			renderedArgs := substituteArgs(s.Args, scopeWith(snap(), proposed))
			// In simulation mode confirm gates are bypassed too — the
			// whole point is to walk the flow without interaction.
			needsConfirm := !simulate && (s.ConfirmBefore || len(proposed) > 0 || hasUnresolvedPlaceholders(renderedArgs))
			if simulate && (s.ConfirmBefore || len(proposed) > 0) {
				flush("line", gin.H{"step_id": s.ID, "index": i,
					"text": "[SIMULATION] approval gate skipped."})
			}
			if needsConfirm {
				ch := run.ChanForStep(s.ID)
				fireAlert("await", alertTplVars{StepID: s.ID, StepIndex: i})
				flush("await_confirm", gin.H{
					"step_id":       s.ID,
					"index":         i,
					"command":       s.Command,
					"reason":        s.Reason,
					"rendered_args": renderedArgs,
					"args_template": s.Args,
					"proposed_vars": proposed,
					"analysis":      analysis,
					"required_vars": unresolvedRefs(s.Args, scopeWith(snap(), proposed)),
					"risk":          cat.Risk,
				})
				var sig opsRunSignal
				select {
				case sig = <-ch:
				case <-run.Cancel:
					run.ClearStep(s.ID)
					status[i] = opsStepError
					stepErr[i] = fmt.Errorf("cancelled before approval")
					doneCh <- i
					return
				case <-ctx.Done():
					run.ClearStep(s.ID)
					status[i] = opsStepError
					stepErr[i] = ctx.Err()
					doneCh <- i
					return
				}
				run.ClearStep(s.ID)
				if sig.Cancel {
					status[i] = opsStepError
					stepErr[i] = fmt.Errorf("operator cancelled at step %q", s.ID)
					doneCh <- i
					return
				}
				// Merge operator + proposed into scope. Operator wins.
				scopeMu.Lock()
				for k, v := range proposed {
					if _, set := sig.Vars[k]; !set {
						scope[k] = v
					}
				}
				for k, v := range sig.Vars {
					scope[k] = v
				}
				renderedArgs = substituteArgs(s.Args, scope)
				scopeMu.Unlock()
			}

			// --- Execute ---------------------------------------
			var args []string
			if a := strings.TrimSpace(renderedArgs); a != "" {
				args = strings.Fields(a)
			}
			flush("step_start", gin.H{
				"step_id": s.ID, "index": i, "command": s.Command,
				"args": renderedArgs, "streams": cat.Streams,
			})
			if (cat.Risk == "mutate" || cat.Risk == "destructive") && strings.TrimSpace(s.Reason) == "" {
				s.Reason = fmt.Sprintf("ops_template %s step %s", tpl.Name, s.ID)
			}
			var out string
			var rErr error
			lineSink := func(ln string) {
				flush("line", gin.H{"step_id": s.ID, "index": i, "text": ln})
			}
			// Simulation guard: hard-block any non-read-only command.
			// We deliberately don't trust just `Risk`; ReadOnly is the
			// authoritative flag the shell catalog uses to decide
			// whether `weed shell` needs an admin lock.
			if simulate && !cat.ReadOnly {
				lineSink(fmt.Sprintf("[SIMULATION] would execute: %s %s", s.Command, renderedArgs))
				lineSink(fmt.Sprintf("[SIMULATION] risk=%s — skipped (mutating commands are not run in dry-run mode)", cat.Risk))
				out = fmt.Sprintf("[simulated] %s %s\n", s.Command, renderedArgs)
				rErr = nil
				// Fall through to the audit + scope write so downstream
				// analyzer steps see something they can parse — they'd
				// otherwise have no upstream output to work with.
			} else if cat.ReadOnly {
				out, rErr = d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, s.Command, args)
				for _, ln := range strings.Split(out, "\n") {
					if ln != "" {
						lineSink(ln)
					}
				}
			} else {
				var buf strings.Builder
				tee := func(ln string) {
					buf.WriteString(ln)
					buf.WriteByte('\n')
					lineSink(ln)
				}
				out, rErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, s.Command, args, tee)
				if out == "" {
					out = buf.String()
				}
			}

			outputs[i] = out
			scopeMu.Lock()
			scope[fmt.Sprintf("step%d.output", i+1)] = out
			scope[fmt.Sprintf("%s.output", s.ID)] = out
			applyCaptures(i+1, out, s.Capture, scope)
			scopeMu.Unlock()

			// --- Audit ----------------------------------------
			auditOut := out
			if len(auditOut) > 8192 {
				auditOut = auditOut[:4096] + "\n... (truncated) ...\n" + auditOut[len(auditOut)-4096:]
			}
			auditEntry := map[string]any{
				"cluster_id": clusterID,
				"template":   tpl.Name,
				"run_id":     run.ID,
				"step_id":    s.ID,
				"step_index": i,
				"command":    s.Command,
				"args":       renderedArgs,
				"reason":     s.Reason,
				"ok":         rErr == nil,
				"output":     auditOut,
			}
			if rErr != nil {
				auditEntry["error"] = rErr.Error()
			}
			_ = d.PG.Audit(c.Request.Context(), userOf(c), "ops_template.step",
				"ops_template", tpl.ID.String(), auditEntry)

			if rErr != nil {
				status[i] = opsStepError
				stepErr[i] = rErr
				flush("step_error", gin.H{"step_id": s.ID, "index": i, "error": rErr.Error()})
				fireAlert("failure", alertTplVars{StepID: s.ID, StepIndex: i, Error: rErr.Error()})
			} else {
				status[i] = opsStepDone
				flush("step_done", gin.H{"step_id": s.ID, "index": i, "ok": true})
			}
			doneCh <- i
		}

		// --- Scheduler loop -------------------------------------
		// Kick off whatever is initially ready (all DependsOn empty);
		// each time a step finishes, recompute ready frontier and
		// launch new branches. We finish when every step reached a
		// terminal state.
		launchReady := func() {
			ready := readyFrontier(steps, status)
			if len(ready) > 0 {
				ids := make([]string, len(ready))
				for k, idx := range ready {
					ids[k] = steps[idx].ID
				}
				flush("schedule", gin.H{"ready": ids})
			}
			for _, idx := range ready {
				status[idx] = opsStepRunning
				go runOneStep(idx)
			}
		}
		launchReady()

		finished := 0
		for finished < len(steps) {
			select {
			case idx := <-doneCh:
				finished++
				if status[idx] == opsStepError {
					anyFailed = true
					cascadeSkip(idx)
					// cascadeSkip may have flipped pending → skipped;
					// account for those as finished too.
					for i := range steps {
						if status[i] == opsStepSkipped {
							// Re-counting is cheaper than tracking deltas.
						}
					}
					// Recompute finished count from authoritative status.
					n := 0
					for _, st := range status {
						if st == opsStepDone || st == opsStepError || st == opsStepSkipped {
							n++
						}
					}
					finished = n
				}
				launchReady()
			case <-ctx.Done():
				flush("cancelled", gin.H{"reason": "context done"})
				flush("done", gin.H{"ok": false})
				return
			}
		}
		flush("done", gin.H{"ok": !anyFailed})
		if anyFailed {
			fireAlert("failure", alertTplVars{Error: "flow finished with failed step(s)"})
		} else {
			fireAlert("success", alertTplVars{})
		}
	}
}

// approveOpsRun delivers the operator's confirmation (with any
// edited variable values) to the runner. Body shape:
//
//	{ "step_id": "s3", "vars": { "volume_id": "42" } }
//
// step_id is optional only when exactly one step is currently paused
// (the legacy single-pause case); ambiguity produces 400.
func approveOpsRun(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		runID, err := uuid.Parse(c.Param("run_id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad run_id"})
			return
		}
		run, ok := d.OpsRuns.get(runID)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "run not found or already finished"})
			return
		}
		if user := userOf(c); user != run.UserID && user != "" {
			c.JSON(http.StatusForbidden, gin.H{"error": "not the run owner"})
			return
		}
		var body struct {
			StepID string            `json:"step_id"`
			Vars   map[string]string `json:"vars"`
		}
		_ = c.ShouldBindJSON(&body)
		if body.Vars == nil {
			body.Vars = map[string]string{}
		}
		// Resolve target step.
		if body.StepID == "" {
			pending := run.PendingStepIDs()
			if len(pending) == 0 {
				c.JSON(http.StatusConflict, gin.H{"error": "no step awaiting confirmation"})
				return
			}
			if len(pending) > 1 {
				c.JSON(http.StatusBadRequest, gin.H{
					"error":   "multiple steps awaiting confirmation; specify step_id",
					"pending": pending,
				})
				return
			}
			body.StepID = pending[0]
		}
		ch := run.ChanForStep(body.StepID)
		select {
		case ch <- opsRunSignal{Vars: body.Vars}:
			c.JSON(http.StatusOK, gin.H{"ok": true, "step_id": body.StepID})
		case <-run.Done():
			c.JSON(http.StatusGone, gin.H{"error": "run finished before approval delivered"})
		case <-time.After(5 * time.Second):
			c.JSON(http.StatusConflict, gin.H{"error": "step is not awaiting confirmation right now"})
		}
	}
}

func cancelOpsRun(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		runID, err := uuid.Parse(c.Param("run_id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad run_id"})
			return
		}
		run, ok := d.OpsRuns.get(runID)
		if !ok {
			c.JSON(http.StatusOK, gin.H{"ok": true, "note": "run not active"})
			return
		}
		if user := userOf(c); user != run.UserID && user != "" {
			c.JSON(http.StatusForbidden, gin.H{"error": "not the run owner"})
			return
		}
		select {
		case <-run.Cancel:
			// already cancelled; idempotent
		default:
			close(run.Cancel)
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// scopeWith returns a merged map without mutating either input. Used
// to render args using "scope plus proposed" without committing the
// proposal to the real scope until the operator approves.
func scopeWith(base, overlay map[string]string) map[string]string {
	if len(overlay) == 0 {
		return base
	}
	out := make(map[string]string, len(base)+len(overlay))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overlay {
		out[k] = v
	}
	return out
}

// hasUnresolvedPlaceholders reports whether the rendered args still
// contain any "{{...}}" — meaning the substitution didn't find a
// value. We treat this as "needs operator input" and force a pause.
func hasUnresolvedPlaceholders(rendered string) bool {
	return strings.Contains(rendered, "{{")
}

// unresolvedRefs scans the raw args template for "{{X}}" references
// whose key is not yet in scope, returning the deduped key list so the
// approval card can highlight which fields still need a value. Only
// top-level vars are reported — step output references (like
// "{{step1.output}}") are filtered because the operator can't supply
// them by typing.
func unresolvedRefs(args string, scope map[string]string) []string {
	out := []string{}
	seen := map[string]bool{}
	rest := args
	for {
		i := strings.Index(rest, "{{")
		if i < 0 {
			return out
		}
		j := strings.Index(rest[i:], "}}")
		if j < 0 {
			return out
		}
		key := strings.TrimSpace(rest[i+2 : i+j])
		rest = rest[i+j+2:]
		if key == "" || strings.Contains(key, ".") {
			continue // skip "step1.output", "step1.capture.xxx", etc.
		}
		if _, ok := scope[key]; ok {
			continue
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
}
