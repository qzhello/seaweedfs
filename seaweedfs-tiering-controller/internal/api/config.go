package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/validation"
)

// cfgSchemaSet holds compiled jsonschemas for system_config.schema entries.
// Populated lazily; safe for concurrent use.
var cfgSchemaSet = validation.NewSchemaSet()

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// listConfig returns all config entries grouped by group_name. Sensitive
// values are masked unless the caller is admin (v1 every authenticated
// caller is admin; the masking still runs through so wiring is ready for v2).
func listConfig(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		entries, err := d.PG.ListConfig(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		grouped := map[string][]store.ConfigEntry{}
		for _, e := range entries {
			if e.IsSensitive {
				e.Value = json.RawMessage(`"***"`)
			}
			grouped[e.Group] = append(grouped[e.Group], e)
		}
		c.JSON(http.StatusOK, gin.H{"groups": grouped})
	}
}

func updateConfig(d Deps) gin.HandlerFunc {
	type req struct {
		Value           json.RawMessage `json:"value" binding:"required"`
		ExpectedVersion int             `json:"expected_version"`
		Note            string          `json:"note"`
	}
	return func(c *gin.Context) {
		key := c.Param("key")
		if key == "" || strings.ContainsAny(key, " \t\n;") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad key"})
			return
		}
		var r req
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Look up entry to check schema + freshness.
		cur, err := d.PG.GetConfig(c.Request.Context(), key)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if r.ExpectedVersion == 0 {
			r.ExpectedVersion = cur.Version
		}
		if err := validateAgainstSchema(cur.Schema, r.Value); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "schema: " + err.Error()})
			return
		}
		if err := d.PG.SetConfig(c.Request.Context(), key, r.Value, r.ExpectedVersion, userOf(c)); err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "set_config", "config", key,
			gin.H{"old": cur.Value, "new": r.Value, "note": r.Note})
		c.JSON(http.StatusOK, gin.H{"ok": true, "is_hot": cur.IsHot})
	}
}

func configHistory(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.Param("key")
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
		hs, err := d.PG.ConfigHistory(c.Request.Context(), key, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": hs})
	}
}

func rollbackConfig(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.Param("key")
		idStr := c.Param("history_id")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad history_id"})
			return
		}
		if err := d.PG.RollbackConfig(c.Request.Context(), key, id, userOf(c)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "rollback_config", "config", key,
			gin.H{"to_history": id})
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// validateAgainstSchema validates `value` against an inline JSON Schema. The
// schema is read from system_config.schema; if empty, the value is accepted.
// Uses the package-level jsonschema compiler; schemas are compiled on first
// use and cached by their stringified form to avoid repeated work.
func validateAgainstSchema(schema, value json.RawMessage) error {
	if len(schema) == 0 || string(schema) == "{}" || string(schema) == "null" {
		return nil
	}
	var decodedValue interface{}
	if err := json.Unmarshal(value, &decodedValue); err != nil {
		return fmt.Errorf("value: invalid json: %w", err)
	}
	// Compile per-call (cheap; jsonschema lib pools internally). Adding a cache
	// keyed by sha256(schema) is a follow-up if profiling demands.
	cacheKey := "system_config:" + sha256Hex(schema)
	cfgSchemaSet.RegisterIfMissing(cacheKey, string(schema))
	return cfgSchemaSet.Validate(cacheKey, decodedValue)
}
