package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// opsStep is the wire shape for one step inside an ops template. Mirrors
// the /clusters/:id/shell body so the runner can hand each step straight
// to clusterShellExec's underlying logic.
//
// Placeholders: Args may contain `{{name}}` references that resolve from
// the template's declared Variables, the previous step's full stdout
// (`{{step1.output}}`), or a named regex capture from a previous step
// (`{{step1.capture.bucket}}`). See ops_template_render.go.
type opsStep struct {
	// ID is the stable identifier other steps reference via DependsOn.
	// Generated server-side at save time when missing so AI drafts and
	// legacy templates both get sane IDs. Format: short slug ("s1",
	// "s2") for human readability in audit logs.
	ID           string `json:"id,omitempty"`
	// Kind selects which engine processes this step. Empty / "shell"
	// runs Command via `weed shell` (the legacy default). "analyzer"
	// runs an analyzer_scripts row against a prior step's stdout —
	// see Analyzer below.
	Kind         string `json:"kind,omitempty"`
	Command      string `json:"command"`
	Args         string `json:"args,omitempty"`
	Reason       string `json:"reason,omitempty"`
	PauseOnError bool   `json:"pause_on_error,omitempty"`
	// DependsOn lists the IDs of steps that must finish successfully
	// before this step runs. Empty = root step (runs first). Steps
	// sharing the same dependency set run in parallel. Cycles are
	// rejected at save time.
	DependsOn []string `json:"depends_on,omitempty"`
	// Position is purely a UI hint for the ReactFlow editor; the
	// runner ignores it. Stored so the graph layout persists across
	// reloads. Defaults to (0,0) — the editor auto-lays-out missing
	// values on render.
	Position *opsStepPos `json:"position,omitempty"`
	// Capture pulls named regex matches off this step's stdout into the
	// rendering scope so later steps can reference them.
	Capture []opsCapture `json:"capture,omitempty"`
	// Streaming hint mirrors shellCommand.Streams; populated server-side
	// from the catalog so the UI can decide whether to render a per-step
	// streaming tail or wait for the buffered output.
	Streams bool `json:"streams,omitempty"`
	// ConfirmBefore makes the runner pause before executing this step,
	// surface the rendered command + proposed variable values, and wait
	// for an explicit operator approval. Use for any step whose effect
	// is hard to undo (move, delete, encode), and for any step whose
	// arguments come from AI inference (so the human eyeballs them).
	ConfirmBefore bool `json:"confirm_before,omitempty"`
	// InferVars asks the controller to call the configured AI provider
	// before this step runs, feed it the prior steps' outputs, and ask
	// it to produce values for the listed variable names. The
	// inferred values land in the proposal that the await-confirm
	// pause surfaces to the operator (so they're always reviewable;
	// the LLM never silently writes a variable used in a mutating
	// command). Implies ConfirmBefore=true in practice — the runner
	// auto-pauses whenever inference fills a variable.
	InferVars []opsVarInference `json:"infer_vars,omitempty"`
	// Analyzer is the per-step config for kind="analyzer" steps.
	// Lets a template plug a Python post-processor in between two
	// shell steps without leaving the editor or trusting the LLM
	// for the parse.
	Analyzer *opsStepAnalyzer `json:"analyzer,omitempty"`
}

// opsStepAnalyzer wires a "kind: analyzer" step to its source data
// and the script that processes it. The runner pulls the upstream
// step's captured stdout, feeds it to the script with the rendered
// params, and stores the JSON result back into the scope so later
// steps can reference it via `{{stepN.analyzer.<key>}}`.
type opsStepAnalyzer struct {
	// ScriptName is the analyzer_scripts.name (stable). Stored as a
	// name (not UUID) so dev/staging/prod share the same template
	// JSON even when scripts are re-seeded with new UUIDs.
	ScriptName string `json:"script_name"`
	// FromStep is the ID of the step whose captured stdout should be
	// piped into the script's input. Empty = "use the most recent
	// completed step in this DAG branch".
	FromStep string `json:"from_step,omitempty"`
	// Params is a map of declared param → template string. Each value
	// is rendered against the scope before invocation, so the
	// operator can reference variables / prior captures the same way
	// shell step args do.
	Params map[string]string `json:"params,omitempty"`
}

