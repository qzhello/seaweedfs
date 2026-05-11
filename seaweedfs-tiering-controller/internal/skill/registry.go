package skill

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/validation"
	"go.uber.org/zap"
)

// schemaSet is a private SchemaSet — we don't pollute validation.Default with
// skill-specific keys because Skill SOPs are edited live and we want to be
// able to evolve their schema without affecting policy/cluster shapes.
var schemaSet = func() *validation.SchemaSet {
	s := validation.NewSchemaSet()
	s.Register("skill.definition", definitionSchema)
	return s
}()

// Loaded is a Skill plus its parsed Definition, ready for the executor to
// consume.
type Loaded struct {
	Row        store.Skill
	Definition *Definition
}

// Registry caches the current (highest enabled) version of every skill in
// memory. Callers read via Get/All; the executor and Web UI both rely on this
// rather than hitting PG per call.
type Registry struct {
	pg  *store.PG
	log *zap.Logger

	current atomic.Pointer[map[string]*Loaded] // copy-on-write snapshot
	mu      sync.Mutex                          // serializes Reload writers
}

// New returns an empty registry — call Reload to populate from PG.
func New(pg *store.PG, log *zap.Logger) *Registry {
	r := &Registry{pg: pg, log: log}
	empty := map[string]*Loaded{}
	r.current.Store(&empty)
	return r
}

// Reload pulls every enabled skill (latest version per key) from PG and swaps
// the snapshot atomically. Cheap: O(N skills), validates each definition.
func (r *Registry) Reload(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	rows, err := r.pg.ListSkills(ctx, "")
	if err != nil {
		return fmt.Errorf("registry reload: %w", err)
	}

	// rows arrive ordered by (category, key, version DESC) — first row per key
	// is the highest version. Skip duplicates and disabled rows.
	next := make(map[string]*Loaded, len(rows))
	for _, row := range rows {
		if !row.Enabled {
			continue
		}
		if _, seen := next[row.Key]; seen {
			continue
		}
		def, err := ParseDefinition(row.Definition)
		if err != nil {
			r.log.Warn("skill definition rejected on reload",
				zap.String("key", row.Key), zap.Int("version", row.Version), zap.Error(err))
			continue
		}
		next[row.Key] = &Loaded{Row: row, Definition: def}
	}
	r.current.Store(&next)
	r.log.Info("skill registry reloaded", zap.Int("loaded", len(next)))
	return nil
}

// Get returns a skill by key, or nil if missing/disabled.
func (r *Registry) Get(key string) *Loaded {
	if m := r.current.Load(); m != nil {
		return (*m)[key]
	}
	return nil
}

// All returns a snapshot copy of the current skill set. The returned map is
// safe to iterate but should not be mutated.
func (r *Registry) All() map[string]*Loaded {
	if m := r.current.Load(); m != nil {
		out := make(map[string]*Loaded, len(*m))
		for k, v := range *m {
			out[k] = v
		}
		return out
	}
	return map[string]*Loaded{}
}

// Validate is exposed for the API layer — it parses+validates a definition
// without touching the registry. Used by the SOP editor's "preview" button.
func Validate(raw json.RawMessage) error {
	_, err := ParseDefinition(raw)
	return err
}
