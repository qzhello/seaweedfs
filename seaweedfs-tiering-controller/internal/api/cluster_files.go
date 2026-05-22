package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// fileBrowserDefaultLimit caps a single directory listing. Filer respects
// its own `DirListingLimit` config, so this is only a UI safety net to
// keep big directories from blowing up the JSON response.
const fileBrowserDefaultLimit = 500

// resolveFilerAddr loads the cluster's filer list (via the master) and
// returns the addr the caller requested, but only when it actually
// belongs to this cluster. This is the SSRF guard — without it the
// `filer` query param could be set to any URL the controller can reach.
func resolveFilerAddr(ctx context.Context, d Deps, cl *store.Cluster, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	// Build the allowlist from two sources: the master's filer-heartbeat
	// list (preferred, authoritative) plus the operator-provided
	// `cl.FilerAddr` from cluster registration (fallback for clusters
	// where the filer-master heartbeat isn't wired up, or temporarily
	// down). Either source is enough to whitelist a target.
	allowed := map[string]struct{}{}
	listCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	filers, listErr := d.Sw.ListFilers(listCtx, cl.MasterAddr)
	for _, f := range filers {
		if f.Address != "" {
			allowed[f.Address] = struct{}{}
		}
	}
	for _, addr := range splitCSV(cl.FilerAddr) {
		allowed[addr] = struct{}{}
	}
	if len(allowed) == 0 {
		if listErr != nil {
			return "", fmt.Errorf("no filers available: %w", listErr)
		}
		return "", fmt.Errorf("cluster has no filers registered (master reports none and no filer_addr is configured)")
	}
	if requested == "" {
		// Prefer master-reported filer when available; fall back to the
		// configured filer_addr (first entry).
		if len(filers) > 0 && filers[0].Address != "" {
			return filers[0].Address, nil
		}
		for _, addr := range splitCSV(cl.FilerAddr) {
			return addr, nil
		}
	}
	if _, ok := allowed[requested]; ok {
		return requested, nil
	}
	return "", fmt.Errorf("filer %q is not registered with this cluster", requested)
}

// filerJWTTTL is the lifetime of the signed JWT we attach to each
// filer HTTP call. SeaweedFS defaults to 10s; we use 60s so a single
// slow upload doesn't get rejected mid-stream.
const filerJWTTTL = 60 * time.Second

// attachFilerAuth signs a short-lived HS256 token and adds it as
// `Authorization: Bearer <jwt>` when the cluster has a filer_jwt
// secret configured. SeaweedFS filer rejects every HTTP call with 401
// "wrong jwt" when [jwt.filer_signing] is on and a valid token is
// missing. We sign per-request (not store a static token) because
// upstream JWTs default to 10s expiry.
//
// Claims mirror SeaweedFS's `SeaweedFilerClaims` with no allowed
// prefix/method restrictions and a fresh `exp`. That matches the
// behaviour of `weed shell` and the S3 gateway when they generate
// inbound tokens for the filer.
func attachFilerAuth(req *http.Request, cl *store.Cluster) {
	if cl == nil {
		return
	}
	secret := strings.TrimSpace(cl.FilerJWT)
	if secret == "" {
		return
	}
	token, err := signFilerJWT(secret, time.Now(), filerJWTTTL)
	if err != nil {
		// Signing only fails on JSON marshal of well-known structs —
		// effectively never. Skip the header on the theoretical error
		// path; the filer will respond 401 and the handler will
		// surface a clear message.
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
}

// signFilerJWT builds an HS256 JWT compatible with SeaweedFS filer's
// JWT middleware. We hand-roll the encoding instead of pulling in a
// dependency: header.payload.signature, all base64url-no-padding.
func signFilerJWT(secret string, now time.Time, ttl time.Duration) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(map[string]any{
		"exp": now.Add(ttl).Unix(),
	})
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	sig := enc.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

// describeFilerError builds an operator-friendly error message from a
// non-2xx filer response. The big tell is the XML envelope: SeaweedFS's
// native HTTP listing returns JSON, but the S3 gateway returns
// `<?xml...><Error><Code>AccessDenied</Code>...`. If we see that, the
// filer_addr is almost certainly pointing at the S3 gateway port
// (default 8333) instead of the filer HTTP port (default 8888).
//
// Returned: ("filer returned 403 (looks like S3 gateway): ...", true) for
// S3 XML responses; ("filer returned 403: <body>", false) otherwise.
func describeFilerError(filer string, status int, body []byte) (string, bool) {
	snippet := string(body)
	if len(snippet) > 512 {
		snippet = snippet[:512] + "…"
	}
	trim := strings.TrimSpace(string(body))
	if strings.HasPrefix(trim, "<?xml") && strings.Contains(trim, "<Code>") {
		hint := fmt.Sprintf(
			"filer at %s returned an S3-style %d response. This usually means filer_addr "+
				"is pointing at the S3 gateway port (default 8333) instead of the filer HTTP "+
				"port (default 8888). Update cluster.filer_addr to the filer's HTTP port and "+
				"retry. Original body: %s",
			filer, status, snippet)
		return hint, true
	}
	return fmt.Sprintf("filer at %s returned %d: %s", filer, status, snippet), false
}

// cleanFilerPath turns whatever the client sent into a single
// forward-slash-prefixed, traversal-safe path. Empty input becomes "/".
// `..` segments are collapsed by path.Clean.
func cleanFilerPath(raw string) string {
	if raw == "" {
		return "/"
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(raw, "/"))
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func clusterFilesList(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filer, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		dirPath := cleanFilerPath(c.Query("path"))
		// Filer's listing handler is on the dir URL itself; the trailing
		// slash matters — without it the GET path is a file lookup.
		urlPath := dirPath
		if !strings.HasSuffix(urlPath, "/") {
			urlPath += "/"
		}
		filerURL := "http://" + filer + urlPath + "?limit=" + fmt.Sprintf("%d", fileBrowserDefaultLimit)
		if last := strings.TrimSpace(c.Query("lastFileName")); last != "" {
			filerURL += "&lastFileName=" + url.QueryEscape(last)
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, filerURL, nil)
		req.Header.Set("Accept", "application/json")
		attachFilerAuth(req, cl)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "path not found", "path": dirPath, "filer": filer})
			return
		}
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			msg, _ := describeFilerError(filer, resp.StatusCode, body)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		// Re-emit the filer's JSON unchanged but attach the filer addr
		// + cleaned path so the UI doesn't have to re-encode them.
		var raw json.RawMessage
		if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"filer": filer, "path": dirPath, "listing": raw})
	}
}