// opsStepPos is the editor-layout coordinate for a step node. Kept
// minimal — ReactFlow takes {x,y} directly.
type opsStepPos struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// opsVarInference declares one variable the AI should derive from
// prior step output before the parent step runs.
//
// Example: step 1 runs `volume.list`; step 2 needs to know which
// server has the most volumes. Step 2's InferVars would be:
//
//	[{var: "source_server", from_step: 1, hint: "the volume server with the most volumes"}]
//
// At run time, the controller hands step 1's stdout + the hint to
// the LLM and asks for a JSON object `{"source_server": "..."}`.
// The hint is what the operator wrote when authoring the template;
// keep it operator-readable so they can audit the inference.
type opsVarInference struct {
	Var      string `json:"var"`                // variable key this fills
	FromStep int    `json:"from_step,omitempty"` // 1-indexed; 0 = "all prior steps"
	Hint     string `json:"hint"`                // free-form intent the AI must satisfy
}

// stepsBlob is the shape we marshal into the OpsTemplate.Steps jsonb
// column. Older rows persisted as a bare JSON array — decodeStepsBlob
// handles both forms so we don't need a backfill migration.
type stepsBlob struct {
	Steps     []opsStep        `json:"steps"`
	Variables []opsTemplateVar `json:"variables,omitempty"`
}

// decodeStepsBlob accepts either the new envelope shape ({"steps":[...],
// "variables":[...]}) or the legacy bare array form and returns both
// slices. Empty / null input yields empty slices, not an error, so old
// templates without variables keep loading.
func decodeStepsBlob(raw json.RawMessage) ([]opsStep, []opsTemplateVar, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil, nil
	}
	trim := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trim, "[") {
		var legacy []opsStep
		if err := json.Unmarshal(raw, &legacy); err != nil {
			return nil, nil, err
		}
		return legacy, nil, nil
	}
	var env stepsBlob
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, nil, err
	}
	return env.Steps, env.Variables, nil
}

// opsTemplatePayload is the wire JSON we accept on PUT /ops/templates.
type opsTemplatePayload struct {
	ID          string           `json:"id,omitempty"`
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Category    string           `json:"category,omitempty"`
	Steps       []opsStep        `json:"steps"`
	Variables   []opsTemplateVar `json:"variables,omitempty"`
	// AIPrecheck toggles the per-step risk advisor. Pointer so the
	// frontend can omit the field and we'll fall back to the
	// existing-row value on update. Nil-on-insert defaults to TRUE
	// in the DB (safer to nag than to silently skip).
	AIPrecheck  *bool            `json:"ai_precheck,omitempty"`
	// Alerts is the optional per-flow notification routing. Sending
	// nil (or no field) preserves the existing row; sending {} or a
	// config with empty channel_ids clears alerts for this template.
	Alerts      *opsTemplateAlerts `json:"alerts,omitempty"`
}

// renderTemplate flattens a stored OpsTemplate into the shape the UI
// consumes: top-level name + steps + variables instead of an opaque
// jsonb blob. Read by list / get so older legacy-array rows render the
// same as new envelope-shaped rows.
func renderTemplate(t store.OpsTemplate) gin.H {
	steps, vars, _ := decodeStepsBlob(t.Steps)
	if steps == nil {
		steps = []opsStep{}
	}
	if vars == nil {
		vars = []opsTemplateVar{}
	}
	return gin.H{
		"id":           t.ID,
		"name":         t.Name,
		"description":  t.Description,
		"category":     t.Category,
		"steps":        steps,
		"variables":    vars,
		"ai_precheck":  t.AIPrecheck,
		"alerts":       decodeOpsTemplateAlerts(t.Alerts),
		"created_by":   t.CreatedBy,
		"updated_by":   t.UpdatedBy,
		"created_at":   t.CreatedAt,
		"updated_at":   t.UpdatedAt,
	}
}

