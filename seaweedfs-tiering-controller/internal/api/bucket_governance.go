package api

// Bucket governance endpoints — controller-side bucket ownership +
// data-lifecycle monitoring.
//
//	PUT  /clusters/:id/buckets/:bucket/governance     — set owner / retention
//	POST /clusters/:id/buckets/:bucket/lifecycle-scan — walk the bucket,
//	      count files older than retention_days, cache the result
//
// The lifecycle scan reuses the path-migrate filer walker (newPathWalker)
// with MinAgeDays = retention_days: matched files ARE the expired set.
// Deletion stays manual — this is a monitoring surface, not an auto-deleter.

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func upsertBucketGovernance(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		bucket := strings.TrimSpace(c.Param("bucket"))
		if bucket == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bucket is required"})
			return
		}
		var body struct {
			OwnerName     string `json:"owner_name"`
			OwnerUserKey  string `json:"owner_user_key"`
			RetentionDays *int   `json:"retention_days"`
			Notes         string `json:"notes"`
		}
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// A non-positive retention period means "no rule" — normalise to
		// nil so the lifecycle scan stays disabled for this bucket.
		if body.RetentionDays != nil && *body.RetentionDays <= 0 {
			body.RetentionDays = nil
		}
		if err := d.PG.UpsertBucketGovernance(c.Request.Context(), clusterID, bucket,
			strings.TrimSpace(body.OwnerName), strings.TrimSpace(body.OwnerUserKey),
			body.RetentionDays, strings.TrimSpace(body.Notes)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "bucket_governance",
			clusterID.String()+"/"+bucket, body)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// scanBucketLifecycle walks the bucket's filer subtree and records how
// much data is older than the bucket's retention_days.
func scanBucketLifecycle(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// loadClusterForFiles reads :id and writes its own error response.
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		bucket := strings.TrimSpace(c.Param("bucket"))
		if bucket == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bucket is required"})
			return
		}
		ctx := c.Request.Context()

		gov, err := d.PG.GetBucketGovernance(ctx, cl.ID, bucket)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if gov == nil || gov.RetentionDays == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "set a retention period for this bucket first"})
			return
		}

		objects, totalBytes, truncated, sample, serr := scanBucketExpired(ctx, d, cl, bucket, *gov.RetentionDays)
		if serr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": serr.Error()})
			return
		}
		if err := d.PG.RecordBucketScan(ctx, cl.ID, bucket, objects, totalBytes, truncated, sample); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(ctx, userOf(c), "lifecycle_scan", "bucket",
			cl.ID.String()+"/"+bucket, nil)
		c.JSON(http.StatusOK, gin.H{
			"ok":              true,
			"bucket":          bucket,
			"retention_days":  *gov.RetentionDays,
			"expired_objects": objects,
			"expired_bytes":   totalBytes,
			"truncated":       truncated,
			"sample":          sample,
		})
	}
}

// scanBucketExpired walks a bucket's filer subtree and reports how much
// data is older than retentionDays. Shared by the on-demand scan handler
// and the background LifecycleScanRunner.
func scanBucketExpired(ctx context.Context, d Deps, cl *store.Cluster, bucket string, retentionDays int) (objects, totalBytes int64, truncated bool, sample []string, err error) {
	filerAddr, ferr := resolveFilerAddr(ctx, d, cl, "")
	if ferr != nil {
		return 0, 0, false, nil, ferr
	}
	// SeaweedFS S3 stores buckets under /buckets/<name> on the filer.
	bucketPath := cleanFilerPath("/buckets/" + bucket)
	w := newPathWalker(filerAddr, cl, pathMigrateFilters{
		Path:       bucketPath,
		Recursive:  true,
		MinAgeDays: retentionDays,
	})
	if werr := w.walk(ctx, bucketPath, 0); werr != nil && !w.truncated {
		return 0, 0, false, nil, werr
	}
	res := w.finalize()
	sample = make([]string, 0, len(res.Samples))
	for _, e := range res.Samples {
		sample = append(sample, e.FullPath)
	}
	return int64(res.MatchedFiles), res.TotalBytes, res.Truncated, sample, nil
}

// listGovernedBuckets returns every bucket with a retention rule across
// all clusters — the cross-cluster lifecycle monitoring view.
func listGovernedBuckets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := d.PG.ListGovernedBuckets(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}
