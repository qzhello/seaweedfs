package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/aireview"
)

// getTaskReview returns the latest AI review (with rounds) for a task. Empty
// 404 when no review has run yet — the UI renders a "Run AI review" CTA.
func getTaskReview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad task id"})
			return
		}
		review, rounds, err := d.PG.GetReviewWithRounds(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "no review yet"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"review": review, "rounds": rounds})
	}
}

// runTaskReview triggers a fresh 3-round review synchronously. Admin-only.
// The volume features and cohort context are pulled from CH so prompts have
// the latest data.
func runTaskReview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if d.AIReview == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai review not configured"})
			return
		}
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad task id"})
			return
		}
		task, err := d.PG.GetTask(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
			return
		}

		// Build inputs. Cohort + pattern context are best-effort — if they
		// aren't loaded yet (fresh deployment), the orchestrator still has
		// rule-based features to reason from.
		inputs := aireview.Inputs{
			TaskID:      task.ID,
			VolumeID:    uint32(task.VolumeID),
			Collection:  task.Collection,
			Action:      task.Action,
			Score:       task.Score,
			Explanation: task.Explanation,
		}
		if pat, perr := d.CH.LatestPattern(c.Request.Context(), uint32(task.VolumeID)); perr == nil {
			inputs.BusinessDomain = pat.BusinessDomain
			inputs.PatternContext = formatPattern(pat.CycleKind, pat.ACF24h, pat.ACF168h, pat.CohortZReads)
			inputs.CohortContext = formatCohort(pat.BusinessDomain, pat.Reads7d, pat.ReadsPerByte7d)
		}
		// Decode features JSON into the map shape the orchestrator expects.
		inputs.Features = map[string]float64{}
		if len(task.Features) > 0 {
			_ = json.Unmarshal(task.Features, &inputs.Features)
		}

		reviewID, verdict, runErr := d.AIReview.Run(c.Request.Context(), inputs)
		if runErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{
				"error": runErr.Error(), "review_id": reviewID, "verdict": verdict,
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"review_id": reviewID, "verdict": verdict})
	}
}

func formatPattern(kind string, acf24, acf168, z float32) string {
	return fmt.Sprintf("cycle=%s acf24=%.2f acf168=%.2f z=%.2f", kind, acf24, acf168, z)
}

func formatCohort(domain string, reads uint64, readsPerByte float64) string {
	return fmt.Sprintf("domain=%s reads_7d=%d reads_per_byte=%.3e", domain, reads, readsPerByte)
}
