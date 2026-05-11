package autonomy

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Worker periodically pulls pending tasks and invokes the autonomy pipeline.
// Auto-eligible tasks transition to 'approved' with approved_by='ai-auto'.
// Non-eligible tasks stay pending until a human clicks Approve.
//
// The aireview worker (multi-round LLM review) runs in parallel and feeds
// the `ai_consensus` factor — this worker only consumes the result.
type Worker struct {
	pg       *store.PG
	rt       *runtime.Snapshot
	pipeline *Pipeline
	log      *zap.Logger
}

func NewWorker(pg *store.PG, rt *runtime.Snapshot, p *Pipeline, log *zap.Logger) *Worker {
	return &Worker{pg: pg, rt: rt, pipeline: p, log: log}
}

func (w *Worker) Run(ctx context.Context) {
	w.log.Info("autonomy worker started")
	for {
		interval := time.Duration(w.rt.Int("autonomy.worker_interval_seconds", 30)) * time.Second
		if interval < 5*time.Second {
			interval = 5 * time.Second
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			if err := w.onePass(ctx); err != nil {
				w.log.Warn("autonomy pass", zap.Error(err))
			}
		}
	}
}

func (w *Worker) onePass(ctx context.Context) error {
	pending, err := w.pg.ListTasks(ctx, "pending", 100)
	if err != nil {
		return fmt.Errorf("list pending: %w", err)
	}
	for _, t := range pending {
		if err := ctx.Err(); err != nil {
			return err
		}
		res, err := w.pipeline.Decide(ctx, t)
		if err != nil {
			w.log.Warn("pipeline decide", zap.String("task", t.ID.String()), zap.Error(err))
			continue
		}
		if res.Verdict != VerdictAutoProceed {
			// Leave pending; the pipeline already recorded the reason.
			continue
		}
		// Promote to approved + audit.
		if err := w.pg.UpdateTaskStatus(ctx, t.ID, "approved", "ai-auto"); err != nil {
			w.log.Warn("auto-approve", zap.String("task", t.ID.String()), zap.Error(err))
			continue
		}
		_ = w.pg.Audit(ctx, "ai-auto", "auto_approve", "task", t.ID.String(),
			map[string]any{"autonomy_score": res.Score.Total, "threshold": res.Score.Threshold})
		w.log.Info("auto-approved by autonomy pipeline",
			zap.String("task", t.ID.String()),
			zap.Float64("score", res.Score.Total))
	}
	return nil
}
