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
		// must_reset_password drives a one-time forced password change
		// after the initial admin/admin login.
		var mustReset bool
		_ = d.PG.Pool.QueryRow(c.Request.Context(),
			`SELECT must_reset_password FROM users WHERE id=$1`, p.UserID).
			Scan(&mustReset)
		c.JSON(http.StatusOK, gin.H{
			"user_id":             p.UserID,
			"email":               p.Email,
			"role":                p.Role,
			"capabilities":        caps,
			"must_reset_password": mustReset,
		})
	}
}

// authLogin trades email+password for an api_token. We rotate the
// token on every successful login so old tokens that leaked don't
// stay valid forever; clients store and reuse the returned token.
func authLogin(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.Email == "" || body.Password == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "email + password required"})
			return
		}
		ctx := c.Request.Context()
		var (
			id, oldToken string
			hash         *string
			enabled      bool
		)
		err := d.PG.Pool.QueryRow(ctx, `
			SELECT id, password_hash, api_token, enabled
			  FROM users WHERE email=$1
		`, body.Email).Scan(&id, &hash, &oldToken, &enabled)
		if err != nil || !enabled || hash == nil || !auth.VerifyPassword(*hash, body.Password) {
			// Same response shape for unknown email + wrong password so
			// the caller can't probe valid emails.
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
			return
		}
		newToken, err := auth.GenerateAPIToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if _, err := d.PG.Pool.Exec(ctx, `
			UPDATE users SET api_token=$1, last_login=NOW() WHERE id=$2
		`, newToken, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if d.Resolver != nil {
			d.Resolver.Invalidate(oldToken)
		}
		_ = d.PG.Audit(ctx, body.Email, "auth.login", "user", id, nil)
		c.JSON(http.StatusOK, gin.H{"token": newToken})
	}
}

// authChangePassword updates the caller's own password. Clears
// must_reset_password and rotates the api_token so the new password
// invalidates the session that performed the change.
func authChangePassword(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := auth.Of(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		var body struct {
			Current string `json:"current_password"`
			New     string `json:"new_password"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ctx := c.Request.Context()
		var hash *string
		var oldToken string
		if err := d.PG.Pool.QueryRow(ctx,
			`SELECT password_hash, api_token FROM users WHERE id=$1`, p.UserID).
			Scan(&hash, &oldToken); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Allow change without current-password during the forced first
		// rotation (must_reset_password=true). Otherwise demand it so a
		// hijacked token can't silently swap the password.
		var mustReset bool
		_ = d.PG.Pool.QueryRow(ctx, `SELECT must_reset_password FROM users WHERE id=$1`, p.UserID).Scan(&mustReset)
		if !mustReset {
			if hash == nil || !auth.VerifyPassword(*hash, body.Current) {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "current password is wrong"})
				return
			}
		}
		newHash, err := auth.HashPassword(body.New)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		newToken, err := auth.GenerateAPIToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if _, err := d.PG.Pool.Exec(ctx, `
			UPDATE users
			   SET password_hash       = $1,
			       must_reset_password = FALSE,
			       password_set_at     = NOW(),
			       api_token           = $2
			 WHERE id = $3
		`, newHash, newToken, p.UserID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if d.Resolver != nil {
			d.Resolver.Invalidate(oldToken)
		}
		_ = d.PG.Audit(ctx, p.Email, "auth.password.change", "user", p.UserID, nil)
		c.JSON(http.StatusOK, gin.H{"token": newToken})
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
