// Package health is the controller's monitoring side. It probes the targets
// stored in monitor_targets, applies flap-protected state transitions, and
// exposes a Gate that the scheduler consults before queuing/executing.
package health

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type Scraper struct {
	pg     *store.PG
	log    *zap.Logger
	gate   *Gate
	alerts *alerter.Dispatcher // optional; nil disables alerts
	client *http.Client
	mu     sync.Mutex // serializes target-list refresh
}

func New(pg *store.PG, log *zap.Logger, gate *Gate, alerts *alerter.Dispatcher) *Scraper {
	return &Scraper{
		pg:     pg,
		log:    log,
		gate:   gate,
		alerts: alerts,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Run starts a single scheduler goroutine that re-reads the target list every
// 30s and dispatches probes per target on its own cadence.
func (s *Scraper) Run(ctx context.Context) {
	tasks := map[uuid.UUID]context.CancelFunc{}
	defer func() {
		for _, cancel := range tasks {
			cancel()
		}
	}()
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	s.refresh(ctx, tasks)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.refresh(ctx, tasks)
		}
	}
}

// refresh diffs the live target list against the running probes and starts/
// stops goroutines accordingly. Cheap to call frequently.
func (s *Scraper) refresh(ctx context.Context, tasks map[uuid.UUID]context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	targets, err := s.pg.ListMonitorTargets(ctx)
	if err != nil {
		s.log.Warn("list monitor targets", zap.Error(err))
		return
	}
	live := map[uuid.UUID]struct{}{}
	for _, t := range targets {
		live[t.ID] = struct{}{}
		if t.Enabled {
			if _, ok := tasks[t.ID]; !ok {
				ctx2, cancel := context.WithCancel(ctx)
				tasks[t.ID] = cancel
				go s.probeLoop(ctx2, t)
			}
		} else if cancel, ok := tasks[t.ID]; ok {
			cancel()
			delete(tasks, t.ID)
		}
	}
	for id, cancel := range tasks {
		if _, ok := live[id]; !ok {
			cancel()
			delete(tasks, id)
		}
	}
}

func (s *Scraper) probeLoop(ctx context.Context, t store.MonitorTarget) {
	t = s.normalize(t)
	tick := time.NewTicker(time.Duration(t.IntervalSec) * time.Second)
	defer tick.Stop()
	s.probeOnce(ctx, t) // immediate first probe
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.probeOnce(ctx, t)
		}
	}
}

func (s *Scraper) probeOnce(ctx context.Context, t store.MonitorTarget) {
	pCtx, cancel := context.WithTimeout(ctx, time.Duration(t.TimeoutSec)*time.Second)
	defer cancel()

	start := time.Now()
	var (
		ok      bool
		errStr  string
		value   *float64
	)
	switch t.Kind {
	case "http":
		ok, errStr = s.probeHTTP(pCtx, t.URL)
	case "prometheus_query":
		ok, value, errStr = s.probePromQuery(pCtx, t)
	default:
		errStr = "unknown kind"
	}
	latency := int(time.Since(start) / time.Millisecond)

	result := "ok"
	if !ok {
		result = "failed"
	}
	metrics.HealthProbes.WithLabelValues(t.Name, result).Inc()

	if err := s.applyResult(ctx, t, ok, errStr, latency, value); err != nil {
		s.log.Warn("apply health result", zap.String("target", t.Name), zap.Error(err))
	}
}

func (s *Scraper) probeHTTP(ctx context.Context, url string) (bool, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err.Error()
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return true, ""
	}
	return false, fmt.Sprintf("status %d", resp.StatusCode)
}

