package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// alertTemplatePayload is the wire JSON shape for create/update.
type alertTemplatePayload struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	TitleTmpl   string `json:"title_tmpl,omitempty"`
	BodyTmpl    string `json:"body_tmpl,omitempty"`
	Severity    string `json:"severity,omitempty"`
}

func listAlertTemplates(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := d.PG.ListAlertTemplates(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

func getAlertTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		t, err := d.PG.GetAlertTemplate(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, t)
	}
}

func upsertAlertTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body alertTemplatePayload
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}
		t := store.AlertTemplate{
			Name:        body.Name,
			Description: body.Description,
			TitleTmpl:   body.TitleTmpl,
			BodyTmpl:    body.BodyTmpl,
			Severity:    body.Severity,
		}
		if body.ID != "" {
			if parsed, err := uuid.Parse(body.ID); err == nil {
				t.ID = parsed
			}
		}
		id, err := d.PG.UpsertAlertTemplate(c.Request.Context(), t, userOf(c))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "alert_template", id.String(), body)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteAlertTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteAlertTemplate(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "delete", "alert_template", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// previewAlertTemplate renders the title+body of a template with a
// sample variable bag so operators can iterate on their templates
// without firing real notifications. POST body:
//
//	{ "title_tmpl": "...", "body_tmpl": "...", "vars": {...} }
//
// vars merge over a built-in fixture so the operator can override
// just the fields they care about.
func previewAlertTemplate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			TitleTmpl string                 `json:"title_tmpl"`
			BodyTmpl  string                 `json:"body_tmpl"`
			Vars      map[string]interface{} `json:"vars"`
		}
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		v := alertTplVars{
			Template:  "example-flow",
			Cluster:   "prod-east",
			Status:    "failure",
			RunID:     "11111111-1111-1111-1111-111111111111",
			StepID:    "step-3",
			StepIndex: 3,
			Error:     "volume.move timed out after 30s",
			When:      "2026-05-21T10:30:00Z",
		}
		// Operator overrides — only the fields they pass replace fixture values.
		if v2, ok := body.Vars["Template"].(string); ok {
			v.Template = v2
		}
		if v2, ok := body.Vars["Cluster"].(string); ok {
			v.Cluster = v2
		}
		if v2, ok := body.Vars["Status"].(string); ok {
			v.Status = v2
		}
		if v2, ok := body.Vars["Error"].(string); ok {
			v.Error = v2
		}
		c.JSON(http.StatusOK, gin.H{
			"title": executeTmpl(body.TitleTmpl, v),
			"body":  executeTmpl(body.BodyTmpl, v),
		})
	}
}
