package api

// Multipart upload introspection for the S3 gateway. SeaweedFS persists
// in-flight multipart uploads as filer subtrees under
// /buckets/<bucket>/.uploads/<upload-id>/<part>, where:
//   - the .uploads directory holds one child per active upload
//   - each upload-id directory holds the uploaded part files plus
//     metadata files written by the gateway
//
// SeaweedFS upstream's `weed shell s3.clean.uploads -timeAgo=X` deletes
// uploads older than X but has no list / dry-run flag. We therefore
// walk the filer directly to give operators a structured view (the AI
// also consumes this via list_clean_uploads) and to drive selective
// per-upload aborts.
//
// Abort is implemented as a recursive filer DELETE on the upload-id
// directory — same effect as SeaweedFS's own cleanup, just scoped to
// one upload instead of all uploads older than a threshold.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// MultipartUpload is one row in the listing response. JSON snake-case
// so the Next.js client consumes it directly.
type MultipartUpload struct {
	Bucket      string `json:"bucket"`
	Key         string `json:"key"` // best-effort: SeaweedFS encodes the object key in the upload metadata. Empty if we can't resolve it.
	UploadID    string `json:"upload_id"`
	InitiatedAt string `json:"initiated_at"` // RFC3339
	AgeHours    int    `json:"age_hours"`
	SizeSoFar   int64  `json:"size_so_far"` // sum of all part bytes uploaded so far
	PartCount   int    `json:"part_count"`
}

// Listing safety rails. A pathological gateway could have millions of
// stuck uploads; walking that all in one request would brown out the
// filer. These caps stay generous enough for a healthy cluster but
// prevent denial-of-service in the bad case.
const (
	mpuMaxBuckets  = 200
	mpuMaxUploads  = 1000 // hard cap on total uploads we report
	mpuPerDirLimit = 500  // filer listing page size
	mpuWalkTimeout = 30 * time.Second
)

func s3ListMultipartUploads(d Deps) gin.HandlerFunc {
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

		olderHours, _ := strconv.Atoi(c.DefaultQuery("older_than_hours", "0"))
		bucketFilter := strings.TrimSpace(c.Query("bucket"))

		ctx, cancel := context.WithTimeout(c.Request.Context(), mpuWalkTimeout)
		defer cancel()

		filer, err := resolveFilerAddr(ctx, d, cl, "")
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}

		rows, truncated, err := walkMultipartUploads(ctx, filer, cl, bucketFilter, olderHours)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		// Newest first so the UI can quickly spot recent stuck uploads;
		// the abandoned classifier on the client sorts by age separately.
		sort.Slice(rows, func(i, j int) bool { return rows[i].InitiatedAt > rows[j].InitiatedAt })
		c.JSON(http.StatusOK, gin.H{
			"items":     rows,
			"truncated": truncated,
		})
	}
}

// walkMultipartUploads enumerates /buckets/<name>/.uploads/<upload-id>/
// across the cluster. Returns rows + a truncated flag if any cap was
// hit. Errors that fail the whole walk surface up; per-bucket listing
// errors are swallowed (a stale bucket without .uploads is normal).
func walkMultipartUploads(ctx context.Context, filer string, cl *store.Cluster, bucketFilter string, olderHours int) ([]MultipartUpload, bool, error) {
	bucketDirs, err := filerListDirs(ctx, filer, cl, "/buckets")
	if err != nil {
		return nil, false, fmt.Errorf("list /buckets: %w", err)
	}
	if len(bucketDirs) > mpuMaxBuckets {
		bucketDirs = bucketDirs[:mpuMaxBuckets]
	}

	rows := make([]MultipartUpload, 0, 32)
	truncated := false
	cutoff := time.Now().Add(-time.Duration(olderHours) * time.Hour)

	for _, b := range bucketDirs {
		if bucketFilter != "" && b != bucketFilter {
			continue
		}
		if len(rows) >= mpuMaxUploads {
			truncated = true
			break
		}
		uploadsPath := "/buckets/" + b + "/.uploads"
		uploads, err := filerListEntries(ctx, filer, cl, uploadsPath)
		if err != nil {
			// Most buckets won't have a .uploads directory — that's not an
			// error, it just means no active multipart uploads. We can't
			// reliably distinguish "no directory" from a real error here,
			// so any failure for a single bucket is silently skipped.
			continue
		}
		for _, u := range uploads {
			if len(rows) >= mpuMaxUploads {
				truncated = true
				break
			}
			if !isFilerDir(u.Mode) {
				continue
			}
			initiated := parseFilerMtime(u.Mtime)
			if olderHours > 0 && !initiated.IsZero() && initiated.After(cutoff) {
				continue
			}
			uploadID := lastPathSegment(u.FullPath)
			size, parts := mpuSumParts(ctx, filer, cl, u.FullPath)
			ageH := 0
			if !initiated.IsZero() {
				ageH = int(time.Since(initiated).Hours())
			}
			rows = append(rows, MultipartUpload{
				Bucket:      b,
				UploadID:    uploadID,
				InitiatedAt: initiated.UTC().Format(time.RFC3339),
				AgeHours:    ageH,
				SizeSoFar:   size,
				PartCount:   parts,
			})
		}
	}
	return rows, truncated, nil
}

