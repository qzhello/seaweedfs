package api

// Path-scoped bulk migration wizard. Operators arrive here from the
// File Browser ("Tier this folder…") with a path in mind. The endpoint
// walks the filer namespace under that path, aggregates an impact
// preview (file count / bytes / age distribution / extension mix),
// and — when the operator confirms — calls the AI planner with the
// path scope baked in so the proposal is path-aware.
//
// SeaweedFS does not natively support file-level tiering (tier moves
// are volume-level), so the wizard's output is an *operator-facing*
// migration plan: which collections to tier, which volumes likely
// contain this path's files, and an estimated cost saving. The actual
// execution still goes through ops templates / volume.tier.move.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const (
	pathMigrateMaxEntries = 50_000 // hard cap on entries we'll enumerate
	pathMigrateMaxDepth   = 12     // hard cap on recursive depth
	pathMigrateListLimit  = 1_000  // per-directory page size
)

// filerEntry mirrors enough of the filer listing JSON for the walker.
// We deliberately keep this narrow — we don't read chunks (per-file
// volume membership would require a second roundtrip per file, which
// makes the wizard unusably slow on a real namespace).
type filerEntry struct {
	FullPath    string `json:"FullPath"`
	Mtime       string `json:"Mtime"`
	Mode        uint32 `json:"Mode"`
	FileSize    int64  `json:"FileSize"`
	Mime        string `json:"Mime"`
	Collection  string `json:"Collection"`
}

type filerListing struct {
	Path                  string       `json:"Path"`
	Entries               []filerEntry `json:"Entries"`
	Limit                 int          `json:"Limit"`
	LastFileName          string       `json:"LastFileName"`
	ShouldDisplayLoadMore bool         `json:"ShouldDisplayLoadMore"`
}

// pathPreviewResp is the wizard's input panel. Snake-cased so the
// Next.js client can consume it directly.
type pathPreviewResp struct {
	Cluster           string                 `json:"cluster"`
	Filer             string                 `json:"filer"`
	Path              string                 `json:"path"`
	Recursive         bool                   `json:"recursive"`
	Truncated         bool                   `json:"truncated"`
	MatchedFiles      int                    `json:"matched_files"`
	TotalBytes        int64                  `json:"total_bytes"`
	OldestMtimeSecs   int64                  `json:"oldest_mtime_seconds"`
	NewestMtimeSecs   int64                  `json:"newest_mtime_seconds"`
	ByCollection      []pathCollectionBucket `json:"by_collection"`
	ByExtension       []pathExtBucket        `json:"by_extension"`
	ByAge             []pathAgeBucket        `json:"by_age"`
	Samples           []filerEntry           `json:"samples"`
	Walked            int                    `json:"walked"`
	Filters           pathMigrateFilters     `json:"filters"`
}

type pathCollectionBucket struct {
	Collection string `json:"collection"`
	Files      int    `json:"files"`
	Bytes      int64  `json:"bytes"`
}
type pathExtBucket struct {
	Ext   string `json:"ext"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}
type pathAgeBucket struct {
	Label string `json:"label"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}

// pathMigrateFilters captures the operator's selection criteria — what
// was actually applied during the walk. Echoed back so the UI can
// re-render the active filters next to the impact numbers.
type pathMigrateFilters struct {
	Path         string `json:"path"`
	Recursive    bool   `json:"recursive"`
	Glob         string `json:"glob,omitempty"`           // *.log etc.
	MinSizeBytes int64  `json:"min_size_bytes,omitempty"`
	MinAgeDays   int    `json:"min_age_days,omitempty"`
}

