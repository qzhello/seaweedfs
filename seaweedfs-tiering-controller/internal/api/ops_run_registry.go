package api

// In-memory run registry that tracks every active interactive ops
// template execution so the SSE runner can pause for human
// confirmation and the operator can send approve/cancel signals on
// separate HTTP requests.
//
// Why in-memory: a run is bound to one operator's open dialog. If
// they close the browser, killing the run is the right behaviour
// (no half-completed mutations dangling). Persistent run state would
// be useful for multi-operator handoffs but is out of scope here.

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// opsRunState is the value the operator's approval handler writes
// onto the run's Approve channel. Vars overrides any values the AI
// inference proposed; if the operator hit "Cancel" we send a value
// with Cancel=true instead.
type opsRunSignal struct {
	Cancel bool
	Vars   map[string]string
}

// opsRun is one in-flight template execution. Created on POST
// /ops-templates/:tid/run-stream, removed when the runner finishes
// (success, cancellation, or stream disconnect).
//
// Most fields are read-only after construction; the per-step signal
// map is mutex-protected because parallel-step execution means
// multiple goroutines may register/await/clear entries concurrently.
type opsRun struct {
	ID        uuid.UUID
	UserID    string // creator; only they can approve/cancel
	CreatedAt time.Time

	// Cancel channel — closed signals "tear down ASAP". Independent
	// of step signals because cancellation can arrive while the
	// runner is NOT paused (e.g. mid-shell-call); the runner watches
	// both.
	Cancel chan struct{}

	// done is closed by the runner goroutine on exit. Approval
	// handlers consult it to fail fast when the run is already gone
	// instead of leaving the operator's request hanging.
	done chan struct{}

	// stepSignals holds an unbuffered channel per paused step,
	// created lazily by the runner when a step enters await_confirm.
	// Approve(stepID, sig) sends on the matching channel.
	// Multiple parallel steps can be paused at the same time, hence
	// the map (a single Signal channel could only serve one).
	mu          sync.Mutex
	stepSignals map[string]chan opsRunSignal
}

// Done returns the done channel so external watchers (the approve
// HTTP handler) can select on it.
func (r *opsRun) Done() <-chan struct{} { return r.done }

// markDone is called by the runner when it exits.
func (r *opsRun) markDone() {
	select {
	case <-r.done:
		// already closed; harmless re-entry from defer chains
	default:
		close(r.done)
	}
}

// opsRunRegistry tracks active runs keyed by run ID. The mutex
// protects the map; individual run fields are accessed without the
// lock once the entry is published.
type opsRunRegistry struct {
	mu   sync.Mutex
	runs map[uuid.UUID]*opsRun
}

func newOpsRunRegistry() *opsRunRegistry {
	return &opsRunRegistry{runs: map[uuid.UUID]*opsRun{}}
}

// register creates a fresh run entry and returns it. Caller owns
// removing it via remove() when the runner exits.
func (r *opsRunRegistry) register(userID string) *opsRun {
	run := &opsRun{
		ID:          uuid.New(),
		UserID:      userID,
		CreatedAt:   time.Now(),
		Cancel:      make(chan struct{}),
		done:        make(chan struct{}),
		stepSignals: map[string]chan opsRunSignal{},
	}
	r.mu.Lock()
	r.runs[run.ID] = run
	r.mu.Unlock()
	return run
}

// ChanForStep returns the unbuffered signal channel for stepID,
// creating it on first call. Used by the runner before parking on
// await_confirm, and by Approve to look up the destination.
func (r *opsRun) ChanForStep(stepID string) chan opsRunSignal {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, ok := r.stepSignals[stepID]
	if !ok {
		ch = make(chan opsRunSignal)
		r.stepSignals[stepID] = ch
	}
	return ch
}

// ClearStep removes the channel for stepID once the runner is done
// waiting on it. Prevents lingering entries from accumulating in
// long-running multi-step templates.
func (r *opsRun) ClearStep(stepID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.stepSignals, stepID)
}

// PendingStepIDs returns a snapshot of step IDs that currently have an
// open signal channel — i.e. parked in await_confirm. Used by the
// approve endpoint when the caller omitted step_id (single-pending
// disambiguation).
func (r *opsRun) PendingStepIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.stepSignals))
	for k := range r.stepSignals {
		out = append(out, k)
	}
	return out
}

func (r *opsRunRegistry) get(id uuid.UUID) (*opsRun, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[id]
	return run, ok
}

func (r *opsRunRegistry) remove(id uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.runs, id)
}

// activeCount returns how many runs are currently in flight. Used by
// the /counts endpoint to paint a "live" badge on the Ops Templates
// nav row — runs live in memory only, so this is the only source.
func (r *opsRunRegistry) activeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.runs)
}
