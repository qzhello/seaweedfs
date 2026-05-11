package aireview

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Labeler is the post-hoc judge. After every executed task has cooled for
// observation_hours, it pulls the volume's actual access counts and decides
// whether the verdict was correct.
//
// Labeling rules:
//
//   verdict=proceed (we DID migrate)
//     reads_after >= rewarm_threshold ⇒ wrong (volume re-warmed; should not
//                                      have migrated). re_warmed = true.
//     reads_after <  rewarm_threshold ⇒ correct (truly cold).
//
//   verdict=abort (we DID NOT migrate)
//     reads_after >= rewarm_threshold ⇒ correct (the abort saved us a
//                                      re-warm). abort_was_safe = true.
//     reads_after <  rewarm_threshold ⇒ likely wrong (volume stayed cold;
//                                      we missed a migration opportunity).
//
//   verdict=needs_human ⇒ never auto-graded; operator decides.
type Labeler struct {
	pg   *store.PG
	ch   *store.CH
	snap *runtime.Snapshot
	log  *zap.Logger
}

func NewLabeler(pg *store.PG, ch *store.CH, snap *runtime.Snapshot, log *zap.Logger) *Labeler {
	return &Labeler{pg: pg, ch: ch, snap: snap, log: log}
}

func (l *Labeler) Run(ctx context.Context) {
	l.log.Info("ai review labeler started")
	for {
		intervalMin := l.snap.Int("ai_review.labeler_interval_minutes", 30)
		if intervalMin < 5 {
			intervalMin = 5
		}
		timer := time.NewTimer(time.Duration(intervalMin) * time.Minute)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			if l.snap.Bool("ai_review.labeler_enabled", true) {
				if err := l.OnePass(ctx); err != nil {
					l.log.Warn("labeler pass", zap.Error(err))
				}
			}
		}
	}
}

func (l *Labeler) OnePass(ctx context.Context) error {
	hours := l.snap.Int("ai_review.labeler_window_hours", 24)
	threshold := int64(l.snap.Int("ai_review.rewarm_threshold_reads", 100))

	cands, err := l.pg.FindLabelCandidates(ctx, hours, 200)
	if err != nil {
		return fmt.Errorf("find candidates: %w", err)
	}
	if len(cands) == 0 {
		return nil
	}

	labeled := 0
	for _, c := range cands {
		if err := ctx.Err(); err != nil {
			return err
		}
		out := l.label(ctx, c, hours, threshold)
		if err := l.pg.InsertAIOutcome(ctx, out); err != nil {
			l.log.Debug("insert outcome", zap.String("review", c.ReviewID.String()), zap.Error(err))
			continue
		}
		labeled++
	}
	if labeled > 0 {
		l.log.Info("labeler pass complete",
			zap.Int("candidates", len(cands)),
			zap.Int("labeled", labeled),
			zap.Int("hours", hours))
	}
	return nil
}

// label is the pure decision: given a candidate + measurements, return the
// outcome row. Errors fetching CH metrics produce a "skip" outcome with
// was_correct=false and an evidence note — better than silently dropping.
func (l *Labeler) label(ctx context.Context, c store.LabelCandidate, hours int, threshold int64) store.AIReviewOutcome {
	o := store.AIReviewOutcome{
		ReviewID:         c.ReviewID,
		TaskID:           c.TaskID,
		ObservationHours: hours,
		Verdict:          c.Verdict,
		Confidence:       c.Confidence,
		BusinessDomain:   c.BusinessDomain,
		ProviderName:     c.ProviderName,
	}
	since := c.FinishedAt
	reads, bytes, err := l.ch.ReadsSince(ctx, uint32(c.VolumeID), since)
	if err != nil {
		o.WasCorrect = false
		o.Evidence = "metrics fetch failed: " + err.Error()
		return o
	}
	o.ReadsAfter = &reads
	o.BytesAfter = &bytes

	rewarmed := reads >= threshold
	switch c.Verdict {
	case "proceed":
		// We migrated. Re-warm = wrong call.
		o.ReWarmed = &rewarmed
		if rewarmed {
			o.WasCorrect = false
			o.Evidence = fmt.Sprintf("verdict=proceed but volume re-warmed: reads=%d (threshold=%d)", reads, threshold)
		} else {
			o.WasCorrect = true
			o.Evidence = fmt.Sprintf("verdict=proceed and volume stayed cold: reads=%d", reads)
		}
	case "abort":
		// We DID NOT migrate. If it would have re-warmed, abort was a
		// good call. If it stayed cold, we left disk on the table.
		ok := rewarmed
		o.AbortWasSafe = &ok
		if rewarmed {
			o.WasCorrect = true
			o.Evidence = fmt.Sprintf("abort saved a re-warm: reads=%d", reads)
		} else {
			o.WasCorrect = false
			o.Evidence = fmt.Sprintf("abort but volume stayed cold (missed opportunity): reads=%d", reads)
		}
	case "needs_human":
		// We never automatically grade these. Mark as not-evaluated; operator
		// decides via the dashboard "manual label" action (sprint follow-up).
		o.WasCorrect = false
		o.Evidence = fmt.Sprintf("needs_human verdict — manual review required (reads=%d)", reads)
	default:
		o.WasCorrect = false
		o.Evidence = "unknown verdict; not graded"
	}
	return o
}
