package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// authMe returns the calling principal plus the expanded capability list
// resolved through the active role mapping. The frontend uses this on
// boot to decide which nav items and action buttons to show.
func authMe(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := auth.Of(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		var caps []string
		if d.Caps != nil {
			caps = d.Caps.CapsFor(c.Request.Context(), p.Role)
		}
		c.JSON(http.StatusOK, gin.H{
			"user_id":      p.UserID,
			"email":        p.Email,
			"role":         p.Role,
			"capabilities": caps,
		})
	}
}

// listPermissions returns the full capability catalog plus the current
// role→capability mapping. Admin-only.
func listPermissions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		caps, err := d.PG.ListCapabilities(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		rcs, err := d.PG.ListRoleCapabilities(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"capabilities":      caps,
			"role_capabilities": rcs,
			"roles": []string{
				string(auth.RoleAdmin),
				string(auth.RoleOperator),
				string(auth.RoleViewer),
				string(auth.RoleAuditor),
			},
		})
	}
}

// setRolePermissions replaces the capability set for a single role. The
// admin role is protected from losing the wildcard capability to keep
// the system recoverable.
func setRolePermissions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		role := c.Param("role")
		switch role {
		case string(auth.RoleAdmin), string(auth.RoleOperator),
			string(auth.RoleViewer), string(auth.RoleAuditor):
			// ok
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "unknown role"})
			return
		}
		var body struct {
			Capabilities []string `json:"capabilities"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Admin must retain "*" — otherwise the next request would lock
		// the operator out of the permissions page that lets them fix it.
		if role == string(auth.RoleAdmin) {
			hasWildcard := false
			for _, cap := range body.Capabilities {
				if cap == "*" {
					hasWildcard = true
					break
				}
			}
			if !hasWildcard {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "admin role must retain the '*' wildcard capability",
				})
				return
			}
		}
		if err := d.PG.SetRoleCapabilities(c.Request.Context(), role, body.Capabilities); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if d.Caps != nil {
			d.Caps.Invalidate()
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "permissions.set", "role", role, map[string]any{
			"capabilities": body.Capabilities,
		})
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
