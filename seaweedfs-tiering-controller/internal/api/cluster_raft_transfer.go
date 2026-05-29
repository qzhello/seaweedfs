package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// transferLeaderTimeout bounds the shell call. The command itself does a
// 10s cluster list + a 30s transfer RPC, so 60s leaves headroom.
const transferLeaderTimeout = 60 * time.Second

// validateTransferTarget enforces that the optional target id and address
// are supplied together (or both omitted for auto-selection).
func validateTransferTarget(targetID, targetAddress string) error {
	if (targetID == "") != (targetAddress == "") {
		return fmt.Errorf("target_id and target_address must be provided together")
	}
	return nil
}

// buildTransferArgs renders the CLI flags. Empty target → no flags (the
// command auto-selects an eligible follower).
func buildTransferArgs(targetID, targetAddress string) []string {
	if targetID == "" {
		return []string{}
	}
	return []string{"-id=" + targetID, "-address=" + targetAddress}
}

// clusterRaftTransferLeader wraps `weed shell cluster.raft.transferLeader`.
// Gated by guardEmergencyAllow (emergency stop only — change/maintenance/
// holiday windows are intentionally allowed since this is a maintenance-prep
// action). Route cap: cluster.raft.transfer.
//
// POST /api/v1/clusters/:id/masters/transfer-leader
// Body (optional): {"target_id": "...", "target_address": "host:grpcPort"}
func clusterRaftTransferLeader(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		if !guardEmergencyAllow(d, c) {
			return
		}
		var body struct {
			TargetID      string `json:"target_id,omitempty"`
			TargetAddress string `json:"target_address,omitempty"`
		}
		_ = c.ShouldBindJSON(&body)
		body.TargetID = strings.TrimSpace(body.TargetID)
		body.TargetAddress = strings.TrimSpace(body.TargetAddress)
		if err := validateTransferTarget(body.TargetID, body.TargetAddress); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildTransferArgs(body.TargetID, body.TargetAddress)

		ctx, cancel := context.WithTimeout(c.Request.Context(), transferLeaderTimeout)
		defer cancel()
		out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
			"cluster.raft.transferLeader", args, nil)

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "cluster.raft.transfer-leader", "cluster", id.String(), map[string]any{
			"target_id":      body.TargetID,
			"target_address": body.TargetAddress,
			"ok":             runErr == nil,
		})

		if runErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": runErr.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "args": strings.Join(args, " ")})
	}
}
