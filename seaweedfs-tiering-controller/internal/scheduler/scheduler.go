// Package scheduler periodically scores all volumes across every registered
// cluster and queues recommendations. Honors per-cluster business_domain and
// the global holiday freeze window.
package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/executor"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/health"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/safety"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/scorer"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

var _ = health.NewGate // avoid import cycle quirk if rebuilt

type Scheduler struct {
	cfg   *config.Scheduler
	log   *zap.Logger
	cron  *cron.Cron
	pg    *store.PG
	ch    *store.CH
	sw    *seaweed.Client
	sc    *scorer.Scorer
	ex    *executor.Executor
	gate  *health.Gate
	guard *safety.Guard
	disp  *dispatcher
	mu    sync.Mutex
}

func New(cfg *config.Scheduler, log *zap.Logger, pg *store.PG, ch *store.CH,
	sw *seaweed.Client, sc *scorer.Scorer, ex *executor.Executor,
	gate *health.Gate, guard *safety.Guard, snap *runtime.Snapshot,
	press *pressure.Snapshot) *Scheduler {
	return &Scheduler{
		cfg: cfg, log: log, pg: pg, ch: ch, sw: sw, sc: sc, ex: ex,
		gate: gate, guard: guard,
		disp: newDispatcher(pg, ex, snap, press, log),
		cron: cron.New(),
	}
}

func (s *Scheduler) Start(ctx context.Context) error {
	if !s.cfg.Enabled {
		s.log.Info("scheduler disabled")
		return nil
	}
	if _, err := s.cron.AddFunc(s.cfg.ScoringCron, func() { _, _ = s.scoreOnce(ctx, nil) }); err != nil {
		return err
	}
	if _, err := s.cron.AddFunc(s.cfg.ExecutionCron, func() { s.executeOnce(ctx) }); err != nil {
		return err
	}
	s.cron.Start()
	s.log.Info("scheduler started",
		zap.String("scoring", s.cfg.ScoringCron),
		zap.String("execution", s.cfg.ExecutionCron),
		zap.Bool("dry_run_global", s.cfg.DryRunGlobal))
	return nil
}

func (s *Scheduler) Stop() { s.cron.Stop() }

// ScoreReport summarizes a synchronous scoring pass. Returned to the UI so
// the operator can tell "ran but found nothing" from "didn't run".
type ScoreReport struct {
	Clusters       int      `json:"clusters"`
	ClustersOK     int      `json:"clusters_ok"`
	VolumesScanned int      `json:"volumes_scanned"`
	VolumesNoop    int      `json:"volumes_noop"`
	// Coldness recommendation breakdown: how many volumes scored each action
	// (tier_upload / ec_encode / tier_download / ec_decode).
	RecsByAction   map[string]int `json:"recs_by_action,omitempty"`
	// Under-replication detector findings.
	UnderReplicated int      `json:"under_replicated"`
	MissingVolumes  []uint32 `json:"missing_volumes,omitempty"`
	TasksInserted  int      `json:"tasks_inserted"`
	TasksDuplicate int      `json:"tasks_duplicate"`
	TasksFailed    int      `json:"tasks_failed"`
	Errors         []string `json:"errors,omitempty"`
	// PerCluster lists what each cluster contributed so the UI can label
	// "扫描了 X 在 cluster-A, Y 在 cluster-B" instead of one opaque total.
	PerCluster []ClusterScanReport `json:"per_cluster,omitempty"`
}

// ClusterScanReport is one entry inside ScoreReport.PerCluster.
type ClusterScanReport struct {
	Name            string   `json:"name"`
	MasterAddr      string   `json:"master_addr,omitempty"`
	BusinessDomain  string   `json:"business_domain,omitempty"`
	Volumes         int      `json:"volumes"`
	Recs            int      `json:"recs"`
	UnderReplicated int      `json:"under_replicated"`
	MissingVolumes  []uint32 `json:"missing_volumes,omitempty"`
	Inserted        int      `json:"inserted"`
	Duplicate       int      `json:"duplicate"`
	Failed          int      `json:"failed"`
	Error           string   `json:"error,omitempty"`
}

// ScoreOnce runs a single scoring pass synchronously. Exposed for the API
// "Run scoring now" button. Returns a per-pass report so the UI can give
// concrete feedback even when no tasks were generated.
//
// `clusterFilter`, if non-nil, restricts the pass to clusters whose ID is
// in the set — the UI uses this to scope "Run scoring" to one cluster
// instead of fanning out to every registered cluster.
func (s *Scheduler) ScoreOnce(ctx context.Context, clusterFilter ...uuid.UUID) (ScoreReport, error) {
	if len(clusterFilter) == 0 {
		return s.scoreOnce(ctx, nil)
	}
	set := make(map[uuid.UUID]struct{}, len(clusterFilter))
	for _, id := range clusterFilter {
		set[id] = struct{}{}
	}
	return s.scoreOnce(ctx, set)
}

