package ai

import (
	"context"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
)

// instrumented wraps any Provider with Prometheus latency + error metrics.
// Used by Build() so the metrics layer is invisible to callers.
type instrumented struct {
	inner Provider
}

func wrap(p Provider) Provider { return &instrumented{inner: p} }

func (i *instrumented) Name() string { return i.inner.Name() }

func (i *instrumented) Explain(ctx context.Context, in ExplainInput) (string, error) {
	start := time.Now()
	out, err := i.inner.Explain(ctx, in)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "explain").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "explain").Inc()
	}
	return out, err
}

func (i *instrumented) Predict(ctx context.Context, f map[string]float64) (float64, error) {
	start := time.Now()
	out, err := i.inner.Predict(ctx, f)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "predict").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "predict").Inc()
	}
	return out, err
}
