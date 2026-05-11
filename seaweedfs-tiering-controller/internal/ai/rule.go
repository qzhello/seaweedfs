package ai

import (
	"context"
	"fmt"
	"math"
)

// Rule provider — deterministic, no external calls. Default fallback.
type Rule struct{}

func NewRule() *Rule { return &Rule{} }

func (r *Rule) Name() string { return "rule" }

func (r *Rule) Explain(_ context.Context, in ExplainInput) (string, error) {
	parts := topContributors(in.Features, 3)
	return fmt.Sprintf("[rule] volume %d → %s (score %.2f). drivers: %s",
		in.VolumeID, in.Action, in.Score, parts), nil
}

func (r *Rule) Predict(_ context.Context, f map[string]float64) (float64, error) {
	// crude logistic on access decay
	x := f["last_access_decay"]*2 + f["access_count_30d"]*1.5 - 1.0
	return 1.0 / (1.0 + math.Exp(-x)), nil
}

func topContributors(f map[string]float64, n int) string {
	type kv struct {
		k string
		v float64
	}
	xs := make([]kv, 0, len(f))
	for k, v := range f {
		xs = append(xs, kv{k, v})
	}
	// simple insertion sort, tiny n
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j].v > xs[j-1].v; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
	if n > len(xs) {
		n = len(xs)
	}
	out := ""
	for i := 0; i < n; i++ {
		if i > 0 {
			out += ", "
		}
		out += fmt.Sprintf("%s=%.2f", xs[i].k, xs[i].v)
	}
	return out
}
