package scheduler

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"golang.org/x/time/rate"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/executor"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// dispatcher pulls approved tasks, ranks them, and dispatches them respecting
// two global throttles read from runtime.Snapshot:
//
//	executor.parallel_limit   — max in-flight migrations
//	executor.start_per_minute — token bucket on new starts
//
// Both are hot-reloadable. Limiter is rebuilt when start_per_minute changes.
type dispatcher struct {
	pg       *store.PG
	ex       *executor.Executor
	snapshot *runtime.Snapshot
	pressure *pressure.Snapshot
	log      *zap.Logger

	mu       sync.Mutex
	starter  *rate.Limiter
	starterN int // last value of start_per_minute

	semCh chan struct{}
	semN  int

	// Per-cluster active-task semaphore for Phase B concurrency caps. Built
	// lazily on first use; cap comes from runtime config.
	clusterSemMu sync.Mutex
	clusterSem   map[uuid.UUID]chan struct{}
	clusterSemN  map[uuid.UUID]int
}

func newDispatcher(pg *store.PG, ex *executor.Executor, snap *runtime.Snapshot, press *pressure.Snapshot, log *zap.Logger) *dispatcher {
	d := &dispatcher{
		pg: pg, ex: ex, snapshot: snap, pressure: press, log: log,
		clusterSem:  map[uuid.UUID]chan struct{}{},
		clusterSemN: map[uuid.UUID]int{},
	}
	d.refreshLimits()
	return d
}

// refreshLimits rebuilds the rate limiter and concurrency semaphore if config
// changed. Called once per dispatch tick — cheap.
func (d *dispatcher) refreshLimits() {
	d.mu.Lock()
	defer d.mu.Unlock()

	startPerMin := 10
	parallel := 4
	if d.snapshot != nil {
		startPerMin = d.snapshot.Int("executor.start_per_minute", 10)
		parallel = d.snapshot.Int("executor.parallel_limit", 4)
	}
	if startPerMin < 1 {
		startPerMin = 1
	}
	if parallel < 1 {
		parallel = 1
	}
	if startPerMin != d.starterN {
		// Token every (60/N) seconds; burst = N (one minute's worth).
		d.starter = rate.NewLimiter(rate.Limit(float64(startPerMin)/60.0), startPerMin)
		d.starterN = startPerMin
	}
	if parallel != d.semN {
		// Replace the semaphore. In-flight tasks holding old slots will
		// release them onto the abandoned channel, which is fine — we just
		// can't reuse those slots, but next tick replenishes correctly.
		d.semCh = make(chan struct{}, parallel)
		d.semN = parallel
	}
}

