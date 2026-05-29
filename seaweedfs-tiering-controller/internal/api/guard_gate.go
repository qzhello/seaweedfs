package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// guardAllow enforces the safety Guard (emergency stop / change window /
// maintenance window / holiday freeze) before a MUTATING operation runs.
//
// Until now the Guard was only consulted by the autonomy scheduler, so any
// operation triggered directly through the API or the generic shell exec
// bypassed it — the safety system was advisory, not enforced. Mutating
// handlers should call this at the top and return when it reports false.
//
// On block it writes HTTP 423 (Locked) with the human reason + machine code
// and returns false. Read-only operations must NOT call this (queries should
// keep working during a freeze).
func guardAllow(d Deps, c *gin.Context, clusterID *uuid.UUID) bool {
	if d.Guard == nil {
		return true
	}
	v := d.Guard.Allow(c.Request.Context(), clusterID, time.Now())
	if !v.Allowed {
		c.JSON(http.StatusLocked, gin.H{
			"error":      v.Reason,
			"code":       v.Code,
			"blocked_by": "safety_guard",
		})
		return false
	}
	return true
}
