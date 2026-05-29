package api

// Fleet health check: a one-shot, manual probe across every cluster.
// Each cluster aggregates a few best-effort signals into a single
// green/yellow/red verdict so an operator can eyeball the whole fleet.

import (
	"context"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// healthSignal is one probed dimension of a cluster's health.
// Status: "ok" | "warn" | "down" | "unknown".
type healthSignal struct {
	Key    string `json:"key"`    // master | quorum | filers | replication
	Status string `json:"status"` // ok | warn | down | unknown
	Detail string `json:"detail,omitempty"`
}

// clusterHealthResult is the per-cluster verdict returned to the UI.
type clusterHealthResult struct {
	ClusterID string         `json:"cluster_id"`
	Name      string         `json:"name"`
	Enabled   bool           `json:"enabled"`
	Status    string         `json:"status"` // green | yellow | red | skipped
	Reachable bool           `json:"reachable"`
	LatencyMS int64          `json:"latency_ms"`
	Signals   []healthSignal `json:"signals"`
	Reasons   []string       `json:"reasons"`
}

type fleetHealthSummary struct {
	Green   int `json:"green"`
	Yellow  int `json:"yellow"`
	Red     int `json:"red"`
	Skipped int `json:"skipped"`
	Total   int `json:"total"`
}

type fleetHealthResponse struct {
	Results []clusterHealthResult `json:"results"`
	Summary fleetHealthSummary    `json:"summary"`
}

// rollupClusterStatus maps signal statuses to a cluster verdict:
// any "down" -> "red"; else any "warn"/"unknown" -> "yellow"; else "green".
func rollupClusterStatus(signals []healthSignal) string {
	worst := "green"
	for _, s := range signals {
		switch s.Status {
		case "down":
			return "red"
		case "warn", "unknown":
			worst = "yellow"
		}
	}
	return worst
}

const (
	fleetHealthConcurrency = 8
	fleetHealthPerCluster  = 8 * time.Second
)

// gatherClusterHealth probes one cluster's signals best-effort and rolls
// them up. Never returns an error — every failure becomes a signal status
// so one bad cluster cannot fail the batch.
func gatherClusterHealth(ctx context.Context, d Deps, cl store.Cluster) clusterHealthResult {
	res := clusterHealthResult{
		ClusterID: cl.ID.String(),
		Name:      cl.Name,
		Enabled:   cl.Enabled,
	}
	if !cl.Enabled {
		res.Status = "skipped"
		return res
	}

	start := time.Now()
	// ProbeMaster is not ctx-aware — it has its own ~4s worst-case dial
	// timeout (2s HTTP + 2s gRPC). It runs before the inner errgroup, so the
	// effective budget left for quorum/filers/replication is
	// fleetHealthPerCluster minus this probe's latency.
	mErr := d.Sw.ProbeMaster(cl.MasterAddr)
	res.LatencyMS = time.Since(start).Milliseconds()
	res.Reachable = mErr == nil
	if mErr != nil {
		res.Signals = []healthSignal{{Key: "master", Status: "down", Detail: mErr.Error()}}
		res.Status = "red"
		res.Reasons = []string{"master unreachable: " + mErr.Error()}
		return res
	}
	res.Signals = append(res.Signals, healthSignal{Key: "master", Status: "ok"})

	var quorum, filers, repl healthSignal
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { quorum = probeQuorum(gctx, d, cl); return nil })
	g.Go(func() error { filers = probeHealthFilers(gctx, d, cl); return nil })
	g.Go(func() error { repl = probeReplication(gctx, d, cl); return nil })
	_ = g.Wait()
	res.Signals = append(res.Signals, quorum, filers, repl)

	res.Status = rollupClusterStatus(res.Signals)
	for _, s := range res.Signals {
		if s.Status != "ok" && s.Detail != "" {
			res.Reasons = append(res.Reasons, s.Key+": "+s.Detail)
		}
	}
	return res
}

