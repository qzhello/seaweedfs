package api

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// Cluster-level operations:
//   - volume.check.disk       (whole-cluster disk integrity scan)
//   - volume.configure.replication (per-collection replication change)
//   - volumeServer.leave      (drain a volume server before maintenance)
//
// Each command wraps `weed shell` with light parsing so the UI can
// render structured tables instead of raw text.

// ---------------- check-disk ----------------

// DiskCheckRow is one result line per volume.
type DiskCheckRow struct {
	VolumeID uint64 `json:"volume_id"`
	Server   string `json:"server"`
	OK       bool   `json:"ok"`
	Message  string `json:"message,omitempty"`
}

// Headers look like: "checking volume 42 on 10.0.0.5:8080" — both
// `weed shell volume.check.disk` and its `-volumeId=N` variant emit
// this preamble; we accept either form.
var diskCheckHdrRE = regexp.MustCompile(`(?i)check(?:ing)?\s+volume\s+(\d+)\s+on\s+(\S+)`)

// Per-volume errors are anything beneath a header that isn't an "ok"
// marker; we treat empty body == ok and any non-"ok" content as issue.
func parseDiskCheck(raw string) []DiskCheckRow {
	var rows []DiskCheckRow
	var cur *DiskCheckRow
	flush := func() {
		if cur == nil {
			return
		}
		if cur.Message == "" || strings.EqualFold(strings.TrimSpace(cur.Message), "ok") {
			cur.OK = true
			cur.Message = ""
		}
		rows = append(rows, *cur)
		cur = nil
	}
	for _, line := range strings.Split(raw, "\n") {
		if m := diskCheckHdrRE.FindStringSubmatch(line); m != nil {
			flush()
			vid, _ := strconv.ParseUint(m[1], 10, 64)
			cur = &DiskCheckRow{VolumeID: vid, Server: m[2]}
			continue
		}
		if cur == nil {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if cur.Message == "" {
			cur.Message = trimmed
		} else {
			cur.Message += "\n" + trimmed
		}
	}
	flush()
	return rows
}

func clusterCheckDisk(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			VolumeID uint64 `json:"volume_id,omitempty"`
		}
		_ = c.ShouldBindJSON(&body)
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{}
		if body.VolumeID > 0 {
			args = append(args, "-volumeId="+strconv.FormatUint(body.VolumeID, 10))
		}
		// Whole-cluster fsck can be expensive; cap aggressively.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.check.disk", args)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		rows := parseDiskCheck(out)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.check-disk", "cluster", id.String(), map[string]any{
			"volumes_checked": len(rows),
		})
		c.JSON(http.StatusOK, gin.H{"rows": rows, "output": out})
	}
}

// ---------------- configure replication ----------------

// configureReplication wraps `volume.configure.replication`. The shell
// command does not need a dry-run — we just forward the user's choice
// and surface output verbatim.
func clusterConfigureReplication(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Collection  string `json:"collection"`
			Replication string `json:"replication"`
			VolumeID    uint64 `json:"volume_id,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		body.Replication = strings.TrimSpace(body.Replication)
		// Format is e.g. "000" / "001" / "010" / "200"; three digits.
		if matched, _ := regexp.MatchString(`^[0-9]{3}$`, body.Replication); !matched {
			c.JSON(http.StatusBadRequest, gin.H{"error": "replication must be 3 digits (e.g. 001)"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{"-replication=" + body.Replication}
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.VolumeID > 0 {
			args = append(args, "-volumeId="+strconv.FormatUint(body.VolumeID, 10))
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.configure.replication", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.configure-replication", "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"replication": body.Replication,
			"volume_id":   body.VolumeID,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "args": strings.Join(args, " ")})
	}
}

// ---------------- volumeServer.leave ----------------

func clusterVolumeServerLeave(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Node  string `json:"node"`
			Force bool   `json:"force,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Node) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "node host:port required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{"-node=" + body.Node}
		if body.Force {
			args = append(args, "-force")
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volumeServer.leave", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume-server.leave", "cluster", id.String(), map[string]any{
			"node":  body.Node,
			"force": body.Force,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out})
	}
}
