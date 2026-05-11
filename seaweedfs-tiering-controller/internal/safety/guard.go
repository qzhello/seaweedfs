// Package safety centralizes the "should we proceed?" checks consulted by
// the scheduler before queueing or executing any migration. Order:
//
//  1. emergency_stop     (system_config: safety.emergency_stop)
//  2. change_window      (system_config: safety.change_window)
//  3. health gate        (Sprint 2-4)
//  4. holiday freeze     (Sprint 1)
//  5. maintenance_windows (this package)
//  6. blocklist          (this package, per-task)
//
// Each returns a structured Verdict so the UI can render a precise reason.
package safety

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type Verdict struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
	Code    string `json:"code,omitempty"` // emergency_stop | change_window | maintenance | blocklist | holiday
}

type Guard struct {
	pg       *store.PG
	snapshot *runtime.Snapshot
}

func New(pg *store.PG, snap *runtime.Snapshot) *Guard {
	return &Guard{pg: pg, snapshot: snap}
}

// Allow evaluates the global gates (everything except per-task blocklist).
// Caller still must call BlockedBy for individual task targets.
func (g *Guard) Allow(ctx context.Context, clusterID *uuid.UUID, now time.Time) Verdict {
	// 1. Emergency stop
	if g.snapshot != nil && g.snapshot.Bool("safety.emergency_stop", false) {
		return Verdict{Allowed: false, Code: "emergency_stop",
			Reason: "Emergency stop is engaged. Disable it in Settings → safety.emergency_stop."}
	}
	// 2. Change window
	if g.snapshot != nil {
		if blocked, reason := g.evalChangeWindow(now); blocked {
			return Verdict{Allowed: false, Code: "change_window", Reason: reason}
		}
	}
	// 5. Maintenance window (cluster-specific or global)
	if mw, _ := g.pg.ActiveMaintenance(ctx, clusterID); mw != nil {
		return Verdict{Allowed: false, Code: "maintenance",
			Reason: "Maintenance window: " + mw.Name + " ends " + mw.EndsAt.Format(time.RFC3339)}
	}
	// 4. Holiday freeze (existing helper)
	if frozen, name, _ := g.pg.InHolidayFreeze(ctx, now); frozen {
		return Verdict{Allowed: false, Code: "holiday",
			Reason: "Holiday freeze: " + name}
	}
	return Verdict{Allowed: true}
}

// BlockedBy is the per-task check.
func (g *Guard) BlockedBy(ctx context.Context, cluster, collection, bucket string,
	volumeID int32, action string) (string, error) {
	return g.pg.CheckBlocklist(ctx, cluster, collection, bucket, volumeID, action)
}

// evalChangeWindow returns (blocked, reason). Window config:
//
//	{"enabled": true, "start_hour": 1, "end_hour": 6, "weekdays_only": false, "timezone": "Asia/Shanghai"}
//
// Convention: tasks are *only allowed* INSIDE the window when enabled=true.
func (g *Guard) evalChangeWindow(now time.Time) (bool, string) {
	raw := g.snapshot.String("safety.change_window", "")
	if raw == "" {
		return false, ""
	}
	var w struct {
		Enabled      bool   `json:"enabled"`
		StartHour    int    `json:"start_hour"`
		EndHour      int    `json:"end_hour"`
		WeekdaysOnly bool   `json:"weekdays_only"`
		Timezone     string `json:"timezone"`
	}
	if err := json.Unmarshal([]byte(raw), &w); err != nil || !w.Enabled {
		return false, ""
	}
	loc := time.UTC
	if w.Timezone != "" {
		if l, err := time.LoadLocation(w.Timezone); err == nil {
			loc = l
		}
	}
	t := now.In(loc)
	hour := t.Hour()
	in := false
	if w.StartHour <= w.EndHour {
		in = hour >= w.StartHour && hour < w.EndHour
	} else {
		// e.g. 22..6 wraps midnight
		in = hour >= w.StartHour || hour < w.EndHour
	}
	if w.WeekdaysOnly {
		wd := t.Weekday()
		if wd == time.Saturday || wd == time.Sunday {
			in = false
		}
	}
	if in {
		return false, ""
	}
	return true, "Outside change window (current: " + t.Format("Mon 15:04 MST") + ")"
}