// probeQuorum checks the master raft cluster has a leader and a voting majority.
func probeQuorum(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	servers, _, err := d.Sw.FetchMasterRaftServers(ctx, cl.MasterAddr)
	if err != nil {
		return healthSignal{Key: "quorum", Status: "unknown", Detail: err.Error()}
	}
	voters, votersUp := 0, 0
	leader := false
	for _, s := range servers {
		isVoter := s.Suffrage == "" || s.Suffrage == "Voter" || s.Suffrage == "voter"
		if isVoter {
			voters++
			votersUp++
		}
		if s.IsLeader {
			leader = true
		}
	}
	if !leader {
		return healthSignal{Key: "quorum", Status: "down", Detail: "no raft leader"}
	}
	if voters > 0 && votersUp <= voters/2 {
		return healthSignal{Key: "quorum", Status: "down", Detail: "lost voting majority"}
	}
	return healthSignal{Key: "quorum", Status: "ok"}
}

// probeHealthFilers lists filers from the master and probes each /status in parallel.
func probeHealthFilers(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	nodes, err := d.Sw.ListFilers(ctx, cl.MasterAddr)
	if err != nil {
		return healthSignal{Key: "filers", Status: "unknown", Detail: err.Error()}
	}
	if len(nodes) == 0 {
		return healthSignal{Key: "filers", Status: "unknown", Detail: "no filers registered"}
	}
	var g errgroup.Group
	down := make([]string, len(nodes))
	for i, n := range nodes {
		i, n := i, n
		g.Go(func() error {
			if _, perr := probeFilerStatus(ctx, n.Address); perr != nil {
				down[i] = n.Address
			}
			return nil
		})
	}
	_ = g.Wait()
	unreachable := 0
	for _, a := range down {
		if a != "" {
			unreachable++
		}
	}
	if unreachable > 0 {
		return healthSignal{Key: "filers", Status: "warn",
			Detail: fmt.Sprintf("%d/%d filer unreachable", unreachable, len(nodes))}
	}
	return healthSignal{Key: "filers", Status: "ok"}
}

// probeReplication summarizes replica/EC health (uses the topology cache).
func probeReplication(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	// Local copy so taking its address can't alias/mutate the caller's value
	// (computeReplicationHealth takes *store.Cluster).
	clp := cl
	rep, err := computeReplicationHealth(ctx, d, &clp)
	if err != nil {
		return healthSignal{Key: "replication", Status: "unknown", Detail: err.Error()}
	}
	problems := rep.SoleCopies + rep.UnderReplicated + rep.OverReplicated + rep.ECPotentiallyShortShards
	if problems > 0 {
		return healthSignal{Key: "replication", Status: "warn",
			Detail: fmt.Sprintf("sole=%d under=%d over=%d ec_short=%d",
				rep.SoleCopies, rep.UnderReplicated, rep.OverReplicated, rep.ECPotentiallyShortShards)}
	}
	return healthSignal{Key: "replication", Status: "ok"}
}

// fleetHealthCheck probes every cluster concurrently and returns a tiered
// health verdict per cluster. Read-only diagnostic (cap cluster.read); not
// gated by the safety Guard.
//
// POST /api/v1/clusters/health-check
func fleetHealthCheck(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusters, err := d.PG.ListClusters(c.Request.Context())
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		results := make([]clusterHealthResult, len(clusters))
		sem := make(chan struct{}, fleetHealthConcurrency)
		var g errgroup.Group
		for i, cl := range clusters {
			i, cl := i, cl
			g.Go(func() error {
				sem <- struct{}{}
				defer func() { <-sem }()
				cctx, cancel := context.WithTimeout(c.Request.Context(), fleetHealthPerCluster)
				defer cancel()
				results[i] = gatherClusterHealth(cctx, d, cl)
				return nil
			})
		}
		_ = g.Wait()

		var sum fleetHealthSummary
		sum.Total = len(results)
		for _, r := range results {
			switch r.Status {
			case "green":
				sum.Green++
			case "yellow":
				sum.Yellow++
			case "red":
				sum.Red++
			case "skipped":
				sum.Skipped++
			}
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "fleet.health-check", "fleet", "", map[string]any{
			"green": sum.Green, "yellow": sum.Yellow, "red": sum.Red, "skipped": sum.Skipped, "total": sum.Total,
		})
		c.JSON(200, fleetHealthResponse{Results: results, Summary: sum})
	}
}
