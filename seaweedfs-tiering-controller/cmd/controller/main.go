package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/aireview"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/autonomy"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analytics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/api"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/crypto"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/executor"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/health"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/safety"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/scheduler"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/scorer"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func main() {
	cfgPath := flag.String("config", "", "path to config yaml")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	logger, _ := zap.NewProduction()
	defer logger.Sync()

	metrics.BuildInfo.WithLabelValues("dev", "unknown").Set(1)

	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pg, err := store.NewPG(rootCtx, cfg.Postgres.DSN, cfg.Postgres.MaxConns)
	if err != nil {
		logger.Fatal("pg", zap.Error(err))
	}
	defer pg.Close()

	ch, err := store.NewCH(rootCtx, cfg.ClickHouse.Addr, cfg.ClickHouse.Database,
		cfg.ClickHouse.Username, cfg.ClickHouse.Password)
	if err != nil {
		logger.Fatal("clickhouse", zap.Error(err))
	}
	defer ch.Close()

	snapshot, err := runtime.New(rootCtx, pg.Pool, logger)
	if err != nil {
		logger.Fatal("config snapshot", zap.Error(err))
	}

	// Master encryption key for AI provider credentials, storage backends, etc.
	// Optional at startup — operations that need encryption fail loudly if absent.
	cryptoEnc, cryptoErr := crypto.FromEnv()
	if cryptoErr != nil {
		logger.Warn("TIER_MASTER_KEY not loaded; AI/backend secrets will require env-var fallback",
			zap.Error(cryptoErr))
	}

	sw := seaweed.New(cfg.Seaweed.Master, cfg.Seaweed.GrpcDialTimeout)
	provider, err := ai.Build(&cfg.AI)
	if err != nil {
		logger.Fatal("ai provider", zap.Error(err))
	}
	sc := scorer.New(&cfg.Scoring, provider)
	ex := executor.New(pg, sw, logger, cfg.Executor.RetainLocalDat)

	alerts := alerter.New(pg, logger)
	go alerts.Run(rootCtx)

	gate := health.NewGate()
	scraper := health.New(pg, logger, gate, alerts)
	go scraper.Run(rootCtx)

	// Pressure: continuous 0..1 per-cluster busy score. Sampler refreshes
	// every pressure.sample_interval_seconds; scheduler + watchdog read
	// from the in-memory snapshot.
	pressSnap := pressure.NewSnapshot()
	pressSampler := pressure.NewSampler(pg, pressSnap, snapshot, logger)
	go pressSampler.Run(rootCtx)
	ex.SetPressure(pressSnap)
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-rootCtx.Done():
				return
			case <-t.C:
				_ = pg.PruneHealthSamples(rootCtx, 7*24*time.Hour)
			}
		}
	}()

	guard := safety.New(pg, snapshot)

	// Skill registry: upsert built-in catalog (only upgrades when shipped
	// version is higher), then load enabled definitions into memory.
	if up, err := skill.SyncBuiltins(rootCtx, pg, logger); err != nil {
		logger.Warn("skill catalog sync", zap.Error(err))
	} else if up > 0 {
		logger.Info("skill catalog upgraded", zap.Int("count", up))
	}
	skills := skill.New(pg, logger)
	if err := skills.Reload(rootCtx); err != nil {
		logger.Warn("skill registry reload", zap.Error(err))
	}
	ex.AttachSkills(skills)

	// Analytics: cyclical detection + cohort z-score, refreshed hourly.
	analyticsRunner := analytics.NewRunner(pg, ch, sw, logger, time.Hour)
	go analyticsRunner.Run(rootCtx)

	// Multi-round AI safety review service.
	aiResolver := ai.NewResolver(cryptoEnc, cfg.AI.RequestTimeout)
	aiReviewSvc := aireview.NewService(pg, aiResolver, provider, logger)

	// Auto-postmortem: on every failed execution, run a single-round AI
	// diagnosis and persist the verdict + recommendation to executions row.
	// The UI then offers a one-click "apply suggestion" button.
	ex.SetPostmortemHook(func(execID uuid.UUID, t store.Task, skillKey, log, errStr string) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res, err := aiReviewSvc.RunPostmortem(ctx, aireview.PostmortemInput{
			TaskID: t.ID, ExecID: execID, VolumeID: uint32(t.VolumeID),
			Action: t.Action, SkillKey: skillKey,
			Status: "failed", Error: errStr, Log: log,
		})
		if err != nil {
			logger.Warn("postmortem failed", zap.String("exec", execID.String()), zap.Error(err))
			return
		}
		if perr := pg.SetExecutionPostmortem(ctx, execID, res); perr != nil {
			logger.Warn("save postmortem", zap.Error(perr))
		}
	})

	// Background worker: scans pending tasks, runs reviews, optional auto-approve.
	aiReviewWorker := aireview.NewWorker(pg, ch, skills, aiReviewSvc, snapshot, logger)
	go aiReviewWorker.Run(rootCtx)

	// Autonomy pipeline: combines AI review + pressure + risk + blast radius
	// + change window into one autonomy_score and decides whether to auto-
	// approve. Replaces the legacy single-factor auto-approve gate.
	autoPipeline := autonomy.NewPipeline(pg, snapshot, skills, pressSnap, aiReviewSvc, logger)
	go autonomy.NewWorker(pg, snapshot, autoPipeline, logger).Run(rootCtx)
	ex.SetPreExecuteChecker(autoPipeline)

	// Counterfactual labeler: post-hoc grading of AI verdicts.
	aiLabeler := aireview.NewLabeler(pg, ch, snapshot, logger)
	go aiLabeler.Run(rootCtx)
	sched := scheduler.New(&cfg.Scheduler, logger, pg, ch, sw, sc, ex, gate, guard, snapshot, pressSnap)
	if err := sched.Start(rootCtx); err != nil {
		logger.Fatal("scheduler", zap.Error(err))
	}
	defer sched.Stop()

	resolver := auth.NewResolver(pg.Pool)
	capsLoader := auth.NewCapsLoader(pg.Pool)
	// First-boot seeding: if admin@local has no password_hash yet,
	// install bcrypt("admin"). must_reset_password stays TRUE so the
	// operator is forced to change it before any real work.
	if err := auth.EnsureSeedAdminPassword(rootCtx, pg.Pool); err != nil {
		logger.Warn("seed admin password", zap.Error(err))
	}

	// Dev-mode header shortcut is allowed only when the listener is loopback.
	devAuth := strings.HasPrefix(cfg.Server.HTTPAddr, "127.0.0.1:") ||
		strings.HasPrefix(cfg.Server.HTTPAddr, "localhost:") ||
		cfg.Server.HTTPAddr == ":8080"
	logger.Info("auth mode", zap.Bool("dev_header_allowed", devAuth))

	router := api.Router(api.Deps{
		PG: pg, CH: ch, Sw: sw, Exec: ex, Sched: sched, AI: provider,
		Snapshot: snapshot, Resolver: resolver, Caps: capsLoader, Gate: gate, Alerts: alerts,
		Guard: guard, Skills: skills, Analytics: analyticsRunner,
		AIReview: aiReviewSvc, Pressure: pressSnap, Crypto: cryptoEnc, DevAuth: devAuth, Log: logger,
	})

	srv := &http.Server{
		Addr:              cfg.Server.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		logger.Info("listening", zap.String("addr", cfg.Server.HTTPAddr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("http", zap.Error(err))
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	logger.Info("shutting down")
	shutdownCtx, scancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer scancel()
	_ = srv.Shutdown(shutdownCtx)
}
