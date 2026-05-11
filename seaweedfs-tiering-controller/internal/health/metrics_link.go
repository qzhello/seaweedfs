package health

import "github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"

// metricsHealthGateClosed adapts the gauge call from gate.go without making
// the gate package directly import metrics (keeps the gate testable in
// isolation).
func metricsHealthGateClosed(v float64) {
	metrics.HealthGateClosed.Set(v)
}