func clusterFilesDownload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filer, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		filePath := cleanFilerPath(c.Query("path"))
		if filePath == "/" || strings.HasSuffix(filePath, "/") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "path must point at a file"})
			return
		}
		filerURL := "http://" + filer + filePath
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, filerURL, nil)
		attachFilerAuth(req, cl)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			msg, _ := describeFilerError(filer, resp.StatusCode, body)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		// Forward the body as a download. `attachment` so browsers save
		// instead of rendering — operators are usually pulling binaries
		// or logs they want as a file, not as a page.
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			c.Header("Content-Type", ct)
		}
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			c.Header("Content-Length", cl)
		}
		name := path.Base(filePath)
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(name)))
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, resp.Body)
	}
}

func clusterFilesUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filer, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		dirPath := cleanFilerPath(c.Query("path"))
		if !strings.HasSuffix(dirPath, "/") {
			dirPath += "/"
		}
		// We forward the whole multipart body straight through — the
		// filer will read the same `file` field and create the entry.
		// Re-emitting the body means we don't have to buffer the upload
		// in memory.
		filerURL := "http://" + filer + dirPath
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, filerURL, c.Request.Body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if ct := c.GetHeader("Content-Type"); ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		attachFilerAuth(req, cl)
		if cl := c.GetHeader("Content-Length"); cl != "" {
			req.Header.Set("Content-Length", cl)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
		if resp.StatusCode >= 400 {
			msg, _ := describeFilerError(filer, resp.StatusCode, body)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		// The filer returns JSON like {"name": "...", "size": N}. Pass
		// through verbatim so the UI sees the same shape as a direct
		// filer upload.
		c.Header("Content-Type", resp.Header.Get("Content-Type"))
		c.Status(http.StatusOK)
		_, _ = c.Writer.Write(body)
	}
}

func clusterFilesDelete(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filer, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		filePath := cleanFilerPath(c.Query("path"))
		if filePath == "/" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "refusing to delete root"})
			return
		}
		recursive := c.Query("recursive") == "true"
		filerURL := "http://" + filer + filePath
		if recursive {
			filerURL += "?recursive=true&ignoreRecursiveError=true"
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, filerURL, nil)
		attachFilerAuth(req, cl)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			msg, _ := describeFilerError(filer, resp.StatusCode, body)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": filePath, "recursive": recursive})
	}
}

// clusterFilesMkdir creates a zero-byte placeholder file at the requested
// directory path so the filer materialises the parent path. SeaweedFS
// directories are otherwise implicit (created on first write); the
// placeholder is the minimum-friction way to make an empty folder visible
// in the browser. The UI removes the placeholder later if the operator
// uploads a real file or deletes the folder.
func clusterFilesMkdir(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		var body struct {
			Path  string `json:"path"`
			Filer string `json:"filer"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ctx := c.Request.Context()
		filer, err := resolveFilerAddr(ctx, d, cl, body.Filer)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		dirPath := cleanFilerPath(body.Path)
		if dirPath == "/" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "path must not be /"})
			return
		}
		placeholderURL := "http://" + filer + dirPath + "/.keep"
		req, _ := http.NewRequestWithContext(ctx, http.MethodPut, placeholderURL, strings.NewReader(""))
		req.Header.Set("Content-Type", "text/plain")
		attachFilerAuth(req, cl)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			msg, _ := describeFilerError(filer, resp.StatusCode, b)
			c.JSON(http.StatusBadGateway, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, gin.H{"created": dirPath})
	}
}

func loadClusterForFiles(d Deps, c *gin.Context) (*store.Cluster, error) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
		return nil, err
	}
	cl, err := d.PG.GetCluster(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return nil, err
	}
	return cl, nil
}

// sanitizeFilename strips characters that would break a Content-Disposition
// header. Anything outside a conservative ASCII allow-list is dropped so
// the filer's UTF-8 paths still produce a safe download header.
func sanitizeFilename(name string) string {
	out := make([]byte, 0, len(name))
	for _, r := range name {
		if r < 32 || r == '"' || r == '\\' || r == '/' {
			continue
		}
		if r < 127 {
			out = append(out, byte(r))
		}
	}
	if len(out) == 0 {
		return "download"
	}
	return string(out)
}
