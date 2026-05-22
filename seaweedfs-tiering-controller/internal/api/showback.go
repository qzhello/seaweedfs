package api

// Cost showback — attribute monthly storage spend to the responsible
// person (bucket_governance.owner_name) and to the business domain
// (cluster default, overridden by resource_tags). Answers "what does
// each team's storage cost?".
//
//	GET /costs/showback?cluster_id=X
//
// The per-collection cost pass is a deliberately lean subset of
// computeCosts (costs.go): just physical bytes × backend price. It is
// kept separate so the shared cost endpoints stay untouched, and because
// showback needs EVERY collection (computeCosts truncates to the top 25).

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// showbackGroup is one attribution bucket — an owner or a domain.
type showbackGroup struct {
	Key           string  `json:"key"` // owner name, domain, or "(unassigned)"
	Buckets       int     `json:"buckets"`
	PhysicalBytes int64   `json:"physical_bytes"`
	MonthlyCost   float64 `json:"monthly_cost"`
}

type showbackResponse struct {
	ClusterID        string          `json:"cluster_id"`
	GeneratedAt      time.Time       `json:"generated_at"`
	Currency         string          `json:"currency"`
	TotalMonthlyCost float64         `json:"total_monthly_cost"`
	TotalBytes       int64           `json:"total_bytes"`
	UnpricedBytes    int64           `json:"unpriced_bytes"`
	ByOwner          []showbackGroup `json:"by_owner"`
	ByDomain         []showbackGroup `json:"by_domain"`
}

const showbackUnassigned = "(unassigned)"

func getShowback(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Query("cluster_id")
		if idStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		clusterID, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		out, err := computeShowback(c.Request.Context(), d, clusterID)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func computeShowback(ctx context.Context, d Deps, clusterID uuid.UUID) (*showbackResponse, error) {
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
	currency := "USD"
	if hot, _ := d.PG.HotReferencePricing(ctx); hot != nil {
		currency = hot.Currency
	}

	vols, err := d.Sw.ListVolumesAt(ctx, cl.MasterAddr)
	if err != nil {
		return nil, fmt.Errorf("topology: %w", err)
	}

	// Dedupe by volume_id — all of a volume's topology rows share the
	// same collection + backend; physical bytes sum across replicas.
	type volAgg struct {
		collection string
		backend    string
		phys       int64
	}
	agg := map[uint32]*volAgg{}
	for _, v := range vols {
		a := agg[v.ID]
		if a == nil {
			a = &volAgg{collection: v.Collection, backend: bucketBackend(v)}
			agg[v.ID] = a
		}
		a.phys += int64(v.Size)
	}

	// Per-collection physical bytes + monthly cost.
	type collCost struct {
		bytes int64
		cost  float64
	}
	colls := map[string]*collCost{}
	var unpriced, totalBytes int64
	var totalCost float64
	for _, a := range agg {
		cc := colls[a.collection]
		if cc == nil {
			cc = &collCost{}
			colls[a.collection] = cc
		}
		cc.bytes += a.phys
		totalBytes += a.phys
		if price, has := priceByName[a.backend]; has {
			cost := float64(a.phys) / bytesPerTB * price.StoragePricePerTBMonth
			cc.cost += cost
			totalCost += cost
		} else {
			unpriced += a.phys
		}
	}

	// Ownership — bucket_governance is keyed by bucket name, and a
	// SeaweedFS S3 bucket's name IS its collection name.
	gov, _ := d.PG.ListBucketGovernance(ctx, clusterID)

	// Domain — resource_tags scoped to a bucket/collection override the
	// cluster's default business_domain.
	domainByScope := map[string]string{}
	if tags, terr := d.PG.ListTags(ctx, clusterID); terr == nil {
		for _, tg := range tags {
			switch strings.ToLower(tg.ScopeKind) {
			case "bucket", "collection":
				if v := tg.ScopeValue; v != "" && v != "*" && tg.BusinessDomain != "" {
					domainByScope[v] = tg.BusinessDomain
				}
			}
		}
	}
	defaultDomain := cl.BusinessDomain
	if defaultDomain == "" {
		defaultDomain = "other"
	}

	ownerAgg := map[string]*showbackGroup{}
	domainAgg := map[string]*showbackGroup{}
	for coll, cc := range colls {
		owner := showbackUnassigned
		if g, ok := gov[coll]; ok && strings.TrimSpace(g.OwnerName) != "" {
			owner = g.OwnerName
		}
		domain := defaultDomain
		if dm, ok := domainByScope[coll]; ok {
			domain = dm
		}
		addShowback(ownerAgg, owner, cc.bytes, cc.cost)
		addShowback(domainAgg, domain, cc.bytes, cc.cost)
	}

	return &showbackResponse{
		ClusterID:        clusterID.String(),
		GeneratedAt:      time.Now(),
		Currency:         currency,
		TotalMonthlyCost: totalCost,
		TotalBytes:       totalBytes,
		UnpricedBytes:    unpriced,
		ByOwner:          sortShowback(ownerAgg),
		ByDomain:         sortShowback(domainAgg),
	}, nil
}

func addShowback(m map[string]*showbackGroup, key string, bytes int64, cost float64) {
	g := m[key]
	if g == nil {
		g = &showbackGroup{Key: key}
		m[key] = g
	}
	g.Buckets++
	g.PhysicalBytes += bytes
	g.MonthlyCost += cost
}

// sortShowback flattens the map biggest-spend-first.
func sortShowback(m map[string]*showbackGroup) []showbackGroup {
	out := make([]showbackGroup, 0, len(m))
	for _, g := range m {
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MonthlyCost != out[j].MonthlyCost {
			return out[i].MonthlyCost > out[j].MonthlyCost
		}
		return out[i].PhysicalBytes > out[j].PhysicalBytes
	})
	return out
}