// dispatch fetches approved tasks, prioritizes them, and runs eligible ones.
// Returns when the per-minute starter is exhausted or no tasks remain.
func (d *dispatcher) dispatch(ctx context.Context) {
	d.refreshLimits()

	// Promote any 'scheduled' tasks whose target cluster is now below the
	// pressure threshold to 'approved'. Tasks land in 'scheduled' via the
	// postmortem "apply suggestion" flow + manual /tasks/:id/schedule.
	d.promoteScheduledIfQuiet(ctx)

	tasks, err := d.pg.ListTasks(ctx, "approved", 200)
	if err != nil {
		d.log.Error("list approved tasks", zap.Error(err))
		return
	}
	if len(tasks) == 0 {
		return
	}
	sort.Slice(tasks, func(i, j int) bool {
		// Higher score first; tie-break: action priority (tier_upload < ec_encode).
		if tasks[i].Score != tasks[j].Score {
			return tasks[i].Score > tasks[j].Score
		}
		return actionPriority(tasks[i].Action) < actionPriority(tasks[j].Action)
	})

	for _, t := range tasks {
		// Phase A: hold tasks whose target cluster is over pressure threshold.
		// Mark them 'scheduled' so the UI shows the right state and a future
		// dispatch tick promotes them once pressure drops.
		if t.ClusterID != nil && d.pressure != nil && d.pressure.IsBusy(*t.ClusterID) {
			if err := d.pg.UpdateTaskStatus(ctx, t.ID, "scheduled", ""); err == nil {
				sc, _ := d.pressure.Get(*t.ClusterID)
				d.log.Info("deferring task; cluster busy",
					zap.String("task", t.ID.String()),
					zap.Float64("pressure", sc.Value),
					zap.Float64("threshold", d.pressure.Threshold()))
			}
			continue
		}
		// Per-minute starter (non-blocking): if no token, defer to next tick.
		if !d.starter.Allow() {
			d.log.Debug("starter rate-limited; deferring remaining tasks")
			return
		}
		// Concurrency slot (global).
		select {
		case d.semCh <- struct{}{}:
		case <-ctx.Done():
			return
		default:
			d.log.Debug("parallel_limit reached; deferring",
				zap.String("task", t.ID.String()))
			return
		}
		// Per-cluster concurrency cap (Phase B). Skip if the cluster is at
		// its cap — release the global slot we just took.
		if t.ClusterID != nil && !d.acquireClusterSlot(*t.ClusterID) {
			<-d.semCh
			d.log.Debug("per-cluster cap reached; deferring",
				zap.String("task", t.ID.String()))
			continue
		}
		go func(task store.Task) {
			defer func() {
				<-d.semCh
				if task.ClusterID != nil {
					d.releaseClusterSlot(*task.ClusterID)
				}
			}()
			start := time.Now()
			_, err := d.ex.Run(ctx, task, nil)
			metrics.ExecutorPhaseDuration.WithLabelValues(task.Action, "wall").
				Observe(time.Since(start).Seconds())
			if err != nil {
				d.log.Warn("dispatch run", zap.String("id", task.ID.String()), zap.Error(err))
			}
		}(t)
	}
}

// promoteScheduledIfQuiet flips 'scheduled' tasks back to 'approved' once
// their cluster's pressure score has dropped below threshold. Runs once per
// dispatch tick so re-entry into the main loop picks them up immediately.
func (d *dispatcher) promoteScheduledIfQuiet(ctx context.Context) {
	if d.pressure == nil {
		return
	}
	tasks, err := d.pg.ListTasks(ctx, "scheduled", 500)
	if err != nil {
		return
	}
	for _, t := range tasks {
		if t.ClusterID == nil || !d.pressure.IsBusy(*t.ClusterID) {
			if err := d.pg.UpdateTaskStatus(ctx, t.ID, "approved", ""); err == nil {
				d.log.Info("promoted scheduled→approved (pressure dropped)",
					zap.String("task", t.ID.String()))
			}
		}
	}
}

// acquireClusterSlot returns true if there's room under per_cluster_limit
// for this cluster. Built lazily on first sighting.
func (d *dispatcher) acquireClusterSlot(clusterID uuid.UUID) bool {
	d.clusterSemMu.Lock()
	defer d.clusterSemMu.Unlock()

	cap := 2 // sensible default — 2 concurrent ops per cluster
	if d.snapshot != nil {
		cap = d.snapshot.Int("executor.per_cluster_limit", 2)
	}
	if cap < 1 {
		cap = 1
	}
	if d.clusterSemN[clusterID] != cap {
		// Cap changed (or first time) — rebuild. Lose ledger of in-flight
		// counts; worst case we briefly over-admit by 1.
		d.clusterSem[clusterID] = make(chan struct{}, cap)
		d.clusterSemN[clusterID] = cap
	}
	select {
	case d.clusterSem[clusterID] <- struct{}{}:
		return true
	default:
		return false
	}
}

func (d *dispatcher) releaseClusterSlot(clusterID uuid.UUID) {
	d.clusterSemMu.Lock()
	ch := d.clusterSem[clusterID]
	d.clusterSemMu.Unlock()
	if ch != nil {
		<-ch
	}
}

// actionPriority orders concurrent actions when scores tie. Lower number = run
// first. Cheap reads finish fastest, leaving the slot free for the next.
func actionPriority(action string) int {
	switch action {
	case "tier_download":
		return 0 // recovery first
	case "ec_encode":
		return 1
	case "tier_upload":
		return 2
	case "tier_move":
		return 3
	}
	return 9
}
