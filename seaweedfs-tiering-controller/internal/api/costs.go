package api

// Cost dashboard endpoints + calculator.
//
// Inputs:
//   - backend_pricing rows (operator-curated $/TB and metadata)
//   - cluster topology (`ListVolumesAt`) for actual physical bytes
//   - cost_snapshots for the 12-month chart
//
// Outputs:
//   - per-backend monthly cost
//   - per-collection breakdown
//   - counterfactual cost (all bytes on the hot reference @ 3 replicas)
//   - "unrealised savings" recommendations (cold/frozen volumes still
//     sitting on the hot reference)

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Silence the unused import linter while we still develop — context is
// used in function signatures so this is purely defensive.
var _ = context.Background

const bytesPerTB = float64(1 << 40) // 1024^4

// ---------- pricing CRUD ----------

func listPricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.PG.ListBackendPricing(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

func upsertPricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b store.BackendPricing
		if err := c.ShouldBindJSON(&b); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(b.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
			return
		}
		if b.DisplayName == "" {
			b.DisplayName = b.Name
		}
		if b.Currency == "" {
			b.Currency = "USD"
		}
		if b.Kind == "" {
			b.Kind = "warm"
		}
		if b.ReplicationFactor <= 0 {
			b.ReplicationFactor = 1.0
		}
		if err := d.PG.UpsertBackendPricing(c.Request.Context(), &b); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "pricing.upsert", "pricing", b.ID.String(), map[string]any{
			"name":            b.Name,
			"$_per_tb_month":  b.StoragePricePerTBMonth,
			"hot_reference":   b.IsHotReference,
		})
		c.JSON(http.StatusOK, b)
	}
}

func deletePricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteBackendPricing(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "pricing.delete", "pricing", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// ---------- calculator ----------

// backendBucket is one row of the per-backend cost rollup.
type backendBucket struct {
	Name               string  `json:"name"`
	DisplayName        string  `json:"display_name"`
	Kind               string  `json:"kind"`
	Currency           string  `json:"currency"`
	PhysicalBytes      int64   `json:"physical_bytes"`
	LogicalBytes       int64   `json:"logical_bytes"`
	VolumeCount        int     `json:"volume_count"`
	PricePerTBMonth    float64 `json:"price_per_tb_month"`
	MonthlyCost        float64 `json:"monthly_cost"`
	CounterfactualCost float64 `json:"counterfactual_cost"`
	HasPricing         bool    `json:"has_pricing"`
}

// collectionRow is one row of the per-collection cost rollup.
type collectionRow struct {
	Collection      string  `json:"collection"`
	PhysicalBytes   int64   `json:"physical_bytes"`
	MonthlyCost     float64 `json:"monthly_cost"`
	ByBackendBytes  map[string]int64   `json:"by_backend_bytes"`
	ByBackendCost   map[string]float64 `json:"by_backend_cost"`
}

// recommendation surfaces a single "you could save $X" suggestion. The
// AI planner endpoint reads the same shape; the dashboard renders them
// inline.
type costRecommendation struct {
	Kind            string  `json:"kind"` // tier_collection|tier_volume
	Collection      string  `json:"collection,omitempty"`
	VolumeID        uint32  `json:"volume_id,omitempty"`
	FromBackend     string  `json:"from_backend"`
	ToBackend       string  `json:"to_backend"`
	Bytes           int64   `json:"bytes"`
	MonthlySaving   float64 `json:"monthly_saving"`
	Currency        string  `json:"currency"`
	Rationale       string  `json:"rationale"`
}

type costsResponse struct {
	ClusterID            string               `json:"cluster_id"`
	GeneratedAt          time.Time            `json:"generated_at"`
	Currency             string               `json:"currency"`
	TotalMonthlyCost     float64              `json:"total_monthly_cost"`
	CounterfactualCost   float64              `json:"counterfactual_cost"`
	MonthlySaving        float64              `json:"monthly_saving"`
	UnpricedBytes        int64                `json:"unpriced_bytes"`
	HotReferenceBackend  string               `json:"hot_reference_backend"`
	Backends             []backendBucket      `json:"backends"`
	TopCollections       []collectionRow      `json:"top_collections"`
	Recommendations      []costRecommendation `json:"recommendations"`
}

// bucketBackend maps a topology row to the pricing row's `name` field.
// Cloud-tiered volumes carry RemoteStorageName; local volumes fall
// back to "local-<DiskType>" (matching the seed migration).
func bucketBackend(v seaweed.VolumeInfo) string {
	if name := strings.TrimSpace(v.RemoteStorageName); name != "" {
		return name
	}
	dt := strings.TrimSpace(v.DiskType)
	if dt == "" {
		return "local"
	}
	return "local-" + dt
}

// computeCosts walks the topology, joins against pricing rows, and
// returns the dashboard payload. The counterfactual assumes:
//
//	"every byte we store today, instead lives on the hot reference
//	 backend, replicated 3x"
//
// We use logical bytes (one copy per volume) × 3 for that — so an EC
// 10+4 volume that's 14GB physical / 10GB logical contributes 30GB to
// the counterfactual, not 42GB. The EC overhead conversion uses 1.4
// as the canonical SeaweedFS default ratio when we detect an EC row.
func computeCosts(ctx context.Context, d Deps, clusterID uuid.UUID) (*costsResponse, error) {
	cl, err := d.PG.GetCluster(ctx, clusterID)
	if err != nil {
		return nil, fmt.Errorf("cluster lookup: %w", err)
	}
	prices, err := d.PG.ListBackendPricing(ctx)
	if err != nil {
		return nil, fmt.Errorf("list pricing: %w", err)
	}
	priceByName := map[string]store.BackendPricing{}
	for _, p := range prices {
		priceByName[p.Name] = p
	}
	hotRef, _ := d.PG.HotReferencePricing(ctx)

	vols, err := d.Sw.ListVolumesAt(ctx, cl.MasterAddr)
	if err != nil {
		return nil, fmt.Errorf("topology: %w", err)
	}

	// Pass 1: dedupe by volume_id to get logical bytes (one-copy
	// equivalent). We pick the largest single-row size for non-EC
	// volumes (one replica's worth); for EC we sum the row sizes and
	// divide by the canonical 1.4 expansion factor.
	type volAgg struct {
		IsEC        bool
		Collection  string
		Backend     string // sampled from any row — all rows share these
		Replicas    int
		PhysBytes   int64 // sum across all topology rows
		MaxReplica  int64 // largest single-row size
	}
	agg := map[uint32]*volAgg{}
	for _, v := range vols {
		a, ok := agg[v.ID]
		if !ok {
			a = &volAgg{
				IsEC:       v.IsEC,
				Collection: v.Collection,
				Backend:    bucketBackend(v),
			}
			agg[v.ID] = a
		}
		a.Replicas++
		a.PhysBytes += int64(v.Size)
		if int64(v.Size) > a.MaxReplica {
			a.MaxReplica = int64(v.Size)
		}
	}

	// Pass 2: bucket into backends. Cost per backend uses physical
	// bytes (what you're charged for); counterfactual uses logical
	// bytes × 3 × hot_reference_$/TB.
	buckets := map[string]*backendBucket{}
	colls := map[string]*collectionRow{}
	var unpriced int64
	var totalCost, counterfactual float64
	currency := "USD"
	if hotRef != nil {
		currency = hotRef.Currency
	}

	for _, a := range agg {
		// Cost contribution.
		bb := buckets[a.Backend]
		if bb == nil {
			price, has := priceByName[a.Backend]
			bb = &backendBucket{
				Name:        a.Backend,
				DisplayName: a.Backend,
				HasPricing:  has,
			}
			if has {
				bb.DisplayName = price.DisplayName
				bb.Kind = price.Kind
				bb.Currency = price.Currency
				bb.PricePerTBMonth = price.StoragePricePerTBMonth
			} else {
				bb.Currency = currency
			}
			buckets[a.Backend] = bb
		}
		bb.PhysicalBytes += a.PhysBytes
		bb.VolumeCount++

		// Logical bytes — for EC we back out the 1.4x expansion; for
		// regular volumes one replica's worth is logical.
		var logical int64
		if a.IsEC {
			// SeaweedFS default EC is 10+4 → 14/10 = 1.4 expansion.
			logical = int64(math.Round(float64(a.PhysBytes) / 1.4))
		} else {
			logical = a.MaxReplica
		}
		bb.LogicalBytes += logical

		// Apply cost only when we have pricing for this bucket. The
		// dashboard separately surfaces unpriced bytes so operators
		// know what to seed in /pricing.
		if bb.HasPricing {
			cost := float64(a.PhysBytes) / bytesPerTB * bb.PricePerTBMonth
			bb.MonthlyCost += cost
			totalCost += cost

			// Per-collection rollup needs the same per-volume cost.
			cr := colls[a.Collection]
			if cr == nil {
				cr = &collectionRow{
					Collection:     a.Collection,
					ByBackendBytes: map[string]int64{},
					ByBackendCost:  map[string]float64{},
				}
				colls[a.Collection] = cr
			}
			cr.PhysicalBytes += a.PhysBytes
			cr.MonthlyCost += cost
			cr.ByBackendBytes[a.Backend] += a.PhysBytes
			cr.ByBackendCost[a.Backend] += cost
		} else {
			unpriced += a.PhysBytes
		}

		// Counterfactual contribution.
		if hotRef != nil {
			cf := float64(logical) * 3.0 / bytesPerTB * hotRef.StoragePricePerTBMonth
			bb.CounterfactualCost += cf
			counterfactual += cf
		}
	}

	// Stable orderings — backends by spend desc, collections by spend
	// desc (truncated to top 25 to keep the response small; the AI
	// planner does its own scan over the full topology if needed).
	bucketList := make([]backendBucket, 0, len(buckets))
	for _, b := range buckets {
		bucketList = append(bucketList, *b)
	}
	sort.Slice(bucketList, func(i, j int) bool { return bucketList[i].MonthlyCost > bucketList[j].MonthlyCost })

	collList := make([]collectionRow, 0, len(colls))
	for _, c := range colls {
		collList = append(collList, *c)
	}
	sort.Slice(collList, func(i, j int) bool { return collList[i].MonthlyCost > collList[j].MonthlyCost })
	if len(collList) > 25 {
		collList = collList[:25]
	}

	// Recommendations — for any collection whose volumes sit on the
	// hot reference but whose latest temperature features say they're
	// cold/frozen, surface the projected saving if moved to the
	// cheapest non-hot-reference backend of kind warm/cold.
	recs := buildRecommendations(ctx, d, hotRef, prices)

	out := &costsResponse{
		ClusterID:           clusterID.String(),
		GeneratedAt:         time.Now(),
		Currency:            currency,
		TotalMonthlyCost:    totalCost,
		CounterfactualCost:  counterfactual,
		MonthlySaving:       counterfactual - totalCost,
		UnpricedBytes:       unpriced,
		Backends:            bucketList,
		TopCollections:      collList,
		Recommendations:     recs,
	}
	if hotRef != nil {
		out.HotReferenceBackend = hotRef.Name
	}
	return out, nil
}

// buildRecommendations cross-references the temperature features with
// pricing to find unrealised savings. Each recommendation says: "this
// many bytes of <collection> are cold but still on <hot ref>; tier
// them to <cheapest cold backend> to save $X/month."
//
// Best-effort: if features haven't been populated yet, returns empty.
func buildRecommendations(ctx context.Context, d Deps, hotRef *store.BackendPricing, prices []store.BackendPricing) []costRecommendation {
	if hotRef == nil || d.CH == nil {
		return nil
	}
	temps, err := d.CH.CollectionTemperatures(ctx)
	if err != nil || len(temps) == 0 {
		return nil
	}
	// Pick the cheapest non-hot-reference backend per target kind. We
	// suggest "warm" for cool/cold, "cold/archive" for frozen.
	var warmTarget, coldTarget *store.BackendPricing
	for i, p := range prices {
		if p.IsHotReference {
			continue
		}
		switch p.Kind {
		case "warm":
			if warmTarget == nil || p.StoragePricePerTBMonth < warmTarget.StoragePricePerTBMonth {
				warmTarget = &prices[i]
			}
		case "cold", "archive":
			if coldTarget == nil || p.StoragePricePerTBMonth < coldTarget.StoragePricePerTBMonth {
				coldTarget = &prices[i]
			}
		}
	}

	out := []costRecommendation{}
	for _, t := range temps {
		// Cool/cold ⇒ warm tier. Frozen ⇒ cold tier (if available).
		if (t.CoolN+t.ColdN) > 0 && warmTarget != nil {
			b := int64(t.CoolSize + t.ColdSize)
			saving := float64(b) / bytesPerTB * (hotRef.StoragePricePerTBMonth - warmTarget.StoragePricePerTBMonth) * 3
			if saving > 0 {
				out = append(out, costRecommendation{
					Kind:          "tier_collection",
					Collection:    t.Collection,
					FromBackend:   hotRef.Name,
					ToBackend:     warmTarget.Name,
					Bytes:         b,
					MonthlySaving: saving,
					Currency:      hotRef.Currency,
					Rationale: fmt.Sprintf(
						"%d cool + %d cold volume(s) in this collection. Moving to %s saves $%.2f/mo at current pricing.",
						t.CoolN, t.ColdN, warmTarget.DisplayName, saving),
				})
			}
		}
		if t.FrozenN > 0 && coldTarget != nil {
			b := int64(t.FrozenSize)
			saving := float64(b) / bytesPerTB * (hotRef.StoragePricePerTBMonth - coldTarget.StoragePricePerTBMonth) * 3
			if saving > 0 {
				out = append(out, costRecommendation{
					Kind:          "tier_collection",
					Collection:    t.Collection,
					FromBackend:   hotRef.Name,
					ToBackend:     coldTarget.Name,
					Bytes:         b,
					MonthlySaving: saving,
					Currency:      hotRef.Currency,
					Rationale: fmt.Sprintf(
						"%d frozen volume(s) untouched ≥90d. Archive to %s saves $%.2f/mo.",
						t.FrozenN, coldTarget.DisplayName, saving),
				})
			}
		}
	}
	// Sort by saving desc, cap to top 10.
	sort.Slice(out, func(i, j int) bool { return out[i].MonthlySaving > out[j].MonthlySaving })
	if len(out) > 10 {
		out = out[:10]
	}
	return out
}

// ---------- HTTP endpoints ----------

func getCurrentCosts(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Query("cluster_id")
		if idStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		out, err := computeCosts(c.Request.Context(), d, id)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func snapshotCosts(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Query("cluster_id")
		if idStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		out, err := computeCosts(c.Request.Context(), d, id)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		ym := firstOfMonth(time.Now())
		snaps := make([]store.CostSnapshot, 0, len(out.Backends))
		for _, b := range out.Backends {
			snaps = append(snaps, store.CostSnapshot{
				ClusterID:          id,
				BackendName:        b.Name,
				YearMonth:          ym,
				PhysicalBytes:      b.PhysicalBytes,
				LogicalBytes:       b.LogicalBytes,
				CostEstimate:       b.MonthlyCost,
				CounterfactualCost: b.CounterfactualCost,
				Currency:           b.Currency,
			})
		}
		if err := d.PG.UpsertCostSnapshots(c.Request.Context(), snaps); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "cost.snapshot", "cluster", id.String(), gin.H{
			"month":            ym.Format("2006-01"),
			"total_cost":       out.TotalMonthlyCost,
			"counterfactual":   out.CounterfactualCost,
			"backends_recorded": len(snaps),
		})
		c.JSON(http.StatusOK, gin.H{"snapshots": snaps, "month": ym.Format("2006-01")})
	}
}

func getCostHistory(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Query("cluster_id")
		if idStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		months := 12
		if s := c.Query("months"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 36 {
				months = n
			}
		}
		rows, err := d.PG.ListCostSnapshots(c.Request.Context(), id, months)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows, "months": months})
	}
}

func firstOfMonth(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
}
