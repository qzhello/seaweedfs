package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/validation"
)

// ----------------------- Clusters CRUD -----------------------

func listClusters(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cs, err := d.PG.ListClusters(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": cs})
	}
}

func upsertCluster(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var x store.Cluster
		if err := c.BindJSON(&x); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if len(x.Guard) > 0 && string(x.Guard) != "null" {
			var decoded interface{}
			if err := json.Unmarshal(x.Guard, &decoded); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "guard: invalid json"})
				return
			}
			if err := validation.Default.Validate("cluster.guard", decoded); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
		}
		id, err := d.PG.UpsertCluster(c.Request.Context(), x)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "cluster", id.String(), x)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteCluster(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteCluster(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "delete", "cluster", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// Topology drilldown for one cluster.
func clusterTopology(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		topo, err := d.Sw.FetchTopologyShellAt(c.Request.Context(), cl.MasterAddr, cl.WeedBinPath)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		usage, _ := d.PG.LatestNodeUsage(c.Request.Context(), id)
		c.JSON(http.StatusOK, gin.H{"cluster": cl, "topology": topo, "usage_history_latest": usage})
	}
}

// ----------------------- Ad-hoc weed shell -----------------------
//
// The set of commands operators can run is the shellCatalog defined in
// shell_catalog.go. Anything outside the catalog must go through a Skill
// so the change is reviewed and audited as a real task. To add a new
// command, append it to shellCatalog with an appropriate risk tier.

// clusterShellExec runs a single `weed shell` command against the named
// cluster's master and returns its captured stdout. The command name is
// validated against the shellCatalog; args are passed verbatim.
//
// Body: {"command": "volume.list", "args": "-collection=images", "dry_run": true}
//
// The controller binary path resolution prefers the cluster's
// weed_bin_path column when set, falling back to env / PATH otherwise.
//
// Every call is audited regardless of outcome.
func clusterShellExec(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Command string `json:"command"`
			Args    string `json:"args"`   // single string, split on whitespace
			Reason  string `json:"reason"` // optional free-form for audit
		}
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		name := strings.TrimSpace(body.Command)
		if name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "command required"})
			return
		}
		allow := shellAllowedNames()
		if _, ok := allow[name]; !ok {
			c.JSON(http.StatusForbidden, gin.H{
				"error": fmt.Sprintf("command %q is not in the operator catalog; wrap it in a Skill instead", name),
			})
			return
		}
		// Reason is recorded for audit but no longer required — operators
		// often run the same command repeatedly and the modal friction was
		// not worth the audit signal in practice.
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var args []string
		if s := strings.TrimSpace(body.Args); s != "" {
			args = strings.Fields(s)
		}

		_ = d.PG.Audit(c.Request.Context(), userOf(c), "shell.exec", "cluster", id.String(), map[string]any{
			"command": name, "args": args, "reason": body.Reason,
			"master": cl.MasterAddr, "bin_path": cl.WeedBinPath,
		})

		// Detach from request context so the operator can navigate away
		// without killing a long-running fsck. Cap at the shell-runner's
		// internal timeout (10m).
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, name, args, nil)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "command": name, "args": args})
	}
}

// shellCatalogList returns the full catalog of weed shell commands the
// operator console can offer. UI groups them by Category and renders
// guided forms from the typed Args. The endpoint is read-only and
// available to every authenticated principal — the gating happens on
// clusterShellExec at the admin layer.
func shellCatalogList(_ Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"items": shellCatalog})
	}
}

// clusterShellHelp runs `<command> -h` (or `help <command>`) against the
// cluster and returns the raw help text. We use this for live arg
// discovery on commands the catalog doesn't ship typed Args for, so
// operators can still see what flags exist without leaving the UI.
func clusterShellHelp(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		name := strings.TrimSpace(c.Query("cmd"))
		if name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cmd query required"})
			return
		}
		if _, ok := shellAllowedNames()[name]; !ok {
			c.JSON(http.StatusForbidden, gin.H{"error": "command not in catalog"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		// `help` is the shell built-in that prints a command's flag list.
		// It's read-only and doesn't need lock/unlock.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		out, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "help", []string{name})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"command": name, "help": out})
	}
}

// clusterHealth probes a cluster's master HTTP + gRPC reachability so
// the UI can show a live red/green badge per cluster instead of
// blocking on a 15s volume.list timeout to find out things are down.
// Probe results are cached in the seaweed package for ~3s so a
// dashboard refresh doesn't fan out a wave of dials.
func clusterHealth(d Deps) gin.HandlerFunc {
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
		start := time.Now()
		err = d.Sw.ProbeMaster(cl.MasterAddr)
		latency := time.Since(start)
		resp := gin.H{
			"cluster_id": id, "master": cl.MasterAddr,
			"reachable":  err == nil,
			"latency_ms": latency.Milliseconds(),
		}
		if err != nil {
			resp["error"] = err.Error()
		}
		c.JSON(http.StatusOK, resp)
	}
}

