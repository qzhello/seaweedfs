package auth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Resolver verifies a bearer token against the users table.
// Caches positive lookups for 60s to avoid hammering PG on every request.
type Resolver struct {
	pool *pgxpool.Pool
	ttl  time.Duration
	mu   sync.RWMutex
	hot  map[string]cachedPrincipal
}

type cachedPrincipal struct {
	p       Principal
	expires time.Time
}

func NewResolver(pool *pgxpool.Pool) *Resolver {
	return &Resolver{
		pool: pool,
		ttl:  60 * time.Second,
		hot:  map[string]cachedPrincipal{},
	}
}

// Resolve maps a token → Principal. Returns false if the token is unknown
// or the user is disabled. Negative results are NOT cached so admins can
// revoke immediately by flipping users.enabled.
func (r *Resolver) Resolve(ctx context.Context, token string) (Principal, bool) {
	if token == "" {
		return Principal{}, false
	}
	r.mu.RLock()
	if c, ok := r.hot[token]; ok && time.Now().Before(c.expires) {
		r.mu.RUnlock()
		return c.p, true
	}
	r.mu.RUnlock()

	row := r.pool.QueryRow(ctx, `
		SELECT id, email, role
		FROM users WHERE api_token=$1 AND enabled=TRUE`, token)
	var p Principal
	var role string
	if err := row.Scan(&p.UserID, &p.Email, &role); err != nil {
		return Principal{}, false
	}
	p.Role = Role(role)

	r.mu.Lock()
	r.hot[token] = cachedPrincipal{p: p, expires: time.Now().Add(r.ttl)}
	r.mu.Unlock()

	// Best-effort: bump last_login. Ignore errors; this is telemetry.
	go func(id string) {
		ctx2, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = r.pool.Exec(ctx2, `UPDATE users SET last_login=NOW() WHERE id=$1`, id)
	}(p.UserID)
	return p, true
}

// Invalidate drops a token from the cache (e.g., after rotation).
func (r *Resolver) Invalidate(token string) {
	r.mu.Lock()
	delete(r.hot, token)
	r.mu.Unlock()
}

func tokenFromHeader(h string) (string, error) {
	if h == "" {
		return "", fmt.Errorf("missing Authorization header")
	}
	const bearer = "Bearer "
	if len(h) > len(bearer) && h[:len(bearer)] == bearer {
		return h[len(bearer):], nil
	}
	return h, nil // tolerate raw token for tooling
}
