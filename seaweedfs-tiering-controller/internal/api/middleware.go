package api

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// RateLimit returns a Gin middleware that throttles requests per principal.
// burst   = max requests allowed in a tight burst
// rps     = sustained rate per second
// Use small burst + low rps for write paths, larger for reads.
func RateLimit(rps float64, burst int) gin.HandlerFunc {
	limiters := sync.Map{} // userID → *rate.Limiter
	get := func(id string) *rate.Limiter {
		if v, ok := limiters.Load(id); ok {
			return v.(*rate.Limiter)
		}
		l := rate.NewLimiter(rate.Limit(rps), burst)
		actual, _ := limiters.LoadOrStore(id, l)
		return actual.(*rate.Limiter)
	}
	return func(c *gin.Context) {
		p, ok := auth.Of(c)
		id := "anonymous"
		if ok {
			id = p.UserID
		}
		if !get(id).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests,
				gin.H{"error": "rate limited", "retry_after_ms": 1000})
			return
		}
		c.Next()
	}
}

// SecurityHeaders sets baseline response headers. Cheap insurance against
// browser-side mistakes (clickjacking, MIME sniffing, etc.).
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cache-Control", "no-store")
		c.Next()
	}
}

// SlowQueryGuard aborts requests that exceed a soft deadline. Pairs with the
// per-route timeouts; a defensive belt-and-suspenders.
func SlowQueryGuard(d time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		if elapsed := time.Since(start); elapsed > d {
			c.Header("X-Slow-Query", elapsed.String())
		}
	}
}
