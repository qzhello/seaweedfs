package api

// Policy time machine — given a policy definition and a cluster,
// return "what would the policy migrate if enabled now".
//
// We interpret policy.params (JSON) with these recognised fields:
//   min_quiet_days    int      // volume.ModifiedAtSec must be older than N days
//   min_size_bytes    int64    // skip tiny volumes
//   max_reads_30d     uint64   // skip if reads exceed this (requires CH features)
//   target_backend    string   // for cost-saving projection
//   exclude_readonly  bool     // skip read-only volumes
//   collection_glob   string   // optional path-Glob over collection name
//
// All fields are optional. Unrecognised fields are ignored. Missing
// fields fall back to defaults captured in simulateDefaults.
//
// Scope filters apply on top: policy.scope_kind=collection means only
// volumes whose Collection matches scope_value are considered;
// scope_kind=bucket matches Collection too (Seaweed uses bucket name
// as Collection in S3 mode); scope_kind=global considers everything.

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type simParams struct {
	MinQuietDays    int    `json:"min_quiet_days,omitempty"`
	MinSizeBytes    int64  `json:"min_size_bytes,omitempty"`
	MaxReads30d     uint64 `json:"max_reads_30d,omitempty"`
	TargetBackend   string `json:"target_backend,omitempty"`
	ExcludeReadonly bool   `json:"exclude_readonly,omitempty"`
	CollectionGlob  string `json:"collection_glob,omitempty"`
}

func simulateDefaults() simParams {
	return simParams{
		MinQuietDays:    30,
		MinSizeBytes:    1024 * 1024 * 100, // 100 MiB
		MaxReads30d:     0,                  // 0 = unlimited
		ExcludeReadonly: false,
	}
}

type simMatch struct {
	VolumeID    uint32  `json:"volume_id"`
	Collection  string  `json:"collection"`
	Server      string  `json:"server"`
	Bytes       int64   `json:"bytes"`
	QuietDays   int     `json:"quiet_days"`
	Reads30d    uint64  `json:"reads_30d"`
	Reason      string  `json:"reason"`
}

type simByCollection struct {
	Collection string `json:"collection"`
	Volumes    int    `json:"volumes"`
	Bytes      int64  `json:"bytes"`
}

type simSkipped struct {
	VolumeID uint32 `json:"volume_id"`
	Reason   string `json:"reason"`
}

type policySimulateResp struct {
	PolicyID            string             `json:"policy_id"`
	PolicyName          string             `json:"policy_name"`
	ClusterID           string             `json:"cluster_id"`
	GeneratedAt         time.Time          `json:"generated_at"`
	EffectiveParams     simParams          `json:"effective_params"`
	MatchedVolumes      int                `json:"matched_volumes"`
	MatchedBytes        int64              `json:"matched_bytes"`
	SkippedVolumes      int                `json:"skipped_volumes"`
	ConsideredVolumes   int                `json:"considered_volumes"`
	ByCollection        []simByCollection  `json:"by_collection"`
	Samples             []simMatch         `json:"samples"`
	SkipReasons         map[string]int     `json:"skip_reasons"`
	EstMonthlySaving    float64            `json:"est_monthly_saving"`
	EstSavingCurrency   string             `json:"est_saving_currency"`
	HotReferenceBackend string             `json:"hot_reference_backend"`
	// AsOf is set only in time-machine mode — the snapshot instant the
	// dry-run was evaluated against. Nil means "live cluster state".
	AsOf *time.Time `json:"as_of,omitempty"`
}

// simVol is the normalised candidate the matching loop consumes, so one
// loop serves both live topology and a historical feature snapshot.
type simVol struct {
	ID         uint32
	Collection string
	Server     string // empty in historical mode (not recorded in features)
	Size       uint64
	QuietDays  int
	ReadOnly   bool
	IsEC       bool // always false in historical mode — see handler note
	Reads30d   uint64
	ReadsKnown bool // true when Reads30d is already populated (historical)
}