func listOpsTemplates(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ts, err := d.PG.ListOpsTemplates(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out := make([]gin.H, 0, len(ts))
		for _, t := range ts {
			out = append(out, renderTemplate(t))
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func getOpsTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		t, err := d.PG.GetOpsTemplate(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, renderTemplate(*t))
	}
}

// upsertOpsTemplate validates that every step has a real catalog
// command AND that every {{placeholder}} in step args resolves to a
// declared variable or a prior step's capture. Catching both at save
// time means the operator never gets the surprise of a half-completed
// run failing because of a typo'd reference.
func upsertOpsTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body opsTemplatePayload
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}

		allow := shellAllowedNames()
		clean := make([]opsStep, 0, len(body.Steps))
		for i, s := range body.Steps {
			s.Command = strings.TrimSpace(s.Command)
			// Analyzer steps don't carry a catalog command — they
			// reference an analyzer_scripts row by name. Use a
			// synthetic command label so the rest of the validation
			// (placeholder check, audit) has something to log.
			if s.Kind == "analyzer" {
				if s.Analyzer == nil || strings.TrimSpace(s.Analyzer.ScriptName) == "" {
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("step %d: analyzer step requires analyzer.script_name", i+1)})
					return
				}
				if s.Command == "" {
					s.Command = "analyzer:" + s.Analyzer.ScriptName
				}
				clean = append(clean, s)
				continue
			}
			if s.Command == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("step %d: command required", i+1)})
				return
			}
			cat, ok := allow[s.Command]
			if !ok {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("step %d: command %q is not in the catalog", i+1, s.Command)})
				return
			}
			s.Streams = cat.Streams
			// Sanitize infer_vars: the first step has no prior output
			// to ground inference against, so AI inference there can
			// only hallucinate. Silently strip rather than reject —
			// the operator can still hand-fill the values in the
			// approval card. Forward references (from_step pointing
			// past the current step) get the same treatment.
			if len(s.InferVars) > 0 {
				keep := s.InferVars[:0]
				for _, iv := range s.InferVars {
					if i == 0 {
						continue // step 1 — no priors to read
					}
					if iv.FromStep > i {
						continue // forward reference (i is 0-based, step nums are 1-based)
					}
					keep = append(keep, iv)
				}
				s.InferVars = keep
			}
			clean = append(clean, s)
		}
		// Normalize the DAG: fill missing step IDs, repair invalid
		// depends_on refs, linearize templates that have no
		// dependency info at all (legacy / AI drafts that didn't
		// emit the field). Cycles get caught here too.
		var derr error
		clean, derr = normalizeDAG(clean)
		if derr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": derr.Error()})
			return
		}
		// Auto-declare any `{{X}}` placeholder that's missing from
		// the variables list. Without this the AI's draft (and any
		// hand-typed template) would fail save validation the moment
		// a step references `{{volume_id}}` without an explicit
		// variable row — annoying UX with no real safety benefit, since
		// the run dialog will still prompt for every declared var.
		vars := autoDeclareMissingVars(body.Variables, clean)
		if err := validateTemplatePlaceholders(vars, clean); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// Persist envelope: {steps, variables}. decodeStepsBlob keeps
		// legacy bare-array rows readable so this is forward-only —
		// no migration of existing rows needed.
		blob, _ := json.Marshal(stepsBlob{Steps: clean, Variables: vars})

		t := store.OpsTemplate{
			Name:        body.Name,
			Description: body.Description,
			Category:    body.Category,
			Steps:       blob,
			// Default-on; explicit false from frontend disables it.
			AIPrecheck:  true,
		}
		if body.AIPrecheck != nil {
			t.AIPrecheck = *body.AIPrecheck
		}
		// Encode alerts blob. Empty channel_ids → JSON null so the
		// runner sees "no routing" via decodeOpsTemplateAlerts.
		if body.Alerts != nil && len(body.Alerts.ChannelIDs) > 0 {
			if blob, err := json.Marshal(body.Alerts); err == nil {
				t.Alerts = blob
			}
		} else {
			t.Alerts = json.RawMessage("null")
		}
		if body.ID != "" {
			if parsed, err := uuid.Parse(body.ID); err == nil {
				t.ID = parsed
			}
		}
		id, err := d.PG.UpsertOpsTemplate(c.Request.Context(), t, userOf(c))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "ops_template", id.String(), body)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteOpsTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteOpsTemplate(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "delete", "ops_template", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// runOpsTemplate executes every step of a template against the given
// cluster, streaming progress as SSE events:
//
//	event: step_start  data: {"index":N, "command":"...", "args":"..."}
//	event: line        data: <one stdout line>
//	event: step_done   data: {"index":N, "ok":true}
//	event: step_error  data: {"index":N, "error":"..."}
//	event: done        data: {"ok":true}
//
// Failure semantics: by default a failing step aborts the run. A step
// with pause_on_error=true (currently a misnomer — kept as a hint for
// the UI to highlight, but server-side every failure aborts unless the
// query param ?continue_on_error=true is set).
func runOpsTemplateBridge(d Deps) gin.HandlerFunc {
	// Gin doesn't allow two different param names at the same position
	// across routes that share /clusters/:id — so the route uses (:id,
	// :tid) and we read those names here. Keeping a single canonical
	// handler avoids drift between the route + the body of work.
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
		continueOnError := c.Query("continue_on_error") == "true"

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

		// Variable values come in as ?var.<key>=<value> on the SSE URL.
		// The query string is the only practical input channel for SSE
		// (request body is awkward over EventSource-style fetch readers)
		// and it matches how continue_on_error is already wired.
		scope := map[string]string{}
		for _, v := range vars {
			val := c.Query("var." + v.Key)
			if val == "" {
				val = v.Default
			}
			if v.Required && strings.TrimSpace(val) == "" {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": fmt.Sprintf("variable %q is required", v.Key),
				})
				return
			}
			scope[v.Key] = val
		}

		_ = d.PG.Audit(c.Request.Context(), userOf(c), "ops_template.run", "ops_template", tpl.ID.String(), map[string]any{
			"cluster_id": clusterID, "template": tpl.Name, "steps": len(steps),
			"variables": scope,
		})

		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		c.Writer.WriteHeader(http.StatusOK)
		c.Writer.Flush()

		flush := func(event string, payload any) {
			b, _ := json.Marshal(payload)
			_, _ = fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, string(b))
			c.Writer.Flush()
		}
		flushLine := func(s string) {
			_, _ = fmt.Fprintf(c.Writer, "event: line\ndata: %s\n\n", s)
			c.Writer.Flush()
		}

		allow := shellAllowedNames()
		// 30m per template run is plenty for any combo of `weed shell`
		// commands the operator would chain interactively. Independent of
		// the per-shell-call timeout inside the seaweed package.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		for i, s := range steps {
			cat, ok := allow[s.Command]
			if !ok {
				flush("step_error", gin.H{"index": i, "error": fmt.Sprintf("command %q not in catalog (catalog changed since template was saved)", s.Command)})
				if !continueOnError {
					flush("done", gin.H{"ok": false})
					return
				}
				continue
			}
			if (cat.Risk == "mutate" || cat.Risk == "destructive") && strings.TrimSpace(s.Reason) == "" {
				// Use the template name + step index so audit still has
				// something meaningful when the operator forgot to set it.
				s.Reason = fmt.Sprintf("ops_template %s step %d", tpl.Name, i+1)
			}

			// Render placeholders against the running scope (declared
			// variables + prior step captures + prior step outputs).
			renderedArgs := substituteArgs(s.Args, scope)
			var args []string
			if a := strings.TrimSpace(renderedArgs); a != "" {
				args = strings.Fields(a)
			}
			flush("step_start", gin.H{"index": i, "command": s.Command, "args": renderedArgs, "streams": cat.Streams})

			var (
				out  string
				rErr error
			)
			if cat.ReadOnly {
				out, rErr = d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, s.Command, args)
				for _, ln := range strings.Split(out, "\n") {
					if ln != "" {
						flushLine(ln)
					}
				}
			} else {
				// Tee streamed output into a buffer too so capture regexes
				// can still run after the step finishes.
				var captureBuf strings.Builder
				teeSink := func(ln string) {
					captureBuf.WriteString(ln)
					captureBuf.WriteByte('\n')
					flushLine(ln)
				}
				out, rErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, s.Command, args, teeSink)
				if out == "" {
					out = captureBuf.String()
				}
			}
			// Make this step's stdout addressable as {{step<N>.output}}
			// and apply any declared captures into the running scope.
			scope[fmt.Sprintf("step%d.output", i+1)] = out
			applyCaptures(i+1, out, s.Capture, scope)
			if rErr != nil {
				flush("step_error", gin.H{"index": i, "error": rErr.Error()})
				if !continueOnError && !s.PauseOnError {
					flush("done", gin.H{"ok": false})
					return
				}
				continue
			}
			flush("step_done", gin.H{"index": i, "ok": true})
		}
		flush("done", gin.H{"ok": true})
	}
}

