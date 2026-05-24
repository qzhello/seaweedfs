package api

// Identity key-rotation reminder.
//
// SeaweedFS's identity model stores no creation/rotation timestamp:
// `s3.configure -list` returns name + credentials + actions, nothing
// temporal. So "when was this access key last rotated?" has to come
// from our own audit log — every controller-mediated upsert leaves
// an `s3.identity.upsert` row with the user name in the payload.
//
// Limitations (surfaced honestly in the response):
//   - Identities edited directly via `weed shell` (bypassing the
//     controller) have no audit trail → reported as `status: "unknown"`.
//   - The audit log captures *any* upsert, not specifically a secret-key
//     rotation; an actions-only edit still updates `last_rotated_at`.
//     This is a conservative bias toward "looks fresh" — the reminder
//     under-counts staleness rather than over-counts.

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	defaultRotationThresholdDays = 180
	maxRotationThresholdDays     = 3650 // 10 years — sanity cap
)

type identityRotationStatus string

const (
	rotationOK      identityRotationStatus = "ok"
	rotationStale   identityRotationStatus = "stale"
	rotationUnknown identityRotationStatus = "unknown"
)

type identityRotationRow struct {
	Name           string                 `json:"name"`
	AccessKeyCount int                    `json:"access_key_count"`
	LastRotatedAt  *time.Time             `json:"last_rotated_at,omitempty"`
	AgeDays        *int                   `json:"age_days,omitempty"`
	Status         identityRotationStatus `json:"status"`
}

type identityRotationResp struct {
	ThresholdDays int                   `json:"threshold_days"`
	Total         int                   `json:"total"`
	StaleCount    int                   `json:"stale_count"`
	UnknownCount  int                   `json:"unknown_count"`
	WithoutKeys   int                   `json:"without_keys"`
	Identities    []identityRotationRow `json:"identities"`
}

// s3IdentityRotation handles GET /clusters/:id/s3/identities/rotation?threshold=180
// Read-only. Combines `s3.configure -list` (current identities) with
// our audit_log (last upsert per user) to surface stale access keys.
func s3IdentityRotation(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		threshold := defaultRotationThresholdDays
		if q := c.Query("threshold"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n > 0 && n <= maxRotationThresholdDays {
				threshold = n
			}
		}

		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		raw, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "s3.configure", []string{"-list"})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": raw})
			return
		}
		cfg, perr := parseS3Config(raw)
		if perr != nil {
			c.JSON(http.StatusOK, identityRotationResp{ThresholdDays: threshold, Identities: []identityRotationRow{}})
			return
		}

		lastSeen, err := d.PG.LastS3IdentityUpserts(c.Request.Context(), clusterID.String())
		if err != nil {
			// Don't fail the whole call — degrade to "everything unknown".
			lastSeen = map[string]time.Time{}
		}

		now := time.Now()
		out := identityRotationResp{
			ThresholdDays: threshold,
			Identities:    make([]identityRotationRow, 0, len(cfg.Identities)),
		}
		for _, id := range cfg.Identities {
			row := identityRotationRow{
				Name:           id.Name,
				AccessKeyCount: len(id.Credentials),
			}
			// Identities with no access keys can't have a stale secret — they
			// might be service accounts or placeholders. Count separately so
			// the summary isn't skewed.
			if row.AccessKeyCount == 0 {
				row.Status = rotationOK
				out.WithoutKeys++
			} else if t, ok := lastSeen[id.Name]; ok {
				age := int(now.Sub(t).Hours() / 24)
				row.LastRotatedAt = &t
				row.AgeDays = &age
				if age >= threshold {
					row.Status = rotationStale
					out.StaleCount++
				} else {
					row.Status = rotationOK
				}
			} else {
				row.Status = rotationUnknown
				out.UnknownCount++
			}
			out.Identities = append(out.Identities, row)
		}
		out.Total = len(out.Identities)
		c.JSON(http.StatusOK, out)
	}
}
