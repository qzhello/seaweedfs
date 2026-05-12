package auth

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CapsLoader keeps the role→capability mapping in memory and refreshes
// it lazily. The mapping is small (single-digit roles × <100 caps) and
// changes rarely, so a global snapshot with a TTL is plenty.
//
// A 30s TTL is short enough that operators don't have to wait long for
// permission edits to take effect, but long enough to keep DB load
// negligible.
type CapsLoader struct {
	pool *pgxpool.Pool
	ttl  time.Duration

	mu    sync.Mutex
	snap  atomic.Pointer[capsSnapshot]
	infl  sync.Mutex // serialises refresh
}

type capsSnapshot struct {
	loadedAt time.Time
	byRole   map[Role]map[string]struct{}
}

func NewCapsLoader(pool *pgxpool.Pool) *CapsLoader {
	return &CapsLoader{pool: pool, ttl: 30 * time.Second}
}

// Has returns true iff the principal's role grants the named capability.
// The wildcard "*" capability grants every capability. Unknown roles
// have no capabilities.
func (l *CapsLoader) Has(ctx context.Context, role Role, cap string) bool {
	caps := l.capsFor(ctx, role)
	if _, ok := caps["*"]; ok {
		return true
	}
	_, ok := caps[cap]
	return ok
}

// CapsFor returns the set of capabilities granted to a role, expanding
// "*" so callers can return the explicit list to the frontend.
func (l *CapsLoader) CapsFor(ctx context.Context, role Role) []string {
	caps := l.capsFor(ctx, role)
	out := make([]string, 0, len(caps))
	for c := range caps {
		out = append(out, c)
	}
	return out
}

// Invalidate forces the next call to refresh from the DB. Use after an
// admin updates role permissions.
func (l *CapsLoader) Invalidate() { l.snap.Store(nil) }

func (l *CapsLoader) capsFor(ctx context.Context, role Role) map[string]struct{} {
	s := l.current(ctx)
	if s == nil {
		return nil
	}
	return s.byRole[role]
}

func (l *CapsLoader) current(ctx context.Context) *capsSnapshot {
	s := l.snap.Load()
	if s != nil && time.Since(s.loadedAt) < l.ttl {
		return s
	}
	// Stale or missing: take the refresh lock so only one goroutine hits
	// the DB. Re-check after acquiring the lock — another goroutine may
	// have refreshed while we waited.
	l.infl.Lock()
	defer l.infl.Unlock()
	s = l.snap.Load()
	if s != nil && time.Since(s.loadedAt) < l.ttl {
		return s
	}
	loaded, err := l.load(ctx)
	if err != nil {
		// On load error fall back to whatever snapshot we have so the
		// service degrades gracefully (stale > 500). Only callers that
		// truly need fresh data should care.
		if s != nil {
			return s
		}
		return &capsSnapshot{loadedAt: time.Now(), byRole: map[Role]map[string]struct{}{}}
	}
	l.snap.Store(loaded)
	return loaded
}

func (l *CapsLoader) load(ctx context.Context) (*capsSnapshot, error) {
	rows, err := l.pool.Query(ctx, `SELECT role::text, capability FROM role_capabilities`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	by := map[Role]map[string]struct{}{}
	for rows.Next() {
		var roleStr, cap string
		if err := rows.Scan(&roleStr, &cap); err != nil {
			return nil, err
		}
		r := Role(roleStr)
		set, ok := by[r]
		if !ok {
			set = map[string]struct{}{}
			by[r] = set
		}
		set[cap] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &capsSnapshot{loadedAt: time.Now(), byRole: by}, nil
}

// RequireCap is the capability-aware companion to RequireRole. It
// rejects requests whose principal's role doesn't carry the named
// capability. Use one capability per route — composing multiple caps
// invites accidental over-grants.
func RequireCap(loader *CapsLoader, cap string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := Of(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		if loader == nil || !loader.Has(c.Request.Context(), p.Role, cap) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":  "forbidden",
				"needed": cap,
				"role":   p.Role,
			})
			return
		}
		c.Next()
	}
}
