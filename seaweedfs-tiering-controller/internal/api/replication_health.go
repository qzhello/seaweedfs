package api

// Replication health endpoint — walks the cluster topology, decodes
// each volume's ReplicaPlacement, and reports mismatches between
// expected and observed copies. Feeds the dedicated Raft/Replication
// panel on the frontend, which also reuses the existing /masters
// endpoint for raft-quorum state.

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

type replicaIssue struct {
	VolumeID         uint32   `json:"volume_id"`
	Collection       string   `json:"collection"`
	ReplicaPlacement string   `json:"replica_placement"`
	Expected         int      `json:"expected"`
	Observed         int      `json:"observed"`
	Servers          []string `json:"servers"`
	Severity         string   `json:"severity"` // critical|warning|info
	Reason           string   `json:"reason"`
	IsEC             bool     `json:"is_ec"`
}

type ecShardHealth struct {
	VolumeID    uint32   `json:"volume_id"`
	Collection  string   `json:"collection"`
	ShardCount  int      `json:"shard_count"`
	Servers     []string `json:"servers"`
	MissingHint bool     `json:"missing_hint"`
}

type replicationHealthResp struct {
	ClusterID                string          `json:"cluster_id"`
	TotalVolumes             int             `json:"total_volumes"`
	NormalVolumes            int             `json:"normal_volumes"`
	ECVolumes                int             `json:"ec_volumes"`
	HealthyVolumes           int             `json:"healthy_volumes"`
	SoleCopies               int             `json:"sole_copies"`                 // expected ≥2, observed 1
	SingleCopyVolumes        int             `json:"single_copy_volumes"`         // normal volumes physically holding exactly one copy (any config)
	UnderReplicated          int             `json:"under_replicated"`            // observed < expected (but >1)
	OverReplicated           int             `json:"over_replicated"`             // observed > expected
	ECPotentiallyShortShards int             `json:"ec_potentially_short_shards"` // EC volume with <10 shards in cluster
	Issues                   []replicaIssue  `json:"issues"`                      // top 100
	ECShards                 []ecShardHealth `json:"ec_shards_at_risk"`           // top 50
}

// decodeReplicaPlacement returns the expected replica count derived
// from SeaweedFS's 3-digit dc-rack-node code. 011 → 3 copies; 100 → 2
// (one in another DC); 000 → 1.
func decodeReplicaPlacement(code uint32) int {
	dc := (code / 100) % 10
	rack := (code / 10) % 10
	node := code % 10
	return 1 + int(dc) + int(rack) + int(node)
}

func replicationHealth(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		vols, err := d.Sw.ListVolumesAt(c.Request.Context(), cl.MasterAddr)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}

		// Group topology rows by volume_id. For normal volumes the
		// number of rows is the observed replica count; for EC volumes
		// each row is one shard-bag on a server.
		type group struct {
			IsEC       bool
			Collection string
			Replica    uint32
			Rows       []seaweed.VolumeInfo
			Servers    map[string]struct{}
			ShardCount int
		}
		byID := map[uint32]*group{}
		for _, v := range vols {
			g, ok := byID[v.ID]
			if !ok {
				g = &group{
					IsEC:       v.IsEC,
					Collection: v.Collection,
					Replica:    v.ReplicaPlace,
					Servers:    map[string]struct{}{},
				}
				byID[v.ID] = g
			}
			g.Rows = append(g.Rows, v)
			g.Servers[v.Server] = struct{}{}
			if v.IsEC {
				g.ShardCount += len(v.Shards)
			}
		}

		out := replicationHealthResp{ClusterID: id.String()}
		// Initialized (not nil) so the JSON payload is always [] rather
		// than null when the cluster is fully healthy — the frontend
		// reads .length on both unconditionally.
		issues := []replicaIssue{}
		ecShards := []ecShardHealth{}

		for vid, g := range byID {
			out.TotalVolumes++
			if g.IsEC {
				out.ECVolumes++
				// SeaweedFS EC default is 10+4 = 14 shards. We don't
				// know the exact split from topology alone, but <10
				// shards observed means data is unrecoverable; we
				// flag <14 as a warning since parity coverage is gone.
				if g.ShardCount < 10 {
					out.ECPotentiallyShortShards++
					ecShards = append(ecShards, ecShardHealth{
						VolumeID:    vid,
						Collection:  g.Collection,
						ShardCount:  g.ShardCount,
						Servers:     keysSorted(g.Servers),
						MissingHint: true,
					})
				} else if g.ShardCount < 14 {
					ecShards = append(ecShards, ecShardHealth{
						VolumeID:    vid,
						Collection:  g.Collection,
						ShardCount:  g.ShardCount,
						Servers:     keysSorted(g.Servers),
						MissingHint: false,
					})
				}
				continue
			}
			out.NormalVolumes++
			expected := decodeReplicaPlacement(g.Replica)
			observed := len(g.Servers)
			// Any volume on a single server is a data-loss risk if that
			// disk dies — counted regardless of whether one copy is the
			// configured intent. SoleCopies (below) is the misconfigured
			// subset; SingleCopyVolumes is the full exposure surface.
			if observed == 1 {
				out.SingleCopyVolumes++
			}
			if observed == expected {
				out.HealthyVolumes++
				continue
			}
			issue := replicaIssue{
				VolumeID:         vid,
				Collection:       g.Collection,
				ReplicaPlacement: replicaPlacementString(g.Replica),
				Expected:         expected,
				Observed:         observed,
				Servers:          keysSorted(g.Servers),
				IsEC:             false,
			}
			switch {
			case observed == 1 && expected >= 2:
				out.SoleCopies++
				issue.Severity = "critical"
				issue.Reason = "sole copy: replication policy expects more"
			case observed < expected:
				out.UnderReplicated++
				issue.Severity = "warning"
				issue.Reason = "fewer replicas than configured"
			case observed > expected:
				out.OverReplicated++
				issue.Severity = "info"
				issue.Reason = "extra replicas (likely transient post-migration)"
			}
			issues = append(issues, issue)
		}

		// Stable, severity-first ordering: critical → warning → info,
		// then biggest gaps first.
		severityRank := map[string]int{"critical": 0, "warning": 1, "info": 2}
		sort.Slice(issues, func(i, j int) bool {
			if severityRank[issues[i].Severity] != severityRank[issues[j].Severity] {
				return severityRank[issues[i].Severity] < severityRank[issues[j].Severity]
			}
			gi := abs(issues[i].Expected - issues[i].Observed)
			gj := abs(issues[j].Expected - issues[j].Observed)
			if gi != gj {
				return gi > gj
			}
			return issues[i].VolumeID < issues[j].VolumeID
		})
		if len(issues) > 100 {
			issues = issues[:100]
		}
		sort.Slice(ecShards, func(i, j int) bool {
			return ecShards[i].ShardCount < ecShards[j].ShardCount
		})
		if len(ecShards) > 50 {
			ecShards = ecShards[:50]
		}
		out.Issues = issues
		out.ECShards = ecShards
		c.JSON(http.StatusOK, out)
	}
}

func keysSorted(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// replicaPlacementString pads the 3-digit code with leading zeroes
// because operators expect to see "011" not "11".
func replicaPlacementString(code uint32) string {
	if code >= 1000 {
		// Defensive: shouldn't happen but don't panic if it does.
		return strings.Repeat("?", 3)
	}
	s := []byte{
		'0' + byte((code/100)%10),
		'0' + byte((code/10)%10),
		'0' + byte(code%10),
	}
	return string(s)
}