func pathMigratePreview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filerAddr, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var body struct {
			Path         string `json:"path"`
			Recursive    *bool  `json:"recursive,omitempty"`
			Glob         string `json:"glob,omitempty"`
			MinSizeBytes int64  `json:"min_size_bytes,omitempty"`
			MinAgeDays   int    `json:"min_age_days,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		body.Path = cleanFilerPath(body.Path)
		recursive := true
		if body.Recursive != nil {
			recursive = *body.Recursive
		}

		filters := pathMigrateFilters{
			Path:         body.Path,
			Recursive:    recursive,
			Glob:         strings.TrimSpace(body.Glob),
			MinSizeBytes: body.MinSizeBytes,
			MinAgeDays:   body.MinAgeDays,
		}

		w := newPathWalker(filerAddr, cl, filters)
		if err := w.walk(ctx, body.Path, 0); err != nil && !w.truncated {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}

		out := w.finalize()
		out.Cluster = cl.ID.String()
		out.Filer = filerAddr
		out.Path = body.Path
		out.Recursive = recursive
		c.JSON(http.StatusOK, out)
	}
}

// pathWalker accumulates the walk state. Constructed per request.
type pathWalker struct {
	filer     string
	cl        *clusterForWalker
	filters   pathMigrateFilters
	now       time.Time

	walked       int
	matched      int
	totalBytes   int64
	oldestMtime  int64
	newestMtime  int64
	byCollection map[string]*pathCollectionBucket
	byExtension  map[string]*pathExtBucket
	byAge        map[string]*pathAgeBucket
	samples      []filerEntry
	truncated    bool
}

// clusterForWalker is a tiny shim so we can build attachFilerAuth-able
// requests without coupling this file to store.Cluster.
type clusterForWalker = store.Cluster

func newPathWalker(filer string, cl *clusterForWalker, f pathMigrateFilters) *pathWalker {
	return &pathWalker{
		filer:        filer,
		cl:           cl,
		filters:      f,
		now:          time.Now(),
		byCollection: map[string]*pathCollectionBucket{},
		byExtension:  map[string]*pathExtBucket{},
		byAge:        map[string]*pathAgeBucket{},
	}
}

// walk is BFS-ish: we recurse into directories serially. Each
// directory page is paginated via lastFileName until the filer says
// done. We honour both depth and entry caps so the wizard can't blow
// up on a billion-file namespace.
func (w *pathWalker) walk(ctx context.Context, dir string, depth int) error {
	if depth > pathMigrateMaxDepth {
		w.truncated = true
		return nil
	}
	if w.walked >= pathMigrateMaxEntries {
		w.truncated = true
		return nil
	}
	last := ""
	for {
		if w.walked >= pathMigrateMaxEntries {
			w.truncated = true
			return nil
		}
		listing, err := w.fetch(ctx, dir, last)
		if err != nil {
			return err
		}
		for _, e := range listing.Entries {
			w.walked++
			if w.walked >= pathMigrateMaxEntries {
				w.truncated = true
				break
			}
			if isFilerDir(e.Mode) {
				if w.filters.Recursive {
					if err := w.walk(ctx, e.FullPath, depth+1); err != nil {
						return err
					}
				}
				continue
			}
			w.consumeFile(e)
		}
		if !listing.ShouldDisplayLoadMore || listing.LastFileName == "" {
			return nil
		}
		last = listing.LastFileName
	}
}

// consumeFile applies the filters and accumulates aggregates.
func (w *pathWalker) consumeFile(e filerEntry) {
	if e.FileSize < w.filters.MinSizeBytes {
		return
	}
	if w.filters.MinAgeDays > 0 {
		if t, err := time.Parse(time.RFC3339, e.Mtime); err == nil {
			if w.now.Sub(t) < time.Duration(w.filters.MinAgeDays)*24*time.Hour {
				return
			}
		}
	}
	if w.filters.Glob != "" {
		if matched, _ := path.Match(w.filters.Glob, path.Base(e.FullPath)); !matched {
			return
		}
	}

	w.matched++
	w.totalBytes += e.FileSize

	if t, err := time.Parse(time.RFC3339, e.Mtime); err == nil {
		secs := t.Unix()
		if w.oldestMtime == 0 || secs < w.oldestMtime {
			w.oldestMtime = secs
		}
		if secs > w.newestMtime {
			w.newestMtime = secs
		}
		// Age bucket — coarse, but enough to inform the AI plan.
		ageDays := int(w.now.Sub(t).Hours() / 24)
		bucket := ageBucketFor(ageDays)
		b := w.byAge[bucket]
		if b == nil {
			b = &pathAgeBucket{Label: bucket}
			w.byAge[bucket] = b
		}
		b.Files++
		b.Bytes += e.FileSize
	}

	coll := e.Collection
	if coll == "" {
		coll = "(default)"
	}
	cb := w.byCollection[coll]
	if cb == nil {
		cb = &pathCollectionBucket{Collection: coll}
		w.byCollection[coll] = cb
	}
	cb.Files++
	cb.Bytes += e.FileSize

	ext := path.Ext(e.FullPath)
	if ext == "" {
		ext = "(no ext)"
	} else {
		ext = strings.ToLower(ext)
	}
	eb := w.byExtension[ext]
	if eb == nil {
		eb = &pathExtBucket{Ext: ext}
		w.byExtension[ext] = eb
	}
	eb.Files++
	eb.Bytes += e.FileSize

	// Keep the first 20 matches as a sample so the UI can show what
	// kinds of files actually got selected (helps catch glob mistakes).
	if len(w.samples) < 20 {
		w.samples = append(w.samples, e)
	}
}

func ageBucketFor(days int) string {
	switch {
	case days < 7:
		return "0-7d"
	case days < 30:
		return "7-30d"
	case days < 90:
		return "30-90d"
	case days < 365:
		return "90d-1y"
	default:
		return "1y+"
	}
}

func (w *pathWalker) finalize() *pathPreviewResp {
	collections := make([]pathCollectionBucket, 0, len(w.byCollection))
	for _, c := range w.byCollection {
		collections = append(collections, *c)
	}
	sort.Slice(collections, func(i, j int) bool { return collections[i].Bytes > collections[j].Bytes })

	exts := make([]pathExtBucket, 0, len(w.byExtension))
	for _, e := range w.byExtension {
		exts = append(exts, *e)
	}
	sort.Slice(exts, func(i, j int) bool { return exts[i].Bytes > exts[j].Bytes })
	if len(exts) > 15 {
		exts = exts[:15]
	}

	ageOrder := []string{"0-7d", "7-30d", "30-90d", "90d-1y", "1y+"}
	ages := make([]pathAgeBucket, 0, len(ageOrder))
	for _, label := range ageOrder {
		if a := w.byAge[label]; a != nil {
			ages = append(ages, *a)
		}
	}

	return &pathPreviewResp{
		Truncated:       w.truncated,
		MatchedFiles:    w.matched,
		TotalBytes:      w.totalBytes,
		OldestMtimeSecs: w.oldestMtime,
		NewestMtimeSecs: w.newestMtime,
		ByCollection:    collections,
		ByExtension:     exts,
		ByAge:           ages,
		Samples:         w.samples,
		Walked:          w.walked,
		Filters:         w.filters,
	}
}

// fetch wraps one filer listing page. Uses the same auth path as
// clusterFilesList so JWT-protected filers work.
func (w *pathWalker) fetch(ctx context.Context, dir, last string) (*filerListing, error) {
	urlPath := dir
	if !strings.HasSuffix(urlPath, "/") {
		urlPath += "/"
	}
	u := "http://" + w.filer + urlPath + "?limit=" + fmt.Sprintf("%d", pathMigrateListLimit)
	if last != "" {
		u += "&lastFileName=" + url.QueryEscape(last)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	attachFilerAuth(req, w.cl)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", urlPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg, _ := describeFilerError(w.filer, resp.StatusCode, b)
		return nil, fmt.Errorf("filer %s: %s", urlPath, msg)
	}
	var listing filerListing
	if err := json.NewDecoder(resp.Body).Decode(&listing); err != nil {
		return nil, fmt.Errorf("decode listing: %w", err)
	}
	return &listing, nil
}

// isFilerDir mirrors the front-end's directory bit detection. Go's
// os.FileMode flags ModeDir as the top bit (1<<31) in Mode; older
// filer builds also accept the POSIX S_IFDIR bit 0x4000.
func isFilerDir(mode uint32) bool {
	return (mode>>31)&1 == 1 || mode&0x4000 != 0
}
