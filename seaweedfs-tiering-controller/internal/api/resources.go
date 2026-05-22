package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

// listBuckets calls `s3.bucket.list` on the cluster and returns the
// parsed rows. The shell call is preflight-guarded + cached internally,
// so opening the buckets page never hangs on a dead master and parallel
// dashboard refreshes share one fetch.
func listBuckets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		// 15s deadline matches the volumes endpoint — short enough that an
		// unreachable master surfaces in the UI instead of spinning.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		rows, err := resourceListBuckets(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		// Enrich with controller-side governance (owner / retention /
		// lifecycle scan). Best-effort: a governance lookup failure must
		// not blank out the bucket list.
		gov, _ := d.PG.ListBucketGovernance(c.Request.Context(), id)
		type bucketRow struct {
			seaweed.BucketInfo
			OwnerName      string     `json:"owner_name"`
			OwnerUserKey   string     `json:"owner_user_key"`
			RetentionDays  *int       `json:"retention_days,omitempty"`
			Notes          string     `json:"notes"`
			LastScanAt     *time.Time `json:"last_scan_at,omitempty"`
			ExpiredObjects int64      `json:"expired_objects"`
			ExpiredBytes   int64      `json:"expired_bytes"`
			ScanTruncated  bool       `json:"scan_truncated"`
		}
		items := make([]bucketRow, 0, len(rows))
		for _, r := range rows {
			br := bucketRow{BucketInfo: r}
			if g, ok := gov[r.Name]; ok {
				br.OwnerName = g.OwnerName
				br.OwnerUserKey = g.OwnerUserKey
				br.RetentionDays = g.RetentionDays
				br.Notes = g.Notes
				br.LastScanAt = g.LastScanAt
				br.ExpiredObjects = g.ExpiredObjects
				br.ExpiredBytes = g.ExpiredBytes
				br.ScanTruncated = g.ScanTruncated
			}
			items = append(items, br)
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

func listCollections(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		rows, err := resourceListCollections(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

// resourceListBuckets / resourceListCollections wrap the seaweed client
// calls so the handler stays small. Each call is on the read-only shell
// path (no lock/unlock wrap).
func resourceListBuckets(ctx context.Context, sw *seaweed.Client, master, binPath string) ([]seaweed.BucketInfo, error) {
	return sw.ListBucketsShellAt(ctx, master, binPath)
}
func resourceListCollections(ctx context.Context, sw *seaweed.Client, master, binPath string) ([]seaweed.CollectionInfo, error) {
	return sw.ListCollectionsShellAt(ctx, master, binPath)
}
