package api

// DurabilityScore and the /clusters/score/history endpoint.
//
// DurabilityScore is an exported pure function so that the durability sampler
// in internal/durability can call it without importing internal/api (which
// would create an import cycle).  main.go wires them together via a closure.
//
// Score formula (v1 — data-plane replication health only):
//
//	Start at 100. For each risk category subtract a prevalence-weighted
//	penalty capped at the category weight:
//
//	  penalty(count, total, weight) =
//	      0                                      if count <= 0
//	      min(weight, max(weight*0.2, (count/max(1,total))*weight*5))   otherwise
//
//	  sole_copies          weight 30
//	  under_replicated     weight 18
//	  ec_short_shards      weight 18
//	  over_replicated      weight   6
//
//	Clamp result to [0, 100].
//
// Note: quorum/master availability deductions are intentionally deferred.
// The live master lock-probe is too expensive to run at the 300 s sampling
// cadence without dedicated timeout budget; that signal can be folded in
// once a cheaper master-health cache is available.

import (
	"context"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// DurabilityScore computes a 0..100 durability score for one cluster.
// It returns the score and a map of raw component counts used to populate
// the JSONB `components` column in cluster_score_signals.
//
// Exported so that cmd/controller/main.go can build a ScoreFunc closure
// (injected into internal/durability.Sampler) without causing an import cycle.
func DurabilityScore(ctx context.Context, d Deps, cl *store.Cluster) (float64, map[string]float64, error) {
	rh, err := computeReplicationHealth(ctx, d, cl)
	if err != nil {
		return 0, nil, err
	}

	total := rh.TotalVolumes

	score := 100.0
	score -= prevalencePenalty(rh.SoleCopies, total, 30)
	score -= prevalencePenalty(rh.UnderReplicated, total, 18)
	score -= prevalencePenalty(rh.ECPotentiallyShortShards, total, 18)
	score -= prevalencePenalty(rh.OverReplicated, total, 6)

	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}

	components := map[string]float64{
		"total_volumes":               float64(total),
		"sole_copies":                 float64(rh.SoleCopies),
		"under_replicated":            float64(rh.UnderReplicated),
		"ec_potentially_short_shards": float64(rh.ECPotentiallyShortShards),
		"over_replicated":             float64(rh.OverReplicated),
		"healthy_volumes":             float64(rh.HealthyVolumes),
	}
	return score, components, nil
}

// prevalencePenalty mirrors the frontend `prevalencePenalty` formula:
//
//	count <= 0     → 0
//	otherwise      → min(weight, max(weight*0.2, (count/max(1,total))*weight*5))
func prevalencePenalty(count, total int, weight float64) float64 {
	if count <= 0 {
		return 0
	}
	t := math.Max(1, float64(total))
	raw := (float64(count) / t) * weight * 5
	p := math.Min(weight, math.Max(weight*0.2, raw))
	return math.Round(p)
}

// -------------------- HTTP handler --------------------

// scoreHistoryPoint is one point in the sparkline time series.
type scoreHistoryPoint struct {
	TS    time.Time `json:"ts"`
	Score float64   `json:"score"`
}

type scoreHistoryResp struct {
	Points []scoreHistoryPoint `json:"points"`
}

// scoreHistory handles GET /api/v1/clusters/score/history
//
// Query params:
//
//	range   "1d" | "7d" | "30d"  (default "1d")
//	cluster UUID                  (optional; if absent, average across all clusters)
func scoreHistory(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// --- parse range ---
		since := time.Now().UTC().Add(-24 * time.Hour)
		switch c.Query("range") {
		case "7d":
			since = time.Now().UTC().Add(-7 * 24 * time.Hour)
		case "30d":
			since = time.Now().UTC().Add(-30 * 24 * time.Hour)
		}

		ctx := c.Request.Context()

		// --- single cluster ---
		if clusterParam := c.Query("cluster"); clusterParam != "" {
			clusterID, err := uuid.Parse(clusterParam)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster uuid"})
				return
			}
			rows, err := d.PG.ScoreHistory(ctx, clusterID, since)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			points := make([]scoreHistoryPoint, 0, len(rows))
			for _, r := range rows {
				points = append(points, scoreHistoryPoint{TS: r.SnapshotAt, Score: r.Score})
			}
			c.JSON(http.StatusOK, scoreHistoryResp{Points: points})
			return
		}

		// --- all clusters: fetch every row, average per snapshot_at minute bucket ---
		rows, err := d.PG.AllScoreHistory(ctx, since)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Bucket by truncating to the nearest minute for alignment.
		type bucket struct {
			sum   float64
			count int
		}
		buckets := map[time.Time]*bucket{}
		for _, r := range rows {
			key := r.SnapshotAt.Truncate(time.Minute)
			b, ok := buckets[key]
			if !ok {
				b = &bucket{}
				buckets[key] = b
			}
			b.sum += r.Score
			b.count++
		}

		points := make([]scoreHistoryPoint, 0, len(buckets))
		for ts, b := range buckets {
			avg := b.sum / float64(b.count)
			points = append(points, scoreHistoryPoint{TS: ts, Score: avg})
		}
		sort.Slice(points, func(i, j int) bool {
			return points[i].TS.Before(points[j].TS)
		})

		c.JSON(http.StatusOK, scoreHistoryResp{Points: points})
	}
}