// draftOpsTemplate uses the configured AI provider to turn a natural
// language description ("create bucket foo with 10GB quota for tenant
// bar") into a structured template draft. The operator reviews and
// edits the draft before saving — the AI output is never auto-persisted.
//
// Reuses the AI provider plumbing introduced for skill drafting.
func draftOpsTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Text string `json:"text"`
		}
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		text := strings.TrimSpace(body.Text)
		if text == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text required"})
			return
		}
		// Operator pasted JSON directly — skip the AI roundtrip.
		if draft, ok := tryParseOpsDraft(text); ok {
			c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "json", "draft": draft})
			return
		}
		// Resolve through the same path as the floating assistant so a
		// provider configured in /ai-config is used (the old code path
		// only saw d.AI, the static-config provider wired at process
		// start, and missed DB-managed defaults entirely).
		provider, provErr := resolveAssistantProvider(c.Request.Context(), d)
		if provErr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "ai", "error": provErr.Error()})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"mode":  "ai",
				"error": "Configured AI provider does not support freeform JSON chat. Paste raw JSON, or pick an OpenAI/Anthropic-compatible provider in /ai-config.",
			})
			return
		}
		// Pull analyzer scripts so the model knows when to insert
		// kind="analyzer" steps. Best-effort: empty list on DB error
		// still produces a usable shell-only draft.
		analyzers, _ := d.PG.ListAnalyzerScripts(c.Request.Context())
		prompt := buildOpsTemplatePromptWith(c.Request.Context(), text, analyzers)
		raw, err := chatter.JSONChat(c.Request.Context(), prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "ai", "error": "AI call failed: " + err.Error()})
			return
		}
		draft, ok := tryParseOpsDraft(extractJSONObject(raw))
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"mode":  "ai",
				"error": "AI did not return a valid template JSON. Try rephrasing.",
				"raw":   raw,
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "ai", "draft": draft})
	}
}