func (s *Scheduler) scoreOnce(ctx context.Context, clusterFilter map[uuid.UUID]struct{}) (ScoreReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := time.Now()
	defer func() { metrics.ScoringDuration.Observe(time.Since(start).Seconds()) }()

	rep := ScoreReport{}
	clusters, err := s.pg.ListClusters(ctx)
	if err != nil {
		s.log.Error("list clusters", zap.Error(err))
		return rep, err
	}
	if len(clusters) == 0 {
		// Fall back to single configured master so MVP without registered clusters still works.
		rep.Clusters = 1
		err := s.scoreCluster(ctx, store.Cluster{Name: "default", BusinessDomain: "other"}, "", &rep)
		if err == nil {
			rep.ClustersOK = 1
		}
		return rep, err
	}
	for _, c := range clusters {
		if !c.Enabled {
			continue
		}
		if clusterFilter != nil {
			if _, ok := clusterFilter[c.ID]; !ok {
				continue
			}
		}
		rep.Clusters++
		// Snapshot counters so we can diff what THIS cluster contributed.
		before := rep
		recsBefore := totalRecs(rep.RecsByAction)
		missingBefore := len(rep.MissingVolumes)

		entry := ClusterScanReport{
			Name: c.Name, MasterAddr: c.MasterAddr, BusinessDomain: c.BusinessDomain,
		}
		if err := s.scoreCluster(ctx, c, c.MasterAddr, &rep); err != nil {
			s.log.Warn("score cluster", zap.String("name", c.Name), zap.Error(err))
			rep.Errors = append(rep.Errors, c.Name+": "+err.Error())
			entry.Error = err.Error()
			rep.PerCluster = append(rep.PerCluster, entry)
			continue
		}
		rep.ClustersOK++
		entry.Volumes = rep.VolumesScanned - before.VolumesScanned
		entry.Recs = totalRecs(rep.RecsByAction) - recsBefore
		entry.UnderReplicated = rep.UnderReplicated - before.UnderReplicated
		if entry.UnderReplicated > 0 {
			entry.MissingVolumes = append([]uint32{}, rep.MissingVolumes[missingBefore:]...)
		}
		entry.Inserted = rep.TasksInserted - before.TasksInserted
		entry.Duplicate = rep.TasksDuplicate - before.TasksDuplicate
		entry.Failed = rep.TasksFailed - before.TasksFailed
		rep.PerCluster = append(rep.PerCluster, entry)
	}
	return rep, nil
}

