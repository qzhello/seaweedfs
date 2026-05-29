package api

// Fleet health check: a one-shot, manual probe across every cluster.
// Each cluster aggregates a few best-effort signals into a single
// green/yellow/red verdict so an operator can eyeball the whole fleet.

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