// opsTemplateDraft is the contract the AI must satisfy.
type opsTemplateDraft struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Category    string           `json:"category"`
	Steps       []opsStep        `json:"steps"`
	Variables   []opsTemplateVar `json:"variables,omitempty"`
	// AIPrecheck mirrors the persisted column. The model is asked to
	// set this true for any template containing a mutating step.
	AIPrecheck  *bool            `json:"ai_precheck,omitempty"`
}

func tryParseOpsDraft(text string) (*opsTemplateDraft, bool) {
	var d opsTemplateDraft
	if err := json.Unmarshal([]byte(text), &d); err != nil {
		return nil, false
	}
	if strings.TrimSpace(d.Name) == "" || len(d.Steps) == 0 {
		return nil, false
	}
	allow := shellAllowedNames()
	for i := range d.Steps {
		d.Steps[i].Command = strings.TrimSpace(d.Steps[i].Command)
		// Analyzer steps don't belong to the shell catalog — their
		// "command" is a synthetic label like "analyzer:<script>".
		// Require the analyzer config to be non-empty instead.
		if d.Steps[i].Kind == "analyzer" {
			if d.Steps[i].Analyzer == nil || strings.TrimSpace(d.Steps[i].Analyzer.ScriptName) == "" {
				return nil, false
			}
			if d.Steps[i].Command == "" {
				d.Steps[i].Command = "analyzer:" + d.Steps[i].Analyzer.ScriptName
			}
			continue
		}
		if _, ok := allow[d.Steps[i].Command]; !ok {
			return nil, false
		}
	}
	// Auto-declare any placeholders the model forgot to list under
	// `variables`. The previous behaviour rejected such drafts as
	// invalid, which surfaced to the operator as a vague "AI did not
	// return a valid template JSON" — they'd have no idea what to fix.
	// We now repair the draft and let the form show the operator what
	// was added so they can review/rename.
	d.Variables = autoDeclareMissingVars(d.Variables, d.Steps)
	// After auto-declaration the only remaining failures are illegal
	// stepN.* references; reject those because they can't be repaired
	// by adding a variable.
	if err := validateTemplatePlaceholders(d.Variables, d.Steps); err != nil {
		return nil, false
	}
	if d.Category == "" {
		d.Category = "general"
	}
	return &d, true
}

