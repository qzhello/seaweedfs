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
type opsStep struct {
	Command      string `json:"command"`
	Args         string `json:"args,omitempty"`
	Reason       string `json:"reason,omitempty"`
	PauseOnError bool   `json:"pause_on_error,omitempty"`
	// Streaming hint mirrors shellCommand.Streams; populated server-side
	// from the catalog so the UI can decide whether to render a per-step
	// streaming tail or wait for the buffered output.
	Streams bool `json:"streams,omitempty"`
}

// listOpsTemplates returns every saved template. Read for any authenticated
// principal so non-admins can at least see what templates exist before
// asking for permission to run one.
func listOpsTemplates(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ts, err := d.PG.ListOpsTemplates(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ts})
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
		c.JSON(http.StatusOK, t)
	}
}

// upsertOpsTemplate validates each step against the shell catalog before
// saving. Catching an unknown command at save time means the operator
// never gets the surprise of a half-completed run failing on step 3
// because they typo'd a command name.
func upsertOpsTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t store.OpsTemplate
		if err := c.BindJSON(&t); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(t.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}
		// Decode steps so we can re-encode after validation (also strips
		// any unknown fields the client snuck in).
		var steps []opsStep
		if len(t.Steps) > 0 {
			if err := json.Unmarshal(t.Steps, &steps); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "steps: " + err.Error()})
				return
			}
		}
		allow := shellAllowedNames()
		clean := make([]opsStep, 0, len(steps))
		for i, s := range steps {
			s.Command = strings.TrimSpace(s.Command)
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
			clean = append(clean, s)
		}
		buf, _ := json.Marshal(clean)
		t.Steps = buf
		id, err := d.PG.UpsertOpsTemplate(c.Request.Context(), t, userOf(c))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "ops_template", id.String(), t)
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
		var steps []opsStep
		if err := json.Unmarshal(tpl.Steps, &steps); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "decode steps: " + err.Error()})
			return
		}

		_ = d.PG.Audit(c.Request.Context(), userOf(c), "ops_template.run", "ops_template", tpl.ID.String(), map[string]any{
			"cluster_id": clusterID, "template": tpl.Name, "steps": len(steps),
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

			var args []string
			if a := strings.TrimSpace(s.Args); a != "" {
				args = strings.Fields(a)
			}
			flush("step_start", gin.H{"index": i, "command": s.Command, "args": s.Args, "streams": cat.Streams})

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
				out, rErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, s.Command, args, flushLine)
				_ = out
			}
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
		chatter, ok := d.AI.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"mode":  "ai",
				"error": "AI provider not configured (provider can't do free-form chat). Paste raw JSON or configure an OpenAI/Anthropic provider.",
			})
			return
		}
		prompt := buildOpsTemplatePrompt(text)
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
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Category    string    `json:"category"`
	Steps       []opsStep `json:"steps"`
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
		if _, ok := allow[d.Steps[i].Command]; !ok {
			return nil, false
		}
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
func buildOpsTemplatePrompt(userText string) string {
	var catalogLines strings.Builder
	for _, c := range shellCatalog {
		fmt.Fprintf(&catalogLines, "  - %s (%s, %s): %s\n", c.Name, c.Category, c.Risk, c.Summary)
	}
	return fmt.Sprintf(`You convert a SeaweedFS operator's natural-language playbook into a
JSON ops template. Reply ONLY with the JSON object, no markdown, no
prose.

Output schema:
{
  "name": "short kebab-or-snake operator-readable name",
  "description": "one paragraph explaining what this template does and when to run it",
  "category": "bucket|iam|volume|tier|cluster|general",
  "steps": [
    {
      "command": "exact dotted weed shell name from the catalog below",
      "args": "single string of flags, e.g. \"-name=foo -quotaMB=10240\"",
      "reason": "short reason recorded in the audit log",
      "pause_on_error": false
    }
  ]
}

Rules:
- Only emit commands that appear in the catalog below. Never invent.
- Use the dotted catalog name verbatim (e.g. "s3.bucket.create", not "create bucket").
- args is a single string in the form weed shell expects: "-flag=value" pairs separated by spaces. Use double quotes inside the string only when needed.
- Keep the steps minimal — the operator can add follow-ups later.
- If the user mentions cluster names, hostnames, or things outside weed shell, ignore them; weed shell already knows the cluster context.
- If you don't know how to express the user's intent with the catalog, return {"name":"","description":"","category":"","steps":[]}.

Catalog (name (category, risk): summary):
%s

User request:
%s
`, catalogLines.String(), userText)
}
