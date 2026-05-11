package api

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/crypto"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/storage"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/validation"
)

func listBackends(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		bs, err := d.PG.ListBackends(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": bs})
	}
}

type backendUpsertReq struct {
	store.Backend
	// Optional: when set, the cleartext secret is encrypted and stored.
	// When empty on update, the existing ciphertext is preserved.
	SecretAccessKey string `json:"secret_access_key,omitempty"`
}

func upsertBackend(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var r backendUpsertReq
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Re-validate against schema (additionalProperties:false guards typos).
		raw, _ := json.Marshal(map[string]interface{}{
			"kind":             r.Kind,
			"endpoint":         r.Endpoint,
			"region":           r.Region,
			"bucket":           r.Bucket,
			"path_prefix":      r.PathPrefix,
			"encryption":       r.Encryption,
			"force_path_style": r.ForcePathStyle,
			"access_key_ref":   r.AccessKeyID,
			"secret_key_ref":   "",
		})
		var decoded interface{}
		_ = json.Unmarshal(raw, &decoded)
		if err := validation.Default.Validate("storage.backend", decoded); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var secretEnc []byte
		if r.SecretAccessKey != "" {
			enc, err := crypto.FromEnv()
			if err != nil {
				c.JSON(http.StatusFailedDependency,
					gin.H{"error": "TIER_MASTER_KEY not configured; cannot store secret: " + err.Error()})
				return
			}
			ct, err := enc.Seal([]byte(r.SecretAccessKey))
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			secretEnc = ct
		}
		id, err := d.PG.UpsertBackend(c.Request.Context(), r.Backend, secretEnc)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "backend", id.String(),
			gin.H{"name": r.Name, "kind": r.Kind, "with_secret": r.SecretAccessKey != ""})
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteBackend(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteBackend(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "delete", "backend", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// testBackend signs a HEAD-bucket request and reports the result. Records the
// outcome on the backend row so the UI can show last_test_ok without retrying.
func testBackend(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		b, err := d.PG.GetBackendWithSecret(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		secret := ""
		if len(b.SecretEnc) > 0 {
			enc, err := crypto.FromEnv()
			if err != nil {
				c.JSON(http.StatusFailedDependency,
					gin.H{"error": "TIER_MASTER_KEY not configured; cannot decrypt secret"})
				return
			}
			pt, err := enc.Open(b.SecretEnc)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "decrypt: " + err.Error()})
				return
			}
			secret = string(pt)
		}
		testErr := storage.Test(c.Request.Context(), *b, secret)
		ok := testErr == nil
		errMsg := ""
		if testErr != nil {
			errMsg = testErr.Error()
		}
		_ = d.PG.RecordBackendTest(c.Request.Context(), id, ok, errMsg)
		if ok {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		} else {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": errMsg})
		}
	}
}