// buildOpsTemplatePrompt assembles the system+user prompt. We inline the
// command catalog (name + summary + risk) so the model only proposes
// commands the controller actually accepts — and so we can correct it
// when it tries to invent a command name.
func buildOpsTemplatePrompt(ctx context.Context, userText string) string {
	return buildOpsTemplatePromptWith(ctx, userText, nil)
}

// buildOpsTemplatePromptWith is the same as buildOpsTemplatePrompt but
// also embeds the available analyzer-scripts library so the model can
// route deterministic post-processing (top-N node, filter-by-collection,
// shard health, …) through Python instead of hallucinating numbers in
// the AI inference path. Pass nil to skip the section.
func buildOpsTemplatePromptWith(ctx context.Context, userText string, analyzers []store.AnalyzerScript) string {
	var catalogLines strings.Builder
	for _, c := range shellCatalog {
		fmt.Fprintf(&catalogLines, "  - %s (%s, %s): %s\n", c.Name, c.Category, c.Risk, c.Summary)
		// Expose the exact flag names so the model doesn't hallucinate
		// (e.g. inventing -from/-to for volume.move which actually wants
		// -source/-target). Without this the catalog is too thin to ground
		// args generation.
		if len(c.Args) > 0 {
			var flags []string
			for _, a := range c.Args {
				marker := ""
				if a.Required {
					marker = "*"
				}
				if a.Kind != "" {
					flags = append(flags, fmt.Sprintf("%s=<%s>%s", a.Flag, a.Kind, marker))
				} else {
					flags = append(flags, fmt.Sprintf("%s%s", a.Flag, marker))
				}
			}
			fmt.Fprintf(&catalogLines, "      flags: %s\n", strings.Join(flags, " "))
		}
	}
	// Tell the model which language to write the human-readable fields
	// in. The schema keys, command names, and flag syntax stay in English
	// because they're parsed by the controller — only the prose the
	// operator reads (name/description/reason/hint/variable labels)
	// should follow the UI locale.
	langDirective := "Write all human-readable fields (`name`, `description`, every step's `reason`, every `infer_vars[].hint`, and every `variables[].label`) in English."
	if IsZh(ctx) {
		langDirective = "用简体中文撰写所有面向操作员阅读的字段:`name`、`description`、每个步骤的 `reason`、`infer_vars[].hint`、以及 `variables[].label`。注意:JSON 的字段名、`command` 的取值、`args` 中的 `-flag=value` 语法、`variables[].key` 必须保持英文,不要翻译。"
	}
	return fmt.Sprintf(`You convert a SeaweedFS operator's natural-language playbook into a
JSON ops template. Reply ONLY with the JSON object, no markdown, no
prose.

Language: %s

Output schema:
{
  "name": "short kebab-or-snake operator-readable name",
  "description": "one paragraph explaining what this template does and when to run it",
  "category": "bucket|iam|volume|tier|cluster|general",
  "variables": [
    { "key": "bucket_name", "label": "Bucket name", "required": true, "default": "" }
  ],
  "steps": [
    {
      "id": "s1",
      "command": "exact dotted weed shell name from the catalog below",
      "args": "single string of flags, e.g. \"-name={{bucket_name}} -quotaMB={{quota_mb}}\"",
      "reason": "short reason recorded in the audit log",
      "depends_on": [],
      "pause_on_error": false,
      "confirm_before": false,
      "capture": [
        { "as": "owner_id", "regex": "owner:\"([^\"]+)\"" }
      ],
      "infer_vars": [
        { "var": "source_server", "from_step": 1, "hint": "the volume server with the most volumes" }
      ]
    }
  ]
}

Rules:
- Only emit commands that appear in the catalog below. Never invent.
- Use the dotted catalog name verbatim (e.g. "s3.bucket.create", not "create bucket").
- args is a single string in the form weed shell expects: "-flag=value" pairs separated by spaces.
- **Use ONLY the flag names listed under each command's "flags:" line. Never invent flag names. Common mistake to avoid: volume.move uses -source/-target, NOT -from/-to.**
- Flags marked with "*" are required and MUST appear in args. Optional flags may be omitted.
- For values the operator should supply at run time (bucket name, target node, quota, etc.) declare a "variables" entry and reference it as "{{var_key}}" inside args. Use snake_case keys. Prefer placeholders over hard-coding values the operator would obviously want to vary.
- To use the previous step's stdout in args, reference "{{stepN.output}}" or extract a piece via "capture" + "{{stepN.capture.alias}}".
- Every "{{...}}" in args MUST resolve to a declared variable or a prior step's capture/output, otherwise the template is rejected.
- NEVER put "infer_vars" on the FIRST step. The first step has no prior output to read, so AI inference there is impossible. If the operator's intent needs an AI-derived value, the first step must be a read-only command (e.g. "volume.list", "volume.balance" with -force=false) that prints the data, and the "infer_vars" lives on step 2 or later, pointing back at the read step via from_step.
- For values that should be DERIVED from a prior step's output by AI analysis (e.g. "the server with the most volumes", "the volume id that's largest"), do NOT declare a variable — instead:
    1. Reference the placeholder normally in args, e.g. "-from={{source_server}}".
    2. Add an entry to this step's "infer_vars": [{ "var": "source_server", "from_step": <N>, "hint": "human-readable instruction" }].
   The runner pauses before this step, calls the AI to extract the value from step N's stdout, presents it to the operator for review, and proceeds only after explicit human approval.
- Set "confirm_before": true on every step that mutates state (creates/deletes/moves anything). The runner will pause and require an explicit operator approval before executing. Set false on pure read/query steps.
- Every step has a unique "id" (short slug like "s1", "s2"). "depends_on" is the list of step ids that MUST finish before this one runs. An empty depends_on means it runs first / can run in parallel with other root steps.
- PREFER PARALLELISM. If two steps don't actually need each other's output, give them the same depends_on and they will run in parallel. Example: creating two unrelated buckets — both have depends_on=[], they fan out simultaneously. Conversely, if step B references {{stepA.output}} or step A's capture, B's depends_on MUST include A.
- Keep the steps minimal — the operator can add follow-ups later.
- If the user mentions cluster names, hostnames, or things outside weed shell, ignore them; weed shell already knows the cluster context.
- **Prefer analyzer steps over infer_vars whenever the question is deterministic** (top-N node, filter by collection, find largest volume, count by rack, EC shard health). Analyzer steps are Python scripts the platform ships and never hallucinate. Use AI inference (infer_vars) only for fuzzy judgment calls the scripts don't cover.
- An analyzer step looks like this (place between a read step and a mutating step):
    {"id":"s2","kind":"analyzer","depends_on":["s1"],"analyzer":{"script_name":"<one of the names below>","from_step":"s1","params":{"n":"1"}}}
  Downstream steps reference its result via {{s2.analyzer}} (whole JSON), {{s2.analyzer.<key>}} (top-level field), or via capture.
- If you don't know how to express the user's intent with the catalog, return {"name":"","description":"","category":"","steps":[]}.

Catalog (name (category, risk): summary):
%s
%s
User request:
%s
`, langDirective, catalogLines.String(), analyzerSection(analyzers), userText)
}

// analyzerSection renders the available analyzer scripts as a short
// catalog the model can pick from. Empty when no scripts exist or
// the caller didn't pass any — we want the AI prompt to degrade
// gracefully on fresh installs.
func analyzerSection(analyzers []store.AnalyzerScript) string {
	if len(analyzers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nAnalyzer scripts (kind=\"analyzer\" steps; deterministic Python post-processors):\n")
	for _, s := range analyzers {
		if !s.Enabled {
			continue
		}
		fmt.Fprintf(&b, "  - %s — %s", s.Name, s.Title)
		if len(s.ForCommands) > 0 {
			fmt.Fprintf(&b, "  [for: %s]", strings.Join(s.ForCommands, ", "))
		}
		if len(s.Tags) > 0 {
			fmt.Fprintf(&b, "  [tags: %s]", strings.Join(s.Tags, ", "))
		}
		b.WriteByte('\n')
		if s.Description != "" {
			fmt.Fprintf(&b, "      %s\n", s.Description)
		}
		// Surface declared params so the model knows what to fill.
		if len(s.Params) > 0 && string(s.Params) != "[]" {
			fmt.Fprintf(&b, "      params: %s\n", string(s.Params))
		}
	}
	return b.String()
}
