package api

import (
	"context"
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

// VolumeOps groups the higher-level volume operation endpoints used by
// the dedicated /volumes/balance, /volumes/grow, /volumes/delete-empty
// pages. Each one wraps a `weed shell` command with parsing + audit so
// the frontend can render structured UI instead of raw text output.

// ---------------- balance plan ----------------

// VolumeMove is one planned migration extracted from `volume.balance`
// dry-run output.
type VolumeMove struct {
	VolumeID   uint64 `json:"volume_id"`
	From       string `json:"from"`
	To         string `json:"to"`
	Collection string `json:"collection,omitempty"`
	SizeMB     uint64 `json:"size_mb,omitempty"`
}

// `volume.balance` (without -force) prints lines describing the moves
// it WOULD perform. The exact format varies slightly across SeaweedFS
// versions but the canonical shape is:
//
//   volume 42 from 10.0.0.5:8080 to 10.0.0.6:8080
//   plan: moving volume 42 collection logs size 1024MB from 10.0.0.5:8080 to 10.0.0.6:8080
//
// We accept either shape via a permissive regex; anything we can't
// parse is preserved in the raw output for the operator to inspect.
var balanceMoveRE = regexp.MustCompile(
	`volume\s+(\d+)` +
		`(?:\s+collection\s+(\S+))?` +
		`(?:\s+size\s+(\d+)\s*MB)?` +
		`\s+from\s+(\S+)\s+to\s+(\S+)`,
)

func parseBalancePlan(raw string) []VolumeMove {
	var moves []VolumeMove
	for _, line := range strings.Split(raw, "\n") {
		m := balanceMoveRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		vol, _ := strconv.ParseUint(m[1], 10, 64)
		size, _ := strconv.ParseUint(m[3], 10, 64)
		moves = append(moves, VolumeMove{
			VolumeID:   vol,
			Collection: m[2],
			SizeMB:     size,
			From:       m[4],
			To:         m[5],
		})
	}
	return moves
}

// volumeBalancePlan runs `volume.balance` WITHOUT -force, captures the
// dry-run plan, parses moves, and returns both the structured list and
// the raw output so the UI can still surface anything we missed.
func volumeBalancePlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		// Optional knobs forwarded to the shell command. Empty values
		// fall back to weed's own defaults.
		var body struct {
			Collection string `json:"collection,omitempty"`
			DataCenter string `json:"data_center,omitempty"`
			Rack       string `json:"rack,omitempty"`
		}
		_ = c.ShouldBindJSON(&body)

		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{}
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.DataCenter != "" {
			args = append(args, "-dataCenter="+body.DataCenter)
		}
		if body.Rack != "" {
			args = append(args, "-rack="+body.Rack)
		}
		// Long-running plans can take a minute on big clusters; cap it.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.balance", args)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		moves := parseBalancePlan(out)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.balance.plan", "cluster", id.String(), map[string]any{
			"moves":      len(moves),
			"collection": body.Collection,
		})
		c.JSON(http.StatusOK, gin.H{
			"moves":  moves,
			"output": out,
		})
	}
}

// ---------------- grow ----------------

// volumeGrow runs `volume.grow` with structured params. The master
// decides actual placement; we return whatever weed printed so the UI
// can show the new volume IDs.
func volumeGrow(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Collection  string `json:"collection"`
			Replication string `json:"replication,omitempty"`
			DataCenter  string `json:"data_center,omitempty"`
			Rack        string `json:"rack,omitempty"`
			Count       int    `json:"count"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if body.Count <= 0 || body.Count > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "count must be 1..100"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var args []string
		if body.Collection != "" {
			args = append(args, "-collection="+body.Collection)
		}
		if body.Replication != "" {
			args = append(args, "-replication="+body.Replication)
		}
		if body.DataCenter != "" {
			args = append(args, "-dataCenter="+body.DataCenter)
		}
		if body.Rack != "" {
			args = append(args, "-rack="+body.Rack)
		}
		args = append(args, "-count="+strconv.Itoa(body.Count))

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.grow", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.grow", "cluster", id.String(), map[string]any{
			"collection":  body.Collection,
			"replication": body.Replication,
			"count":       body.Count,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "args": strings.Join(args, " ")})
	}
}

// ---------------- delete-empty ----------------

// volumeDeleteEmpty deletes one specific empty volume replica via
// `volume.delete`. The frontend computes the candidate list from the
// existing /volumes endpoint (Size==0) and calls this per row so each
// deletion is independently auditable.
func volumeDeleteEmpty(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			VolumeID uint64 `json:"volume_id"`
			Node     string `json:"node"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.VolumeID == 0 || body.Node == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "volume_id + node required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{
			"-volumeId=" + strconv.FormatUint(body.VolumeID, 10),
			"-node=" + body.Node,
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		out, err := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "volume.delete", args, nil)
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "volume.delete-empty", "volume",
			fmt.Sprintf("%d@%s", body.VolumeID, body.Node), map[string]any{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out})
	}
}