func totalRecs(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

func (s *Scheduler) scoreCluster(ctx context.Context, c store.Cluster, masterAddr string, rep *ScoreReport) error {
	vols, err := s.sw.ListVolumesAt(ctx, masterAddr)
	if err != nil {
		return err
	}
	if rep != nil {
		rep.VolumesScanned += len(vols)
	}
	// Snapshot node usage at the same time.
	if topo, terr := s.sw.FetchTopology(ctx, masterAddr); terr == nil {
		_ = s.snapshotUsage(ctx, c, topo)
	}

	// Sub-pass: under-replication detection. Counts replicas per volume_id
	// and emits fix_replication tasks for any volume whose live count is
	// below its declared replication policy. Independent of the coldness
	// scoring loop because the math + action are different.
	s.detectUnderReplicated(ctx, c, vols, rep)

	s.log.Info("scoring cluster", zap.String("name", c.Name), zap.Int("volumes", len(vols)))
	for _, v := range vols {
		feat, _ := s.ch.LatestVolumeFeatures(ctx, v.ID)
		rec := s.sc.Score(ctx, v, feat, c.BusinessDomain)
		// Bias by cyclical pattern + cohort z-score (best-effort: a missing
		// pattern row simply skips the bias).
		if pat, perr := s.ch.LatestPattern(ctx, v.ID); perr == nil {
			scorer.ApplyPatternBias(&rec, pat)
		}
		if rec.Action == "noop" {
			if rep != nil {
				rep.VolumesNoop++
			}
			continue
		}
		if rep != nil {
			if rep.RecsByAction == nil {
				rep.RecsByAction = map[string]int{}
			}
			rep.RecsByAction[rec.Action]++
		}
		if hot, _ := s.pg.InCooldown(ctx, int32(v.ID), s.cfg.CooldownDays); hot {
			continue
		}
		featJSON, _ := json.Marshal(rec.Features)
		targetJSON, _ := json.Marshal(rec.Target)
		clusterID := c.ID
		domain := c.BusinessDomain
		t := store.Task{
			VolumeID:    int32(v.ID),
			Collection:  v.Collection,
			SrcServer:   v.Server,
			SrcDiskType: v.DiskType,
			Action:      rec.Action,
			Target:      targetJSON,
			Score:       rec.Score,
			Features:    featJSON,
			Explanation: rec.Explanation,
			Status:      "pending",
		}
		t.IdempotencyKey = executor.IdempotencyKey(t)
		metrics.ScoringVolumes.WithLabelValues(rec.Action).Inc()
		if _, err := s.pg.InsertTaskWithCluster(ctx, t, &clusterID, &domain); err != nil {
			if err == store.ErrDuplicateTask {
				metrics.TasksInserted.WithLabelValues(rec.Action, "duplicate").Inc()
				if rep != nil {
					rep.TasksDuplicate++
				}
				continue
			}
			metrics.TasksInserted.WithLabelValues(rec.Action, "error").Inc()
			s.log.Warn("insert task", zap.Uint32("vol", v.ID), zap.Error(err))
			if rep != nil {
				rep.TasksFailed++
				rep.Errors = append(rep.Errors,
					fmt.Sprintf("vol=%d action=%s: %s", v.ID, rec.Action, err))
			}
			continue
		}
		metrics.TasksInserted.WithLabelValues(rec.Action, "inserted").Inc()
		if rep != nil {
			rep.TasksInserted++
		}
	}
	return nil
}

func (s *Scheduler) snapshotUsage(ctx context.Context, c store.Cluster, topo *seaweed.Topology) error {
	now := time.Now()
	rows := []store.NodeUsage{}
	for _, dc := range topo.DataCenters {
		for _, rack := range dc.Racks {
			for _, node := range rack.Nodes {
				for _, disk := range node.Disks {
					rows = append(rows, store.NodeUsage{
						SnapshotAt: now, ClusterID: c.ID,
						DataCenter: dc.ID, Rack: rack.ID, Node: node.ID,
						DiskType: disk.Type, Capacity: int64(disk.Capacity),
						Used: int64(disk.Used), VolumeCount: int32(disk.VolumeCount),
					})
				}
			}
		}
	}
	return s.pg.PutNodeUsage(ctx, rows)
}

// detectUnderReplicated walks the volume list, groups by volume_id, and
// emits a fix_replication task for any volume whose live replica count is
// below the count declared by its ReplicaPlace policy.
//
// SeaweedFS replication encoding: a 3-digit number xyz where
//   x = extra DC copies, y = extra rack copies, z = extra server copies.
// Total expected replicas = 1 + x + y + z.
func (s *Scheduler) detectUnderReplicated(ctx context.Context, c store.Cluster, vols []seaweed.VolumeInfo, rep *ScoreReport) {
	type group struct {
		expected int
		live     []seaweed.VolumeInfo
	}
	groups := map[uint32]*group{}
	for _, v := range vols {
		g := groups[v.ID]
		if g == nil {
			g = &group{expected: expectedReplicaCount(v.ReplicaPlace)}
			groups[v.ID] = g
		}
		g.live = append(g.live, v)
	}

	// Pre-pass for the single-replica case (replication=000): if a volume
	// id is missing from the contiguous range [1..maxID] but was once
	// allocated, treat it as a deletion. This is a demo-grade heuristic —
	// gaps in volume IDs can be legitimate (manual deletes, capacity
	// pruning), so the operator confirms via approve.
	maxID := uint32(0)
	for _, v := range vols {
		if v.ID > maxID {
			maxID = v.ID
		}
	}
	for vid := uint32(1); vid <= maxID; vid++ {
		if _, present := groups[vid]; present {
			continue
		}
		// Synthesize a "0 alive, 1 expected" group so the loop below emits
		// a fix_replication task with sensible explanation.
		groups[vid] = &group{expected: 1, live: nil}
	}

	for vid, g := range groups {
		if len(g.live) >= g.expected {
			continue
		}
		missing := g.expected - len(g.live)

		// Pick a representative when at least one replica is alive; otherwise
		// build a synthetic placeholder so the inserted task still has the
		// fields the executor / UI expect.
		var collection, server, diskType string
		var rp uint32
		if len(g.live) > 0 {
			ref := g.live[0]
			collection, server, diskType, rp = ref.Collection, ref.Server, ref.DiskType, ref.ReplicaPlace
		}
		explanation := fmt.Sprintf(
			"under-replicated: %d/%d replicas alive (replication=%03d, missing=%d)",
			len(g.live), g.expected, rp, missing)
		if len(g.live) == 0 {
			explanation = fmt.Sprintf(
				"volume_id=%d completely missing from master (likely deleted single-replica)", vid)
		}
		if rep != nil {
			rep.UnderReplicated++
			rep.MissingVolumes = append(rep.MissingVolumes, vid)
			if rep.RecsByAction == nil {
				rep.RecsByAction = map[string]int{}
			}
			rep.RecsByAction["fix_replication"]++
		}

		featJSON, _ := json.Marshal(map[string]float64{
			"replicas_alive":    float64(len(g.live)),
			"replicas_expected": float64(g.expected),
			"missing":           float64(missing),
		})
		targetJSON, _ := json.Marshal(map[string]any{
			"missing":  missing,
			"expected": g.expected,
		})

		clusterID := c.ID
		domain := c.BusinessDomain
		t := store.Task{
			VolumeID:    int32(vid),
			Collection:  collection,
			SrcServer:   server,
			SrcDiskType: diskType,
			Action:      "fix_replication",
			Target:      targetJSON,
			// Higher score = higher priority. Missing all but one replica
			// is far more urgent than one missing copy in a 3-replica setup.
			Score:       0.7 + 0.05*float64(missing),
			Features:    featJSON,
			Explanation: explanation,
			Status:      "pending",
		}
		t.IdempotencyKey = executor.IdempotencyKey(t)
		metrics.ScoringVolumes.WithLabelValues("fix_replication").Inc()

		if _, err := s.pg.InsertTaskWithCluster(ctx, t, &clusterID, &domain); err != nil {
			if err == store.ErrDuplicateTask {
				metrics.TasksInserted.WithLabelValues("fix_replication", "duplicate").Inc()
				if rep != nil {
					rep.TasksDuplicate++
				}
				continue
			}
			metrics.TasksInserted.WithLabelValues("fix_replication", "error").Inc()
			s.log.Warn("insert fix_replication task", zap.Uint32("vol", vid), zap.Error(err))
			if rep != nil {
				rep.TasksFailed++
				rep.Errors = append(rep.Errors,
					fmt.Sprintf("vol=%d action=fix_replication: %s", vid, err))
			}
			continue
		}
		metrics.TasksInserted.WithLabelValues("fix_replication", "inserted").Inc()
		if rep != nil {
			rep.TasksInserted++
		}
		s.log.Info("under-replicated volume detected",
			zap.Uint32("vol", vid),
			zap.Int("alive", len(g.live)),
			zap.Int("expected", g.expected))
	}
}

// expectedReplicaCount decodes SeaweedFS's 3-digit replication policy.
//   000 → 1, 001 → 2, 010 → 2, 100 → 2, 011 → 3, 200 → 3, 222 → 7…
func expectedReplicaCount(rp uint32) int {
	dc := int((rp / 100) % 10)
	rack := int((rp / 10) % 10)
	host := int(rp % 10)
	return 1 + dc + rack + host
}

func (s *Scheduler) executeOnce(ctx context.Context) {
	if s.cfg.DryRunGlobal {
		return
	}
	// Health gate.
	if s.gate != nil {
		if ok, reason := s.gate.Healthy(); !ok {
			s.log.Warn("execution skipped: health gate", zap.String("reason", reason))
			return
		}
	}
	// Safety guard (emergency_stop / change_window / maintenance / holiday).
	if s.guard != nil {
		v := s.guard.Allow(ctx, nil, time.Now())
		if !v.Allowed {
			s.log.Info("execution skipped: safety guard",
				zap.String("code", v.Code), zap.String("reason", v.Reason))
			return
		}
	}
	// Pre-filter: cancel tasks that hit the blocklist before they reach the dispatcher.
	if s.guard != nil {
		tasks, err := s.pg.ListTasks(ctx, "approved", 200)
		if err == nil {
			for _, t := range tasks {
				if blockedBy, _ := s.guard.BlockedBy(ctx, "", t.Collection, "", t.VolumeID, t.Action); blockedBy != "" {
					s.log.Info("task blocked", zap.String("id", t.ID.String()), zap.String("blocked_by", blockedBy))
					_ = s.pg.UpdateTaskStatus(ctx, t.ID, "cancelled", "blocklist")
				}
			}
		}
	}
	// Hand off to the dispatcher: ranks, throttles, and runs in goroutines.
	s.disp.dispatch(ctx)
}