func policySimulate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		policyID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad policy id"})
			return
		}
		clusterIDStr := c.Query("cluster_id")
		if clusterIDStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		clusterID, err := uuid.Parse(clusterIDStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}

		// Optional time-machine: ?as_of=<RFC3339> dry-runs the policy
		// against the volume_features snapshot nearest that instant
		// rather than live topology. Needs ClickHouse — that's where the
		// historical snapshots live.
		var asOf time.Time
		if s := c.Query("as_of"); s != "" {
			asOf, err = time.Parse(time.RFC3339, s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad as_of: expected RFC3339"})
				return
			}
			if d.CH == nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "as_of needs ClickHouse history, which is not configured"})
				return
			}
		}

		policy, err := findPolicyByID(c.Request.Context(), d, policyID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// Merge defaults with policy.params. Unknown JSON fields are
		// silently dropped, which lets operators future-proof the
		// policy without breaking older controllers.
		params := simulateDefaults()
		if len(policy.Params) > 0 && string(policy.Params) != "null" {
			_ = json.Unmarshal(policy.Params, &params)
		}

		// Build the candidate set — live topology, or a historical
		// feature snapshot when in time-machine mode. volume_features IS
		// the historical topology: size, quiet_for_seconds and reads were
		// all recorded at snapshot time, so no "now" reconstruction is
		// needed. Caveat: the snapshot doesn't record EC status, so the
		// EC skip below is a no-op in historical mode (acceptable — EC
		// volumes are a small minority and only mildly inflate the count).
		var vols []simVol
		historical := !asOf.IsZero()
		if historical {
			snap, serr := d.CH.VolumeFeaturesSnapshotAt(c.Request.Context(), asOf)
			if serr != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": serr.Error()})
				return
			}
			vols = make([]simVol, 0, len(snap))
			for _, f := range snap {
				vols = append(vols, simVol{
					ID:         f.VolumeID,
					Collection: f.Collection,
					Size:       f.SizeBytes,
					QuietDays:  int(f.QuietForSeconds / 86400),
					ReadOnly:   f.IsReadonly,
					Reads30d:   f.Reads30d,
					ReadsKnown: true,
				})
			}
		} else {
			live, lerr := d.Sw.ListVolumesAt(c.Request.Context(), cl.MasterAddr)
			if lerr != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": lerr.Error()})
				return
			}
			nowUnix := time.Now().Unix()
			vols = make([]simVol, 0, len(live))
			for _, v := range live {
				// ModifiedAtSec is the activity proxy; 0 means unknown,
				// treat as "just modified" so we never tier blind.
				quietDays := 0
				if v.ModifiedAtSec > 0 {
					quietDays = int((nowUnix - v.ModifiedAtSec) / 86400)
				}
				vols = append(vols, simVol{
					ID:         v.ID,
					Collection: v.Collection,
					Server:     v.Server,
					Size:       v.Size,
					QuietDays:  quietDays,
					ReadOnly:   v.ReadOnly,
					IsEC:       v.IsEC,
				})
			}
		}

		out := policySimulateResp{
			PolicyID:        policyID.String(),
			PolicyName:      policy.Name,
			ClusterID:       clusterID.String(),
			GeneratedAt:     time.Now(),
			EffectiveParams: params,
			SkipReasons:     map[string]int{},
		}
		if historical {
			out.AsOf = &asOf
		}
		byColl := map[string]*simByCollection{}

		// Cache reads-per-volume feature lookups (live mode only) so we
		// don't roundtrip per volume even when the same id shows up
		// across replicas.
		readsCache := map[uint32]uint64{}

		for _, v := range vols {
			// Skip EC volumes — already tiered effectively; tier-move on
			// EC isn't a normal flow. No-op in historical mode.
			if v.IsEC {
				continue
			}
			// Scope filter — same Collection field used for both
			// `collection` and `bucket` policy scopes since SeaweedFS
			// stores the S3 bucket name in Collection.
			if !scopeMatches(policy, v.Collection) {
				continue
			}
			if params.CollectionGlob != "" {
				if matched, _ := path.Match(params.CollectionGlob, v.Collection); !matched {
					continue
				}
			}
			out.ConsideredVolumes++

			if v.QuietDays < params.MinQuietDays {
				out.SkippedVolumes++
				out.SkipReasons["too_recent"]++
				continue
			}
			if int64(v.Size) < params.MinSizeBytes {
				out.SkippedVolumes++
				out.SkipReasons["too_small"]++
				continue
			}
			if params.ExcludeReadonly && v.ReadOnly {
				out.SkippedVolumes++
				out.SkipReasons["readonly"]++
				continue
			}

			// Reads — known up front in historical mode; looked up
			// lazily (and only when MaxReads30d gates on it) in live mode.
			var reads uint64
			if v.ReadsKnown {
				reads = v.Reads30d
			}
			if params.MaxReads30d > 0 {
				if !v.ReadsKnown {
					r, ok := readsCache[v.ID]
					if !ok && d.CH != nil {
						if f, ferr := d.CH.LatestVolumeFeatures(c.Request.Context(), v.ID); ferr == nil && f != nil {
							r = f.Reads30d
						}
						readsCache[v.ID] = r
					}
					reads = r
				}
				if reads > params.MaxReads30d {
					out.SkippedVolumes++
					out.SkipReasons["too_active"]++
					continue
				}
			}

			out.MatchedVolumes++
			out.MatchedBytes += int64(v.Size)

			cb := byColl[v.Collection]
			if cb == nil {
				cb = &simByCollection{Collection: v.Collection}
				byColl[v.Collection] = cb
			}
			cb.Volumes++
			cb.Bytes += int64(v.Size)

			if len(out.Samples) < 25 {
				out.Samples = append(out.Samples, simMatch{
					VolumeID:   v.ID,
					Collection: v.Collection,
					Server:     v.Server,
					Bytes:      int64(v.Size),
					QuietDays:  v.QuietDays,
					Reads30d:   reads,
					Reason: "quiet ≥" + itoa(params.MinQuietDays) + "d, size ≥" +
						humanBytes(params.MinSizeBytes),
				})
			}
		}

		// Stable collection order; bigger first.
		for _, c := range byColl {
			out.ByCollection = append(out.ByCollection, *c)
		}
		sort.Slice(out.ByCollection, func(i, j int) bool {
			return out.ByCollection[i].Bytes > out.ByCollection[j].Bytes
		})

		// Project cost saving — needs hot reference + target backend.
		// If either is missing we leave the field 0 and the UI shows
		// "—". This lets the simulator stay useful even before the
		// operator has fully populated /pricing.
		if hot, err := d.PG.HotReferencePricing(c.Request.Context()); err == nil && hot != nil {
			out.HotReferenceBackend = hot.Name
			out.EstSavingCurrency = hot.Currency
			target := params.TargetBackend
			if target != "" {
				if prices, err := d.PG.ListBackendPricing(c.Request.Context()); err == nil {
					for _, p := range prices {
						if p.Name == target {
							diff := hot.StoragePricePerTBMonth - p.StoragePricePerTBMonth
							if diff > 0 {
								out.EstMonthlySaving = float64(out.MatchedBytes) / bytesPerTB * diff
							}
							break
						}
					}
				}
			}
		}

		c.JSON(http.StatusOK, out)
	}
}

func scopeMatches(p *store.Policy, collection string) bool {
	switch strings.ToLower(p.ScopeKind) {
	case "", "global":
		return true
	case "collection", "bucket":
		return collection == p.ScopeValue
	default:
		return true
	}
}

func findPolicyByID(ctx context.Context, d Deps, id uuid.UUID) (*store.Policy, error) {
	all, err := d.PG.ListPolicies(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, &errNotFound{}
}

type errNotFound struct{}

func (e *errNotFound) Error() string { return "policy not found" }

func itoa(n int) string {
	// Tiny zero-alloc int-to-string for our small magnitudes.
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