// mpuSumParts adds up the file sizes inside an upload-id directory.
// SeaweedFS lays out parts as files; we don't recurse beyond one level.
// Best-effort: errors return what we have.
func mpuSumParts(ctx context.Context, filer string, cl *store.Cluster, dir string) (int64, int) {
	entries, err := filerListEntries(ctx, filer, cl, dir)
	if err != nil {
		return 0, 0
	}
	var total int64
	count := 0
	for _, e := range entries {
		if isFilerDir(e.Mode) {
			continue
		}
		total += e.FileSize
		count++
	}
	return total, count
}

// filerListEntries fetches one filer directory listing (up to
// mpuPerDirLimit entries — we don't paginate here because the .uploads
// listing rarely exceeds a few hundred). Returns whatever the filer
// returns, including hidden/dot entries.
func filerListEntries(ctx context.Context, filer string, cl *store.Cluster, dir string) ([]filerEntry, error) {
	if !strings.HasSuffix(dir, "/") {
		dir += "/"
	}
	u := "http://" + filer + dir + "?limit=" + strconv.Itoa(mpuPerDirLimit)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	attachFilerAuth(req, cl)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("filer list %s: %w", dir, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// Caller treats this as "no entries" (e.g. bucket has no .uploads).
		return nil, nil
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		msg, _ := describeFilerError(filer, resp.StatusCode, b)
		return nil, fmt.Errorf("filer %s: %s", dir, msg)
	}
	var listing filerListing
	if err := json.NewDecoder(resp.Body).Decode(&listing); err != nil {
		return nil, fmt.Errorf("decode listing for %s: %w", dir, err)
	}
	return listing.Entries, nil
}

// filerListDirs is filerListEntries narrowed to subdirectory names.
func filerListDirs(ctx context.Context, filer string, cl *store.Cluster, dir string) ([]string, error) {
	entries, err := filerListEntries(ctx, filer, cl, dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !isFilerDir(e.Mode) {
			continue
		}
		out = append(out, lastPathSegment(e.FullPath))
	}
	return out, nil
}

func lastPathSegment(p string) string {
	p = strings.TrimSuffix(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// parseFilerMtime tolerates both RFC3339 and the older "2006-01-02
// 15:04:05" format the filer sometimes emits.
func parseFilerMtime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	if t, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		return t
	}
	return time.Time{}
}

// s3AbortMultipartUpload deletes /buckets/<bucket>/.uploads/<upload-id>
// recursively via the filer. This is what SeaweedFS's own clean-up does
// internally — we just scope it to one upload instead of an age batch.
//
// We refuse if the path doesn't match the expected shape so a bad
// client can't trick the controller into deleting arbitrary filer
// subtrees.
func s3AbortMultipartUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		bucket := strings.TrimSpace(c.Param("bucket"))
		uploadID := strings.TrimSpace(c.Param("upload_id"))
		if bucket == "" || uploadID == "" || strings.ContainsAny(bucket+uploadID, "/\\") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bucket and upload_id required, no separators"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		filer, err := resolveFilerAddr(ctx, d, cl, "")
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		target := "/buckets/" + bucket + "/.uploads/" + uploadID
		filerURL := "http://" + filer + target + "?recursive=true&ignoreRecursiveError=true"
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, filerURL, nil)
		attachFilerAuth(req, cl)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			msg, _ := describeFilerError(filer, resp.StatusCode, body)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "s3.multipart.abort", "cluster", id.String(), map[string]any{
			"bucket":    bucket,
			"upload_id": uploadID,
		})
		c.JSON(http.StatusOK, gin.H{"ok": true, "bucket": bucket, "upload_id": uploadID})
	}
}
