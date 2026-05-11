package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
)

// TraceID middleware injects a trace_id into the gin.Context and response
// header, then attaches it to every zap log line for the request.
func TraceID() gin.HandlerFunc {
	return func(c *gin.Context) {
		tid := c.GetHeader("X-Trace-Id")
		if tid == "" {
			tid = uuid.NewString()
		}
		c.Set("trace_id", tid)
		c.Header("X-Trace-Id", tid)
		c.Next()
	}
}

// PrometheusMiddleware records request count + latency. Uses gin's FullPath
// (template like "/api/v1/clusters/:id") rather than the literal URL so we
// don't blow up cardinality.
func PrometheusMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unknown"
		}
		status := strconv.Itoa(c.Writer.Status())
		metrics.HTTPRequests.WithLabelValues(c.Request.Method, route, status).Inc()
		metrics.HTTPLatency.WithLabelValues(c.Request.Method, route).
			Observe(time.Since(start).Seconds())
	}
}

// metricsHandler exposes the Prometheus registry. Mounted unauthenticated on
// /metrics so scrapers don't need to know the admin token; keep this on
// localhost or behind a network ACL in production.
func metricsHandler() http.Handler {
	return promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{
		Registry:          metrics.Registry,
		EnableOpenMetrics: true,
	})
}

// zapMiddlewareWithTrace replaces the original zapMiddleware to also log trace_id.
func zapMiddlewareWithTrace(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		fields := []zap.Field{
			zap.String("method", c.Request.Method),
			zap.String("path", c.FullPath()),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("dur", time.Since(start)),
		}
		if tid, ok := c.Get("trace_id"); ok {
			fields = append(fields, zap.String("trace_id", tid.(string)))
		}
		if c.Writer.Status() >= 500 {
			log.Error("http", fields...)
		} else if c.Writer.Status() >= 400 {
			log.Warn("http", fields...)
		} else {
			log.Info("http", fields...)
		}
	}
}
