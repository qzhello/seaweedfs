package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analyzer"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type analyzerScriptPayload struct {
	ID           string          `json:"id,omitempty"`
	Name         string          `json:"name"`
	Title        string          `json:"title"`
	Description  string          `json:"description,omitempty"`
	ForCommands  []string        `json:"for_commands,omitempty"`
	Tags         []string        `json:"tags,omitempty"`
	Params       json.RawMessage `json:"params,omitempty"`
	Body         string          `json:"body"`
	SampleInput  string          `json:"sample_input,omitempty"`
	SampleOutput json.RawMessage `json:"sample_output,omitempty"`
	Enabled      *bool           `json:"enabled,omitempty"`
}

func listAnalyzerScripts(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := d.PG.ListAnalyzerScripts(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

func getAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		s, err := d.PG.GetAnalyzerScript(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, s)
	}
}

func upsertAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body analyzerScriptPayload
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Body) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name and body required"})
			return
		}
		if strings.TrimSpace(body.Title) == "" {
			body.Title = body.Name
		}
		s := store.AnalyzerScript{
			Name:         body.Name,
			Title:        body.Title,
			Description:  body.Description,
			ForCommands:  body.ForCommands,
			Tags:         body.Tags,
			Params:       body.Params,
			Body:         body.Body,
			SampleInput:  body.SampleInput,
			SampleOutput: body.SampleOutput,
			Enabled:      true,
		}
		if body.Enabled != nil {
			s.Enabled = *body.Enabled
		}
		if body.ID != "" {
			if parsed, err := uuid.Parse(body.ID); err == nil {
				s.ID = parsed
			}
		}
		// Preserve origin on update — operators shouldn't be able to
		// flip a system script to user (or vice-versa) via PUT.
		if s.ID != uuid.Nil {
			cur, err := d.PG.GetAnalyzerScript(c.Request.Context(), s.ID)
			if err == nil {
				s.Origin = cur.Origin
			}
		}
		// Reason label distinguishes "user-edit" from "ai-optimize"
		// in the version history. Optional query param.
		reason := strings.TrimSpace(c.Query("reason"))
		id, err := d.PG.UpsertAnalyzerScript(c.Request.Context(), s, userOf(c), reason)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "analyzer_script", id.String(), body)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		// System scripts are protected — operators can disable but
		// not delete. Prevents accidental loss of the seed library.
		if cur, err := d.PG.GetAnalyzerScript(c.Request.Context(), id); err == nil && cur.Origin == "system" {
			c.JSON(http.StatusForbidden, gin.H{"error": "system scripts cannot be deleted; disable instead"})
			return
		}
		if err := d.PG.DeleteAnalyzerScript(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "delete", "analyzer_script", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// runAnalyzerScript executes a script against operator-supplied input.
// Two modes:
//   1. id provided + persisted body  → look up and run
//   2. ad-hoc body in payload         → sandbox preview, NOT persisted
type runAnalyzerPayload struct {
	ID     string         `json:"id,omitempty"`
	Body   string         `json:"body,omitempty"` // overrides DB body when ad-hoc
	Input  string         `json:"input,omitempty"`
	Params map[string]any `json:"params,omitempty"`
	// Skip writing the run to analyzer_runs. Used by the sandbox so
	// dev iteration doesn't pollute history.
	Ephemeral bool `json:"ephemeral,omitempty"`
}

func runAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body runAnalyzerPayload
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var scriptID uuid.UUID
		src := body.Body
		if body.ID != "" {
			id, err := uuid.Parse(body.ID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
				return
			}
			s, err := d.PG.GetAnalyzerScript(c.Request.Context(), id)
			if err != nil {
				c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
				return
			}
			if !s.Enabled {
				c.JSON(http.StatusBadRequest, gin.H{"error": "script disabled"})
				return
			}
			scriptID = s.ID
			if src == "" {
				src = s.Body
			}
		}
		if strings.TrimSpace(src) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "body required (either via id or inline)"})
			return
		}
		res, err := analyzer.Run(c.Request.Context(), analyzer.Request{
			Body:   src,
			Input:  body.Input,
			Params: body.Params,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Persist run for stored scripts, unless ephemeral.
		if scriptID != uuid.Nil && !body.Ephemeral {
			paramsJSON, _ := json.Marshal(body.Params)
			_, _ = d.PG.InsertAnalyzerRun(c.Request.Context(), store.AnalyzerRun{
				ScriptID:  scriptID,
				Actor:     userOf(c),
				Params:    paramsJSON,
				InputHash: res.InputHash,
				InputSize: res.InputSize,
				OK:        res.OK,
				Error:     res.Error,
				Output:    res.Result,
				ElapsedMs: res.ElapsedMs,
			})
		}
		c.JSON(http.StatusOK, res)
	}
}

func recentAnalyzerRuns(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		limit := 50
		if v := c.Query("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		rows, err := d.PG.RecentAnalyzerRuns(c.Request.Context(), id, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

func listAnalyzerScriptVersions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		items, err := d.PG.ListAnalyzerScriptVersions(c.Request.Context(), id, 30)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

func getAnalyzerScriptVersion(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ver, err := strconv.Atoi(c.Param("version"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad version"})
			return
		}
		v, err := d.PG.GetAnalyzerScriptVersion(c.Request.Context(), id, ver)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, v)
	}
}

// revertAnalyzerScript copies a historical version's body+params
// back into the live row, bumping the version counter (so the
// timeline reads "v5 → v4 → v6" rather than rewriting history).
func revertAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ver, err := strconv.Atoi(c.Param("version"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad version"})
			return
		}
		target, err := d.PG.GetAnalyzerScriptVersion(c.Request.Context(), id, ver)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		cur, err := d.PG.GetAnalyzerScript(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		// Copy historical fields; preserve metadata that shouldn't
		// roll back (name, tags, for_commands, enabled, origin).
		cur.Title = target.Title
		cur.Description = target.Description
		cur.Body = target.Body
		cur.Params = target.Params
		newID, err := d.PG.UpsertAnalyzerScript(c.Request.Context(), *cur, userOf(c),
			fmt.Sprintf("revert-to-v%d", ver))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "revert", "analyzer_script", id.String(),
			map[string]any{"to_version": ver})
		c.JSON(http.StatusOK, gin.H{"id": newID})
	}
}
