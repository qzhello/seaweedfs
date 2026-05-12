package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// S3 management endpoints. The most important is `s3.configure` —
// SeaweedFS's identity / access-key / per-bucket permission system,
// stored as a single JSON document in the filer. We expose structured
// read + edit on top of `weed shell s3.configure` so operators don't
// have to hand-edit JSON.

// ---------------- s3.configure identities ----------------

// S3Action mirrors the SeaweedFS identity model. Actions look like
// "Read", "Write", "List", "Tagging", "Admin", "Read:bucket-name",
// "Write:bucket-name" — bare verbs apply to all buckets, suffix form
// scopes to a specific bucket.
type S3Identity struct {
	Name        string           `json:"name"`
	Credentials []S3Credential   `json:"credentials,omitempty"`
	Actions     []string         `json:"actions,omitempty"`
	Account     *json.RawMessage `json:"account,omitempty"` // pass-through; varies by version
}

type S3Credential struct {
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

type S3Config struct {
	Identities []S3Identity `json:"identities"`
}

// `s3.configure -list` emits a JSON document optionally wrapped in
// banner lines. We strip everything before the first '{' and after the
// matching closing brace so json.Unmarshal sees pure JSON.
var s3JSONOpen = regexp.MustCompile(`(?s)\{.*\}`)

func parseS3Config(raw string) (S3Config, error) {
	var cfg S3Config
	m := s3JSONOpen.FindString(raw)
	if m == "" {
		// Empty / fresh cluster: no identities yet.
		return cfg, nil
	}
	if err := json.Unmarshal([]byte(m), &cfg); err != nil {
		return cfg, fmt.Errorf("parse s3 config: %w", err)
	}
	return cfg, nil
}

func s3ListIdentities(d Deps) gin.HandlerFunc {
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
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		out, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "s3.configure", []string{"-list"})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		cfg, err := parseS3Config(out)
		if err != nil {
			// Fall back to raw output so the operator can see what the
			// shell actually printed even when we couldn't parse it.
			c.JSON(http.StatusOK, gin.H{"identities": []S3Identity{}, "raw": out, "parse_error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"identities": cfg.Identities, "raw": out})
	}
}

// s3UpsertIdentity adds or updates a single identity. We invoke
// `s3.configure -user=X -access_key=Y -secret_key=Z -actions=a,b,c
// -apply`. The shell command is idempotent on the user; passing the
// same user with new actions replaces the action set.
func s3UpsertIdentity(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			User      string   `json:"user"`
			AccessKey string   `json:"access_key,omitempty"`
			SecretKey string   `json:"secret_key,omitempty"`
			Actions   []string `json:"actions,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.User) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{"-user=" + body.User}
		if body.AccessKey != "" {
			args = append(args, "-access_key="+body.AccessKey)
		}
		if body.SecretKey != "" {
			args = append(args, "-secret_key="+body.SecretKey)
		}
		if len(body.Actions) > 0 {
			args = append(args, "-actions="+strings.Join(body.Actions, ","))
		}
		args = append(args, "-apply")
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "s3.configure", args, nil)
		p, _ := auth.Of(c)
		// IMPORTANT: don't log access_key / secret_key in audit payload.
		_ = d.PG.Audit(c.Request.Context(), p.Email, "s3.identity.upsert", "cluster", id.String(), map[string]any{
			"user":    body.User,
			"actions": body.Actions,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out})
	}
}

func s3DeleteIdentity(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		user := strings.TrimSpace(c.Param("user"))
		if user == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "s3.configure",
			[]string{"-user=" + user, "-delete", "-apply"}, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "s3.identity.delete", "cluster", id.String(), map[string]any{"user": user})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out})
	}
}

// ---------------- bucket mutations ----------------

type bucketAction struct {
	command string
	args    []string
	cap     string
	audit   string
}

func runBucketShell(d Deps, c *gin.Context, act bucketAction) {
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
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
	defer cancel()
	out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, act.command, act.args, nil)
	p, _ := auth.Of(c)
	_ = d.PG.Audit(c.Request.Context(), p.Email, act.audit, "cluster", id.String(), map[string]any{
		"args": strings.Join(act.args, " "),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
		return
	}
	c.JSON(http.StatusOK, gin.H{"output": out})
}

func s3BucketDelete(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct{ Name string `json:"name"` }
		if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.bucket.delete",
			args:    []string{"-name=" + b.Name},
			audit:   "s3.bucket.delete",
		})
	}
}

func s3BucketOwner(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct{ Bucket, Owner string }
		if err := c.ShouldBindJSON(&b); err != nil || b.Bucket == "" || b.Owner == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bucket + owner required"})
			return
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.bucket.owner",
			args:    []string{"-bucket=" + b.Bucket, "-owner=" + b.Owner},
			audit:   "s3.bucket.owner",
		})
	}
}

func s3BucketQuota(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct {
			Name    string `json:"name"`
			SizeMB  uint64 `json:"size_mb"`
			Disable bool   `json:"disable,omitempty"`
		}
		if err := c.ShouldBindJSON(&b); err != nil || b.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}
		args := []string{"-name=" + b.Name}
		if b.Disable {
			args = append(args, "-disable")
		} else {
			args = append(args, "-sizeMB="+strconv.FormatUint(b.SizeMB, 10))
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.bucket.quota",
			args:    args,
			audit:   "s3.bucket.quota",
		})
	}
}

func s3BucketQuotaEnforce(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct {
			Name    string `json:"name"`
			Enforce bool   `json:"enforce"`
		}
		if err := c.ShouldBindJSON(&b); err != nil || b.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
			return
		}
		args := []string{"-name=" + b.Name}
		if b.Enforce {
			args = append(args, "-enforce")
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.bucket.quota.enforce",
			args:    args,
			audit:   "s3.bucket.quota.enforce",
		})
	}
}

// ---------------- circuit breaker ----------------

func s3CircuitBreaker(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct {
			Action string `json:"action"` // "enable" | "disable" | "list" | "set"
			Type   string `json:"type,omitempty"`
			Value  string `json:"value,omitempty"`
		}
		if err := c.ShouldBindJSON(&b); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var args []string
		switch b.Action {
		case "enable":
			args = []string{"-enable"}
		case "disable":
			args = []string{"-disable"}
		case "set":
			if b.Type == "" || b.Value == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "type + value required for 'set'"})
				return
			}
			args = []string{"-type=" + b.Type, "-value=" + b.Value, "-apply"}
		case "list", "":
			args = []string{}
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "unknown action"})
			return
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.circuitBreaker",
			args:    args,
			audit:   "s3.circuit-breaker",
		})
	}
}

// ---------------- clean uploads ----------------

func s3CleanUploads(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b struct{ TimeAgo string `json:"time_ago"` } // e.g. "24h", "7d"
		if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.TimeAgo) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "time_ago required (e.g. '24h')"})
			return
		}
		runBucketShell(d, c, bucketAction{
			command: "s3.clean.uploads",
			args:    []string{"-timeAgo=" + b.TimeAgo},
			audit:   "s3.clean-uploads",
		})
	}
}
