// Package metrics defines the Prometheus metrics emitted by the controller.
// Everything is registered against a single Registry exposed via /metrics
// so an external scraper (Prometheus, VictoriaMetrics, Grafana Agent) can
// observe the controller alongside the SeaweedFS cluster it manages.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Registry is the single source of truth. Use this from main.go to wire the
// /metrics handler. We deliberately do NOT use prometheus.DefaultRegisterer
// to keep our metrics namespace clean (no random go runtime collisions).
var Registry = prometheus.NewRegistry()

// ----------------------------- HTTP -----------------------------

var HTTPRequests = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_http_requests_total",
		Help: "HTTP requests handled by the controller, partitioned by route + status.",
	},
	[]string{"method", "route", "status"},
)

var HTTPLatency = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "tier_http_request_duration_seconds",
		Help:    "End-to-end latency of HTTP requests.",
		Buckets: prometheus.ExponentialBuckets(0.005, 2, 12),
	},
	[]string{"method", "route"},
)

// ----------------------------- Scheduler -----------------------------

var ScoringDuration = prometheus.NewHistogram(
	prometheus.HistogramOpts{
		Name:    "tier_scoring_duration_seconds",
		Help:    "Wall time of one full scoring pass across all clusters.",
		Buckets: prometheus.ExponentialBuckets(1, 2, 10),
	},
)

var ScoringVolumes = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_scoring_volumes_total",
		Help: "Volumes evaluated by the scorer, partitioned by recommended action.",
	},
	[]string{"action"},
)

var TasksInserted = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_tasks_inserted_total",
		Help: "Tasks created by the scheduler, partitioned by action and outcome (inserted|duplicate|error).",
	},
	[]string{"action", "outcome"},
)

// ----------------------------- Executor -----------------------------

var ExecutorPhaseDuration = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "tier_executor_phase_duration_seconds",
		Help:    "Wall time of each executor phase.",
		Buckets: prometheus.ExponentialBuckets(1, 2, 12),
	},
	[]string{"action", "phase"},
)

var ExecutorOutcomes = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_executor_outcomes_total",
		Help: "Executor terminal outcomes per action.",
	},
	[]string{"action", "status"}, // status: succeeded|failed|skipped_locked|skipped_blocklist
)

var ExecutorActiveTasks = prometheus.NewGauge(
	prometheus.GaugeOpts{
		Name: "tier_executor_active_tasks",
		Help: "Tasks currently running.",
	},
)

// ----------------------------- AI -----------------------------

var AIDuration = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "tier_ai_call_duration_seconds",
		Help:    "AI provider call latency.",
		Buckets: prometheus.ExponentialBuckets(0.05, 2, 12),
	},
	[]string{"provider", "method"},
)

var AIErrors = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_ai_call_errors_total",
		Help: "AI provider call failures.",
	},
	[]string{"provider", "method"},
)

// ----------------------------- Health / Alerts -----------------------------

var HealthProbes = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_health_probes_total",
		Help: "Monitoring target probes, partitioned by name and outcome.",
	},
	[]string{"target", "result"},
)

var HealthGateClosed = prometheus.NewGauge(
	prometheus.GaugeOpts{
		Name: "tier_health_gate_closed",
		Help: "1 when scheduler is gated off due to degraded health.",
	},
)

var AlertsEmitted = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "tier_alerts_emitted_total",
		Help: "Alerts emitted, partitioned by kind, severity, channel kind, and result.",
	},
	[]string{"kind", "severity", "channel", "result"},
)

// ----------------------------- Build info -----------------------------

var BuildInfo = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "tier_build_info",
		Help: "Static build info; value is always 1.",
	},
	[]string{"version", "commit"},
)

func init() {
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		HTTPRequests, HTTPLatency,
		ScoringDuration, ScoringVolumes, TasksInserted,
		ExecutorPhaseDuration, ExecutorOutcomes, ExecutorActiveTasks,
		AIDuration, AIErrors,
		HealthProbes, HealthGateClosed,
		AlertsEmitted,
		BuildInfo,
	)
}
