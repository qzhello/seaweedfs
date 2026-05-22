package api

// Create a Task directly from an AI migration proposal. The Costs and
// Path-migrate dashboards both surface AI-drafted proposals; before
// this endpoint the only path forward was "Open in Ops console" (run
// the shell command manually) or "Save as template" (long-form
// workflow). Operators with cost.write + admin can now skip both and
// land a `pending` Task that goes through the normal approve → run
// pipeline.
//
// Volume ID is required because Task is volume-scoped. The proposal
// doesn't carry one (AI works at the collection level), so the caller
// either picks the top candidate volume from the temperature data or
// supplies it explicitly. We accept either flow:
//   - body.volume_id is set → trust it
//   - body.volume_id == 0  → pick the largest cool/cold volume in the
//     proposal's collection from the latest VolumeFeatures snapshot
//
// We never auto-approve. The resulting task lands in `pending` so the
// normal review gates still apply.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func createTaskFromProposal(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			ClusterID      string  `json:"cluster_id"`
			Title          string  `json:"title"`
			Collection     string  `json:"collection"`
			FromBackend    string  `json:"from_backend"`
			ToBackend      string  `json:"to_backend"`
			TaskCommand    string  `json:"task_command"`
			Rationale      string  `json:"rationale"`
			MonthlySaving  float64 `json:"monthly_saving"`
			Currency       string  `json:"currency"`
			Risk           string  `json:"risk"`
			Confidence     string  `json:"confidence"`
			Bytes          int64   `json:"bytes"`
			VolumeID       int32   `json:"volume_id,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(body.ClusterID) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		clusterID, err := uuid.Parse(body.ClusterID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// Resolve volume if missing — pick the largest tier-move
		// candidate in the collection. We use the live topology so we
		// don't depend on features being populated.
		volumeID := body.VolumeID
		if volumeID == 0 {
			vols, err := d.Sw.ListVolumesAt(c.Request.Context(), cl.MasterAddr)
			if err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": "topology: " + err.Error()})
				return
			}
			var bestID uint32
			var bestSize uint64
			for _, v := range vols {
				if v.IsEC {
					continue
				}
				if body.Collection != "" && body.Collection != "(default)" && v.Collection != body.Collection {
					continue
				}
				if body.Collection == "(default)" && v.Collection != "" {
					continue
				}
				if v.Size > bestSize {
					bestSize = v.Size
					bestID = v.ID
				}
			}
			if bestID == 0 {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "no candidate volume found in collection; supply volume_id explicitly",
				})
				return
			}
			volumeID = int32(bestID)
		}

		// `target` is a JSON blob the executor will read to know where
		// to migrate. Shape matches the existing tier.move actions —
		// kind tells the executor what to do; metadata travels for the
		// audit trail and for the AI postmortem.
		target := map[string]any{
			"kind":         "ai_proposal",
			"to_backend":   body.ToBackend,
			"from_backend": body.FromBackend,
			"task_command": body.TaskCommand,
			"created_by":   "ai_proposal",
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		}
		targetJSON, _ := json.Marshal(target)

		// Features blob preserves the AI's reasoning so postmortem
		// reviewers can see what numbers drove the recommendation.
		features := map[string]any{
			"rationale":         body.Rationale,
			"monthly_saving":    body.MonthlySaving,
			"currency":          body.Currency,
			"risk":              body.Risk,
			"confidence":        body.Confidence,
			"bytes_in_scope":    body.Bytes,
		}
		featuresJSON, _ := json.Marshal(features)

		// Idempotency key prevents accidental double-creation when an
		// operator clicks "Create as Task" twice. Cluster+volume+action
		// is enough; the existing partial unique index will catch dupes.
		idemp := fmt.Sprintf("ai-proposal:%s:%d:%s", clusterID, volumeID, body.ToBackend)

		title := strings.TrimSpace(body.Title)
		if title == "" {
			title = fmt.Sprintf("AI: tier %s to %s", body.Collection, body.ToBackend)
		}

		t := store.Task{
			VolumeID:       volumeID,
			Collection:     body.Collection,
			Action:         "tier.move",
			Target:         targetJSON,
			Score:          1.0, // AI proposals are operator-curated; not scored by the scheduler
			Features:       featuresJSON,
			Explanation:    fmt.Sprintf("[AI proposal] %s — %s\n\nRationale: %s", title, body.TaskCommand, body.Rationale),
			Status:         "pending",
			IdempotencyKey: idemp,
		}
		// business_domain is a Postgres enum; the domain is unknown for
		// AI proposals — pass nil (NULL), never "" (an invalid enum value).
		taskID, err := d.PG.InsertTaskWithCluster(c.Request.Context(), t, &clusterID, nil)
		if err != nil {
			if err == store.ErrDuplicateTask {
				c.JSON(http.StatusConflict, gin.H{
					"error":           "an active task already exists for this volume+target",
					"idempotency_key": idemp,
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "task.create_from_proposal", "task", taskID.String(), gin.H{
			"cluster_id":     clusterID.String(),
			"volume_id":      volumeID,
			"collection":     body.Collection,
			"to_backend":     body.ToBackend,
			"monthly_saving": body.MonthlySaving,
		})
		c.JSON(http.StatusCreated, gin.H{"id": taskID, "status": "pending"})
	}
}
