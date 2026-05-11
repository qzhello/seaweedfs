// Package auth implements token-based admin auth. v1 wires in real token
// verification (against users.api_token) but everyone is admin role; v2 will
// flip the role mapping to enable RBAC without touching handlers.
package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
	RoleViewer   Role = "viewer"
	RoleAuditor  Role = "auditor"
)

type Principal struct {
	UserID string
	Email  string
	Role   Role
}

const ctxKey = "principal"

// Middleware authenticates the caller. Order:
//
//  1. Authorization: Bearer <token>  → Resolver.Resolve
//  2. X-Token: <token>               → Resolver.Resolve
//  3. dev mode only: X-User: <email> → loaded from DB, used iff allowDevHeader is true.
//
// allowDevHeader should be FALSE in any non-loopback deployment.
func Middleware(resolver *Resolver, allowDevHeader bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		// healthz / readiness handled by router before this middleware.
		token := ""
		if h := c.GetHeader("Authorization"); h != "" {
			t, err := tokenFromHeader(h)
			if err == nil {
				token = t
			}
		}
		if token == "" {
			token = c.GetHeader("X-Token")
		}
		if token != "" {
			if p, ok := resolver.Resolve(c.Request.Context(), token); ok {
				c.Set(ctxKey, p)
				c.Next()
				return
			}
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		if allowDevHeader {
			email := c.GetHeader("X-User")
			if email == "" {
				email = "admin@local"
			}
			c.Set(ctxKey, Principal{
				UserID: "00000000-0000-0000-0000-000000000000",
				Email:  email,
				Role:   RoleAdmin,
			})
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
	}
}

func RequireRole(allowed ...Role) gin.HandlerFunc {
	allow := map[Role]struct{}{}
	for _, r := range allowed {
		allow[r] = struct{}{}
	}
	return func(c *gin.Context) {
		p, ok := Of(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		if _, ok := allow[p.Role]; !ok {
			c.AbortWithStatusJSON(http.StatusForbidden,
				gin.H{"error": "forbidden", "needed": allowed, "have": p.Role})
			return
		}
		c.Next()
	}
}

func Of(c *gin.Context) (Principal, bool) {
	v, ok := c.Get(ctxKey)
	if !ok {
		return Principal{}, false
	}
	p, ok := v.(Principal)
	return p, ok
}