// clusterShellStream is the SSE variant of clusterShellExec for commands
// flagged Streams=true in the catalog (volume.balance, ec.encode,
// volume.fix.replication, …). Each stdout line from `weed shell` arrives
// as an SSE `data:` event so the UI can render a live tail instead of
// waiting up to 10 minutes for the buffered POST to return.
//
// GET /api/v1/clusters/:id/shell/stream?command=X&args=...&reason=Y
//
// Same auth + allowlist + reason rules as clusterShellExec. The reason
// is required up-front because once the SSE stream opens we no longer
// have a request body.
func clusterShellStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		name := strings.TrimSpace(c.Query("command"))
		argsRaw := strings.TrimSpace(c.Query("args"))
		reason := strings.TrimSpace(c.Query("reason"))
		if name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "command required"})
			return
		}
		cmd, ok := shellAllowedNames()[name]
		if !ok {
			c.JSON(http.StatusForbidden, gin.H{"error": "command not in catalog"})
			return
		}
		// Reason optional — see clusterShell for rationale.
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var args []string
		if argsRaw != "" {
			args = strings.Fields(argsRaw)
		}

		_ = d.PG.Audit(c.Request.Context(), userOf(c), "shell.stream", "cluster", id.String(), map[string]any{
			"command": name, "args": args, "reason": reason,
			"master": cl.MasterAddr, "bin_path": cl.WeedBinPath,
		})

		// SSE prelude
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.WriteHeader(http.StatusOK)
		c.Writer.Flush()

		flush := func(event, payload string) {
			// SSE: lines starting with "data:" form one event ending in blank line.
			// We also support custom event types so the client can distinguish
			// stdout lines ("line") from terminal status ("done" / "error").
			_, _ = fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, payload)
			c.Writer.Flush()
		}

		sink := func(ln string) { flush("line", ln) }

		// Detach from the request context so the operator navigating away
		// doesn't kill a 10-minute volume.balance. SSE write failures (client
		// disconnect) become no-ops; the subprocess continues until its own
		// completion or the shell-runner timeout.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		var (
			out    string
			runErr error
		)
		if cmd.ReadOnly {
			out, runErr = d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, name, args)
			// RunShellReadOnly buffers — replay it as one big line for the UI.
			for _, ln := range strings.Split(out, "\n") {
				if ln != "" {
					sink(ln)
				}
			}
		} else {
			out, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, name, args, sink)
			_ = out // already emitted via sink
		}
		if runErr != nil {
			flush("error", runErr.Error())
		} else {
			flush("done", "ok")
		}
	}
}

// ----------------------- Tags CRUD -----------------------

func listTags(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ts, err := d.PG.ListTags(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ts})
	}
}

func upsertTag(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t store.ResourceTag
		if err := c.BindJSON(&t); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		id, err := d.PG.UpsertTag(c.Request.Context(), t)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "tag", id.String(), t)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteTag(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteTag(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// ----------------------- Holidays + Trend -----------------------

func listHolidays(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		from := time.Now().AddDate(0, -1, 0)
		to := time.Now().AddDate(0, 6, 0)
		hs, err := d.PG.ListHolidays(c.Request.Context(), from, to)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		frozen, name, _ := d.PG.InHolidayFreeze(c.Request.Context(), time.Now())
		c.JSON(http.StatusOK, gin.H{"items": hs, "freeze_active": frozen, "freeze_holiday": name})
	}
}

func trend(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		days := 7
		if v := c.Query("days"); v != "" {
			if n, err := time.ParseDuration(v + "h"); err == nil {
				days = int(n.Hours() / 24)
			}
		}
		switch c.Query("range") {
		case "1d":
			days = 1
		case "7d":
			days = 7
		case "30d":
			days = 30
		}
		resolution := c.DefaultQuery("res", "hour")
		since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
		points, err := d.CH.Trend(c.Request.Context(), store.TrendOpts{
			Since: since, Until: time.Now(),
			Resolution: resolution,
			Collection: c.Query("collection"),
		})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"points": points, "since": since, "resolution": resolution})
	}
}

// trendByDomain joins ClickHouse stats with PG cluster.business_domain.
// Returns one series per business domain — used by the dashboard split.
func trendByDomain(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		days := 7
		switch c.Query("range") {
		case "1d":
			days = 1
		case "7d":
			days = 7
		case "30d":
			days = 30
		}
		resolution := c.DefaultQuery("res", "hour")
		since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)

		// Build collection→domain map. v1: every collection inherits its cluster's
		// business_domain via resource_tags scope_kind='collection' OR cluster default.
		clusters, _ := d.PG.ListClusters(c.Request.Context())
		byCollection := map[string]string{}
		for _, cl := range clusters {
			tags, _ := d.PG.ListTags(c.Request.Context(), cl.ID)
			for _, t := range tags {
				if t.ScopeKind == "collection" {
					byCollection[t.ScopeValue] = t.BusinessDomain
				}
			}
		}
		out, err := d.CH.TrendByCollections(c.Request.Context(), since, time.Now(), resolution, byCollection)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"series": out, "since": since, "resolution": resolution})
	}
}
