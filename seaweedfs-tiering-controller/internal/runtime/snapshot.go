// Package runtime holds the live in-memory configuration snapshot. Every
// component reads from here instead of the YAML file, so admins can change
// values via the Web UI and have them apply within a few seconds without a
// restart (for hot keys).
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Snapshot is the single source of truth for runtime configuration.
// It is goroutine-safe and updated in-place; readers should not cache returned
// pointers across goroutine boundaries beyond a single decision.
type Snapshot struct {
	pool   *pgxpool.Pool
	log    *zap.Logger
	values atomic.Pointer[map[string]json.RawMessage]
	mu     sync.Mutex // serializes reload+notify
}

func New(ctx context.Context, pool *pgxpool.Pool, log *zap.Logger) (*Snapshot, error) {
	s := &Snapshot{pool: pool, log: log}
	if err := s.reload(ctx); err != nil {
		return nil, fmt.Errorf("initial config load: %w", err)
	}
	go s.listen(ctx)
	return s, nil
}

func (s *Snapshot) reload(ctx context.Context) error {
	pg := &store.PG{Pool: s.pool}
	entries, err := pg.ListConfig(ctx)
	if err != nil {
		return err
	}
	m := make(map[string]json.RawMessage, len(entries))
	for _, e := range entries {
		m[e.Key] = e.Value
	}
	s.values.Store(&m)
	s.log.Info("config snapshot loaded", zap.Int("keys", len(m)))
	return nil
}

// listen subscribes to PG NOTIFY 'config_changed' and triggers a partial reload
// for the affected key. Falls back to a full reload every 60s as a safety net.
func (s *Snapshot) listen(ctx context.Context) {
	backoff := time.Second
	for {
		conn, err := s.pool.Acquire(ctx)
		if err != nil {
			s.log.Warn("listen acquire", zap.Error(err))
			select {
			case <-time.After(backoff):
				backoff = minDur(backoff*2, 30*time.Second)
				continue
			case <-ctx.Done():
				return
			}
		}
		raw := conn.Hijack()
		if _, err := raw.Exec(ctx, "LISTEN config_changed"); err != nil {
			s.log.Warn("LISTEN failed", zap.Error(err))
			raw.Close(ctx)
			continue
		}
		backoff = time.Second
		s.consume(ctx, raw)
		raw.Close(ctx)
	}
}

func (s *Snapshot) consume(ctx context.Context, conn *pgx.Conn) {
	deadline := time.NewTicker(60 * time.Second)
	defer deadline.Stop()
	for {
		notifyCtx, cancel := context.WithTimeout(ctx, 70*time.Second)
		n, err := conn.WaitForNotification(notifyCtx)
		cancel()
		if err != nil {
			// Timeout is expected; do a periodic full reload to self-heal.
			if ctx.Err() == nil {
				_ = s.reload(ctx)
				continue
			}
			return
		}
		s.log.Info("config changed", zap.String("key", n.Payload))
		_ = s.reloadKey(ctx, n.Payload)
	}
}

func (s *Snapshot) reloadKey(ctx context.Context, key string) error {
	pg := &store.PG{Pool: s.pool}
	e, err := pg.GetConfig(ctx, key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.values.Load()
	next := make(map[string]json.RawMessage, len(*cur)+1)
	for k, v := range *cur {
		next[k] = v
	}
	next[key] = e.Value
	s.values.Store(&next)
	return nil
}

// ---------------------------- Typed accessors ----------------------------

func (s *Snapshot) Bool(key string, def bool) bool {
	if v, ok := s.raw(key); ok {
		var b bool
		if err := json.Unmarshal(v, &b); err == nil {
			return b
		}
	}
	return def
}

func (s *Snapshot) Int(key string, def int) int {
	if v, ok := s.raw(key); ok {
		var n int
		if err := json.Unmarshal(v, &n); err == nil {
			return n
		}
	}
	return def
}

func (s *Snapshot) Float(key string, def float64) float64 {
	if v, ok := s.raw(key); ok {
		var f float64
		if err := json.Unmarshal(v, &f); err == nil {
			return f
		}
	}
	return def
}

func (s *Snapshot) String(key string, def string) string {
	if v, ok := s.raw(key); ok {
		var x string
		if err := json.Unmarshal(v, &x); err == nil {
			return x
		}
		return string(v)
	}
	return def
}

func (s *Snapshot) Duration(key string, def time.Duration) time.Duration {
	str := s.String(key, "")
	if str == "" {
		return def
	}
	if d, err := time.ParseDuration(str); err == nil {
		return d
	}
	return def
}

// JSON returns the raw JSON bytes for a key, or nil. Callers can unmarshal
// into any shape (typically an object or array). Useful for config rows that
// hold whole-document values like `pressure.weights`.
func (s *Snapshot) JSON(key string) json.RawMessage {
	if v, ok := s.raw(key); ok {
		return json.RawMessage(v)
	}
	return nil
}

// FloatMap collects all keys with a common prefix into a flat map keyed by the
// final segment. Convenient for things like scoring.weights.* → {"foo":0.4,...}.
func (s *Snapshot) FloatMap(prefix string) map[string]float64 {
	out := map[string]float64{}
	cur := s.values.Load()
	for k, v := range *cur {
		if !startsWith(k, prefix) {
			continue
		}
		var f float64
		if err := json.Unmarshal(v, &f); err == nil {
			out[k[len(prefix):]] = f
			continue
		}
		// support stringified numbers in case of mistype
		if n, err := strconv.ParseFloat(string(v), 64); err == nil {
			out[k[len(prefix):]] = n
		}
	}
	return out
}

func (s *Snapshot) raw(key string) (json.RawMessage, bool) {
	cur := s.values.Load()
	if cur == nil {
		return nil, false
	}
	v, ok := (*cur)[key]
	return v, ok
}

func startsWith(s, p string) bool {
	return len(s) >= len(p) && s[:len(p)] == p
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