// probePromQuery hits Prometheus /api/v1/query with the configured PromQL
// expression. Considers the target healthy when the result is non-empty and
// (optionally) the first sample's value satisfies threshold_op/threshold_value.
func (s *Scraper) probePromQuery(ctx context.Context, t store.MonitorTarget) (bool, *float64, string) {
	if t.Query == "" {
		return false, nil, "empty query"
	}
	base := strings.TrimRight(t.URL, "/")
	u := base + "/api/v1/query?query=" + percentEncode(t.Query)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false, nil, err.Error()
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return false, nil, err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return false, nil, fmt.Sprintf("status %d", resp.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Value [2]interface{} `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, nil, "decode: " + err.Error()
	}
	if body.Status != "success" || len(body.Data.Result) == 0 {
		return false, nil, "empty result"
	}
	// Extract first sample's numeric value.
	raw, ok := body.Data.Result[0].Value[1].(string)
	if !ok {
		return false, nil, "non-string value"
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return false, nil, "parse value: " + err.Error()
	}
	if t.ThresholdOp != "" && t.ThresholdValue != nil {
		if !compareFloat(v, t.ThresholdOp, *t.ThresholdValue) {
			return false, &v, fmt.Sprintf("threshold breached: %g %s %g", v, t.ThresholdOp, *t.ThresholdValue)
		}
	}
	return true, &v, ""
}

// applyResult is the only place state transitions happen. Consecutive counters
// drive flap protection: enter degraded only after FailThreshold consecutive
// failures, exit only after RecoverThreshold consecutive successes.
func (s *Scraper) applyResult(ctx context.Context, t store.MonitorTarget,
	ok bool, errStr string, latency int, value *float64) error {

	rows, err := s.pg.ListHealthState(ctx)
	if err != nil {
		return err
	}
	var prev store.HealthRow
	for _, r := range rows {
		if r.TargetID == t.ID {
			prev = r
			break
		}
	}
	now := time.Now()
	row := prev
	row.TargetID = t.ID
	row.LastLatencyMs = latency
	row.LastValue = value
	row.UpdatedAt = now

	if ok {
		row.ConsecutiveFailures = 0
		row.ConsecutiveSuccesses = prev.ConsecutiveSuccesses + 1
		row.LastOkAt = &now
		if prev.State != "healthy" && row.ConsecutiveSuccesses >= t.RecoverThreshold {
			row.State = "healthy"
			s.log.Info("target recovered",
				zap.String("name", t.Name), zap.String("from", prev.State))
			if s.alerts != nil && prev.State == "degraded" {
				s.alerts.Emit(alerter.Event{
					Kind: "health.recovered", Source: t.Name,
					Severity: "info",
					Title:    "Monitor target recovered: " + t.Name,
					Body:     fmt.Sprintf("Recovered after %d consecutive successes.", row.ConsecutiveSuccesses),
				})
			}
		} else if prev.State == "" {
			row.State = "healthy"
		}
		row.LastError = ""
	} else {
		row.ConsecutiveSuccesses = 0
		row.ConsecutiveFailures = prev.ConsecutiveFailures + 1
		row.LastFailureAt = &now
		row.LastError = errStr
		if row.ConsecutiveFailures >= t.FailThreshold && prev.State != "degraded" {
			row.State = "degraded"
			s.log.Warn("target degraded",
				zap.String("name", t.Name),
				zap.Int("consecutive_failures", row.ConsecutiveFailures),
				zap.String("err", errStr))
			if s.alerts != nil {
				s.alerts.Emit(alerter.Event{
					Kind: "health.degraded", Source: t.Name,
					Severity: t.Severity,
					Title:    "Monitor target degraded: " + t.Name,
					Body: fmt.Sprintf("Consecutive failures: %d/%d\nLast error: %s",
						row.ConsecutiveFailures, t.FailThreshold, errStr),
					Payload: map[string]interface{}{
						"target_id": t.ID, "url": t.URL, "kind": t.Kind,
						"latency_ms": latency,
					},
				})
			}
		} else if prev.State == "" {
			row.State = "unknown"
		}
	}

	if err := s.pg.PutHealthRow(ctx, row); err != nil {
		return err
	}
	_ = s.pg.AppendHealthSample(ctx, t.ID, ok, latency, value)
	s.gate.Update(t, row)
	return nil
}

func (s *Scraper) normalize(t store.MonitorTarget) store.MonitorTarget {
	if t.IntervalSec < 5 {
		t.IntervalSec = 5
	}
	if t.TimeoutSec < 1 {
		t.TimeoutSec = 1
	}
	if t.FailThreshold < 1 {
		t.FailThreshold = 3
	}
	if t.RecoverThreshold < 1 {
		t.RecoverThreshold = 3
	}
	return t
}

func compareFloat(a float64, op string, b float64) bool {
	switch op {
	case ">":
		return a > b
	case "<":
		return a < b
	case ">=":
		return a >= b
	case "<=":
		return a <= b
	case "==":
		return a == b
	case "!=":
		return a != b
	}
	return false
}

func percentEncode(s string) string {
	// minimal: replace space + reserved chars to avoid pulling net/url just for one call
	const reserved = " #&+%?"
	b := strings.Builder{}
	for _, r := range s {
		if strings.ContainsRune(reserved, r) {
			b.WriteString(fmt.Sprintf("%%%02X", r))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
