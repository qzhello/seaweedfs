// Package alerter routes events to channels with dedupe + silence + per-channel
// rate limiting. Dispatch is async via a small queue so callers (health scraper,
// executor) never block on outbound HTTP.
package alerter

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"golang.org/x/time/rate"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Event is what callers emit. Minimal, channel-agnostic.
type Event struct {
	Kind     string                 // "health.degraded" | "task.failed" | "workflow.anomaly"
	Source   string                 // monitor name / cluster id / task id
	Severity string                 // info | warning | critical
	Title    string
	Body     string
	Payload  map[string]interface{}
	At       time.Time
}

type Dispatcher struct {
	pg     *store.PG
	log    *zap.Logger
	queue  chan Event
	mu     sync.Mutex
	chRate map[uuid.UUID]*rate.Limiter // per-channel hourly limiter
}

func New(pg *store.PG, log *zap.Logger) *Dispatcher {
	return &Dispatcher{
		pg:     pg,
		log:    log,
		queue:  make(chan Event, 256),
		chRate: map[uuid.UUID]*rate.Limiter{},
	}
}

// Run starts a background worker. Single goroutine is plenty for v1; alerts
// are low-volume by definition.
func (d *Dispatcher) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-d.queue:
			d.process(ctx, e)
		}
	}
}

// Emit queues an event. Drops with a warn log if the queue is full (better
// than blocking the producer; the source can re-fire on next iteration).
func (d *Dispatcher) Emit(e Event) {
	if e.At.IsZero() {
		e.At = time.Now()
	}
	if e.Severity == "" {
		e.Severity = "warning"
	}
	select {
	case d.queue <- e:
	default:
		d.log.Warn("alert queue full, dropping event",
			zap.String("kind", e.Kind), zap.String("source", e.Source))
	}
}

func (d *Dispatcher) process(ctx context.Context, e Event) {
	rules, err := d.pg.ListAlertRules(ctx)
	if err != nil {
		d.log.Warn("list rules", zap.Error(err))
		return
	}
	channels, err := d.pg.ListAlertChannels(ctx)
	if err != nil {
		d.log.Warn("list channels", zap.Error(err))
		return
	}
	chByID := map[uuid.UUID]store.AlertChannel{}
	for _, c := range channels {
		chByID[c.ID] = c
	}

	matched := selectRules(rules, e)
	if len(matched) == 0 {
		// No rule matched — log to event table for visibility but don't deliver.
		d.persistEvent(ctx, e, true, "no rule matched", nil)
		return
	}

	type delivery struct {
		Channel string `json:"channel"`
		OK      bool   `json:"ok"`
		Error   string `json:"error,omitempty"`
	}
	deliveries := []delivery{}
	suppressed := true
	suppressedReason := ""

	for _, r := range matched {
		silenced, err := d.pg.CheckSilence(ctx, r.ID, e.Source, time.Duration(r.SilenceSec)*time.Second)
		if err != nil {
			d.log.Warn("check silence", zap.Error(err))
			continue
		}
		if silenced {
			suppressedReason = fmt.Sprintf("rule %q silence window", r.Name)
			continue
		}
		for _, cid := range r.ChannelIDs {
			c, ok := chByID[cid]
			if !ok || !c.Enabled {
				continue
			}
			if !severityAllowed(c.Severities, e.Severity) {
				continue
			}
			if !d.allow(c) {
				deliveries = append(deliveries, delivery{Channel: c.Name, OK: false, Error: "channel rate limited"})
				continue
			}
			err := deliver(ctx, c, e)
			result := "ok"
			if err != nil {
				result = "failed"
				deliveries = append(deliveries, delivery{Channel: c.Name, OK: false, Error: err.Error()})
				d.log.Warn("alert deliver failed", zap.String("channel", c.Name), zap.Error(err))
				metrics.AlertsEmitted.WithLabelValues(e.Kind, e.Severity, c.Kind, result).Inc()
				continue
			}
			deliveries = append(deliveries, delivery{Channel: c.Name, OK: true})
			suppressed = false
			metrics.AlertsEmitted.WithLabelValues(e.Kind, e.Severity, c.Kind, result).Inc()
		}
	}
	d.persistEvent(ctx, e, suppressed, suppressedReason, deliveries)
}

func (d *Dispatcher) persistEvent(ctx context.Context, e Event, suppressed bool, reason string, deliveries interface{}) {
	payload, _ := json.Marshal(e.Payload)
	delJSON, _ := json.Marshal(deliveries)
	if delJSON == nil {
		delJSON = []byte("[]")
	}
	_, err := d.pg.InsertAlertEvent(ctx, store.AlertEvent{
		EventKind: e.Kind, Source: e.Source, Severity: e.Severity,
		Title: e.Title, Body: e.Body,
		Payload: payload, Deliveries: delJSON,
		Suppressed: suppressed, SuppressedReason: reason,
	})
	if err != nil {
		d.log.Warn("persist alert event", zap.Error(err))
	}
}

// allow enforces per-channel rate_per_hour using a token bucket.
// Returns true iff a token is available.
func (d *Dispatcher) allow(c store.AlertChannel) bool {
	if c.RatePerHour <= 0 {
		return true
	}
	d.mu.Lock()
	l, ok := d.chRate[c.ID]
	if !ok {
		// Per-hour budget; allow burst of N/10 to absorb retries.
		l = rate.NewLimiter(rate.Every(time.Hour/time.Duration(c.RatePerHour)),
			max(c.RatePerHour/10, 1))
		d.chRate[c.ID] = l
	}
	d.mu.Unlock()
	return l.Allow()
}

func selectRules(rules []store.AlertRule, e Event) []store.AlertRule {
	out := []store.AlertRule{}
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if r.EventKind != e.Kind && r.EventKind != "*" {
			continue
		}
		if r.SourceMatch != "*" && r.SourceMatch != e.Source {
			continue
		}
		if !severityMeetsMin(e.Severity, r.SeverityMin) {
			continue
		}
		out = append(out, r)
	}
	return out
}

var sevRank = map[string]int{"info": 0, "warning": 1, "critical": 2}

func severityMeetsMin(have, min string) bool {
	return sevRank[have] >= sevRank[min]
}

func severityAllowed(allowed []string, sev string) bool {
	for _, s := range allowed {
		if s == sev {
			return true
		}
	}
	return false
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
