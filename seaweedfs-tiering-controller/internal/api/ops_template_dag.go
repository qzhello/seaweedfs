package api

import (
	"fmt"
)

// normalizeDAG performs three repairs in a single pass, so save-time
// validation can rely on the result being well-formed:
//
//  1. Fill missing step IDs ("s1", "s2", ...). The frontend assigns IDs
//     for new steps but legacy rows + AI drafts may omit them.
//  2. Linearize templates that have no depends_on anywhere — without
//     this, every legacy template would suddenly look like N parallel
//     root steps in the graph editor, which is wrong (operators
//     authored them assuming sequential execution).
//  3. Reject duplicate IDs and dangling depends_on refs early. Cycle
//     detection is a separate topological sort pass.
//
// Returns the cleaned slice (same length, same order) or an error
// describing exactly which step/ref is broken.
func normalizeDAG(steps []opsStep) ([]opsStep, error) {
	if len(steps) == 0 {
		return steps, nil
	}

	// Pass 1: assign IDs. Existing IDs keep their value; duplicates
	// rejected later. Numbering starts at the highest existing
	// "sNN"-style ID + 1 so we don't collide with operator-typed ones.
	taken := make(map[string]int) // id → step index
	maxAuto := 0
	for i, s := range steps {
		if s.ID == "" {
			continue
		}
		if prev, ok := taken[s.ID]; ok {
			return nil, fmt.Errorf("step %d and step %d share the same id %q", prev+1, i+1, s.ID)
		}
		taken[s.ID] = i
		// Track the highest "sNN" suffix so auto-IDs avoid it.
		var n int
		if _, err := fmt.Sscanf(s.ID, "s%d", &n); err == nil && n > maxAuto {
			maxAuto = n
		}
	}
	next := maxAuto + 1
	for i := range steps {
		if steps[i].ID != "" {
			continue
		}
		for {
			candidate := fmt.Sprintf("s%d", next)
			next++
			if _, clash := taken[candidate]; !clash {
				steps[i].ID = candidate
				taken[candidate] = i
				break
			}
		}
	}

	// Pass 2: detect legacy "no DAG info anywhere" → linearize.
	// We treat depends_on as "all empty" only when every step is empty;
	// a single step with an explicit empty slice keeps that meaning.
	hasAnyDeps := false
	for _, s := range steps {
		if len(s.DependsOn) > 0 {
			hasAnyDeps = true
			break
		}
	}
	if !hasAnyDeps && len(steps) > 1 {
		// Chain: s_i depends on s_{i-1}. s_0 stays a root.
		for i := 1; i < len(steps); i++ {
			steps[i].DependsOn = []string{steps[i-1].ID}
		}
	}

	// Pass 3: validate refs.
	for i, s := range steps {
		seen := make(map[string]bool, len(s.DependsOn))
		clean := make([]string, 0, len(s.DependsOn))
		for _, dep := range s.DependsOn {
			if dep == "" {
				continue
			}
			if dep == s.ID {
				return nil, fmt.Errorf("step %q (#%d) cannot depend on itself", s.ID, i+1)
			}
			if _, ok := taken[dep]; !ok {
				return nil, fmt.Errorf("step %q (#%d) depends on unknown step %q", s.ID, i+1, dep)
			}
			// Forward dependency: step N depends on step M where M>N.
			// We allow this — the topological sort decides execution
			// order, not the source-array order. But dedupe so the
			// editor doesn't display dup edges.
			if seen[dep] {
				continue
			}
			seen[dep] = true
			clean = append(clean, dep)
		}
		steps[i].DependsOn = clean
	}

	// Pass 4: cycle detection via Kahn's algorithm. If there's a cycle
	// we can't topologically sort, so the run would deadlock.
	if _, err := topoSort(steps); err != nil {
		return nil, err
	}
	return steps, nil
}

// topoSort returns step indices in an order that respects depends_on.
// Used by save-time validation (cycle detection) and at runtime as the
// scheduling guide. Steps with no remaining unsatisfied deps come out
// in their original source-array order so two equally-ready steps
// land in a predictable position.
func topoSort(steps []opsStep) ([]int, error) {
	indexByID := make(map[string]int, len(steps))
	for i, s := range steps {
		indexByID[s.ID] = i
	}
	inDeg := make([]int, len(steps))
	for i, s := range steps {
		inDeg[i] = len(s.DependsOn)
	}
	// Ready queue keyed on source order so "two steps ready at the
	// same time" stays deterministic.
	ready := []int{}
	for i, d := range inDeg {
		if d == 0 {
			ready = append(ready, i)
		}
	}
	out := make([]int, 0, len(steps))
	for len(ready) > 0 {
		i := ready[0]
		ready = ready[1:]
		out = append(out, i)
		// Decrement in-degree of every step that depends on i.
		for j, s := range steps {
			for _, dep := range s.DependsOn {
				if dep == steps[i].ID {
					inDeg[j]--
					if inDeg[j] == 0 {
						ready = append(ready, j)
					}
				}
			}
		}
	}
	if len(out) != len(steps) {
		return nil, fmt.Errorf("template has a dependency cycle — run order is undefined")
	}
	return out, nil
}

// readyFrontier returns the indices of every step that is currently
// runnable: not yet started, not skipped, and every dep already
// completed successfully. Used by the parallel scheduler at runtime
// after each step finishes.
func readyFrontier(steps []opsStep, status []opsStepStatus) []int {
	out := []int{}
	for i, s := range steps {
		if status[i] != opsStepPending {
			continue
		}
		ready := true
		for _, dep := range s.DependsOn {
			depIdx := -1
			for j, t := range steps {
				if t.ID == dep {
					depIdx = j
					break
				}
			}
			if depIdx < 0 || status[depIdx] != opsStepDone {
				ready = false
				break
			}
		}
		if ready {
			out = append(out, i)
		}
	}
	return out
}

// opsStepStatus tracks per-step lifecycle in the parallel scheduler.
type opsStepStatus int

const (
	opsStepPending opsStepStatus = iota
	opsStepRunning
	opsStepDone
	opsStepError
	opsStepSkipped // upstream failed
)
