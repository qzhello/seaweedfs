package health

import (
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Gate is the read side consulted by the scheduler. It is updated in-place by
// the Scraper. Reads are O(1) and lock-free for the common path.
type Gate struct {
	mu       sync.RWMutex
	gating   map[uuid.UUID]gatingState
	lastSeen map[uuid.UUID]time.Time
}

type gatingState struct {
	name     string
	state    string // healthy | degraded | unknown
	severity string
}

func NewGate() *Gate {
	return &Gate{
		gating:   map[uuid.UUID]gatingState{},
		lastSeen: map[uuid.UUID]time.Time{},
	}
}

// Update is called by the scraper after every probe. Only targets where
// gates_scheduler=true contribute to the global decision.
func (g *Gate) Update(t store.MonitorTarget, h store.HealthRow) {
	g.mu.Lock()
	if !t.GatesScheduler {
		delete(g.gating, t.ID)
	} else {
		g.gating[t.ID] = gatingState{name: t.Name, state: h.State, severity: t.Severity}
	}
	g.lastSeen[t.ID] = time.Now()
	g.mu.Unlock()

	// Update gate metric (1 = closed/degraded, 0 = open).
	closed := 0.0
	for _, st := range g.gating {
		if st.state == "degraded" {
			closed = 1.0
			break
		}
	}
	metricsHealthGateClosed(closed)
}

// Healthy reports whether the scheduler is allowed to start new work.
// Returns:
//
//	healthy = true → green light, proceed
//	healthy = false → at least one gating target is degraded; reason names them
func (g *Gate) Healthy() (healthy bool, reason string) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	bad := []string{}
	for _, st := range g.gating {
		if st.state == "degraded" {
			bad = append(bad, st.name)
		}
	}
	if len(bad) == 0 {
		return true, ""
	}
	return false, "degraded: " + joinNames(bad)
}

// SnapshotByName is used by API to display the current set of gating targets.
type Status struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Severity string `json:"severity"`
}

func (g *Gate) Snapshot() []Status {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]Status, 0, len(g.gating))
	for _, st := range g.gating {
		out = append(out, Status{Name: st.name, State: st.state, Severity: st.severity})
	}
	return out
}

func joinNames(xs []string) string {
	if len(xs) == 0 {
		return ""
	}
	out := xs[0]
	for _, x := range xs[1:] {
		out += ", " + x
	}
	return out
}
