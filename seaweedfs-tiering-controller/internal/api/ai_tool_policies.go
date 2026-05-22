package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// listAIToolPolicies returns the catalogue of registered assistant
// tools with their current policy. We merge the in-code registry
// (the source of truth for risk_level + description) with the DB
// rows (the source of truth for ai_allowed + note), so the UI sees:
//
//   - tools registered in code AND seeded in DB → full row
//   - tools registered in code, not yet in DB → row with ai_allowed=
//     default-from-risk, note="" (operator hasn't touched it yet)
//   - tools in DB but no longer in code → flagged orphan
type aiToolPolicyRow struct {
	ToolName    string `json:"tool_name"`
	Description string `json:"description"`
	RiskLevel   string `json:"risk_level"`
	AIAllowed   bool   `json:"ai_allowed"`
	Note        string `json:"note"`
	UpdatedBy   string `json:"updated_by,omitempty"`
	Orphan      bool   `json:"orphan,omitempty"` // in DB but no code-side tool
}

func listAIToolPoliciesHandler(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		dbRows, err := d.PG.ListAIToolPolicies(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		dbByName := map[string]store.AIToolPolicy{}
		for _, r := range dbRows {
			dbByName[r.ToolName] = r
		}
		tools := assistantToolRegistry()
		seen := map[string]struct{}{}
		out := make([]aiToolPolicyRow, 0, len(tools)+len(dbRows))
		for _, t := range tools {
			seen[t.Spec.Name] = struct{}{}
			db, ok := dbByName[t.Spec.Name]
			if !ok {
				// Tool exists in code but DB has no row yet.
				// Default by risk: read=on, others=off.
				defaultAllowed := t.Risk == ToolRead
				out = append(out, aiToolPolicyRow{
					ToolName:    t.Spec.Name,
					Description: t.Spec.Description,
					RiskLevel:   string(t.Risk),
					AIAllowed:   defaultAllowed,
				})
				continue
			}
			out = append(out, aiToolPolicyRow{
				ToolName:    t.Spec.Name,
				Description: t.Spec.Description,
				RiskLevel:   string(t.Risk),
				AIAllowed:   db.AIAllowed,
				Note:        db.Note,
				UpdatedBy:   db.UpdatedBy,
			})
		}
		// Orphan rows — DB has a policy for a tool the current
		// binary no longer registers. Surface them so operators can
		// clean up; they're never sent to the LLM regardless.
		for name, r := range dbByName {
			if _, ok := seen[name]; ok {
				continue
			}
			out = append(out, aiToolPolicyRow{
				ToolName:  name,
				RiskLevel: r.RiskLevel,
				AIAllowed: r.AIAllowed,
				Note:      r.Note,
				UpdatedBy: r.UpdatedBy,
				Orphan:    true,
			})
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func upsertAIToolPolicyHandler(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			ToolName  string `json:"tool_name"`
			AIAllowed bool   `json:"ai_allowed"`
			Note      string `json:"note"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.ToolName == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "tool_name is required"})
			return
		}
		// Look up the tool's risk in code — operators can't change
		// risk via the UI. This keeps "destructive" tools always
		// surfaced as destructive even if someone tries to relax it.
		var risk ToolRisk
		var found bool
		for _, t := range assistantToolRegistry() {
			if t.Spec.Name == body.ToolName {
				risk = t.Risk
				found = true
				break
			}
		}
		if !found {
			c.JSON(http.StatusBadRequest,
				gin.H{"error": "no such tool registered in this binary: " + body.ToolName})
			return
		}
		var updatedBy string
		if p, ok := auth.Of(c); ok {
			updatedBy = p.Email
		}
		err := d.PG.UpsertAIToolPolicy(c.Request.Context(), store.AIToolPolicy{
			ToolName:  body.ToolName,
			RiskLevel: string(risk),
			AIAllowed: body.AIAllowed,
			Note:      body.Note,
			UpdatedBy: updatedBy,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), updatedBy, "ai.tool.policy",
			"tool", body.ToolName, gin.H{"ai_allowed": body.AIAllowed, "note": body.Note})
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
