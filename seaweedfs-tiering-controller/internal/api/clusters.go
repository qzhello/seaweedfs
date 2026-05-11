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

// clusterShellAllow whitelists shell command names the controller will run
// on operator demand. Anything outside this set must go through a Skill so
// the change is reviewed and audited as a real task. Edit cautiously —
// adding write/destroy commands here exposes them to anyone who reaches the
// admin role.
var clusterShellAllow = map[string]bool{
	// Read-only inspection
	"volume.list":       true,
	"volume.check.disk": true,
	"fs.meta.cat":       true,
	"cluster.check":     true,
	"cluster.ps":        true,
	"lock":              true,
	"unlock":            true,
	// Mutating but low-risk maintenance
	"volume.fix.replication": true,
	"volume.vacuum":          true,
	"volume.balance":         true,
	"volume.fsck":            true,
	"volume.mark":            true, // -readonly / -writable
	"volume.delete":          true,
	"volume.move":            true,
	"volume.copy":            true,
	"volume.shrink":          true,
	"volume.tier.upload":     true,
	"volume.tier.download":   true,
	"ec.encode":              true,
	"ec.rebuild":             true,
	"ec.decode":              true,
}

// clusterShellExec runs a single `weed shell` command against the named
// cluster's master and returns its captured stdout. The command name is
// validated against clusterShellAllow; args are passed verbatim.
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
		if !clusterShellAllow[name] {
			c.JSON(http.StatusForbidden, gin.H{
				"error": fmt.Sprintf("command %q is not in the operator allowlist; wrap it in a Skill instead", name),
			})
			return
		}
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
