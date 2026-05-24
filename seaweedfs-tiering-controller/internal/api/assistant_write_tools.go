package api

// Assistant write tools.
//
// Read tools live in assistant_tools.go / assistant_s3_tools.go;
// write tools that the floating assistant can invoke through tool
// calling live here so the surface area is auditable in one place.
//
// Each write tool MUST:
//   1. Reject zero / out-of-range / clearly bogus values server-side
//      — the AI may hallucinate a number the operator never
//      authorised, so we treat the LLM as untrusted input.
//   2. Audit the call with `ai:<chat-id>` actor + the resolved
//      arguments so /audit shows the AI-driven write next to the
//      operator-driven ones.
//   3. Default to ai_allowed=FALSE in the policies table (handled
//      automatically by the ToolWrite risk class — see
//      assistant_tools.go ToolRisk doc comment). The operator opts
//      in explicitly via /ai-config/tools before the LLM can call.
//
// Tools intentionally NOT exposed here:
//   - delete_bucket / delete_identity — destructive, irreversible.
//   - run_skill — already covered by propose_skill which lands in
//     PENDING and requires explicit approval.
//   - circuit-breaker enable/disable — flipping the global toggle is
//     too coarse for tool calling; the operator should do that
//     through the UI.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
)

// Hard limits that bound what any AI-issued call can do. Anything
// outside these ranges is rejected with a structured error so the LLM
// can re-plan rather than retrying the same bad number.
const (
	minBucketQuotaMB       uint64 = 100                     // 100 MB — below this is almost certainly a typo
	maxBucketQuotaMB       uint64 = 10 * 1024 * 1024 * 1024 // 10 PB
	maxCircuitBreakerCount int64  = 1_000_000_000
	maxCircuitBreakerMB    int64  = 1_000_000_000
)

// assistantWriteTools is appended to the read-tool registry in
// assistant_tools.go. Kept separate so the read surface stays clean
// and reviewers can audit the entire write surface in one file.
func assistantWriteTools() []assistantTool {
	return []assistantTool{
		{
			Risk: ToolWrite,
			Spec: ai.ToolSpec{
				Name: "set_bucket_quota",
				Description: "Set or disable the quota on a single S3 bucket. Reversible — call again to " +
					"change the value or pass disable=true to remove the quota entirely. Hard limits: " +
					"size_mb must be between 100 and 10737418240 (10 PB). NEVER call this with a value " +
					"below the bucket's current usage without explicit operator confirmation in the chat. " +
					"Off by default — operator must opt in via /ai-config/tools.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID. Required."},
                        "bucket":{"type":"string","description":"Bucket name. Required."},
                        "size_mb":{"type":"integer","description":"Quota in MB. Required unless disable=true."},
                        "disable":{"type":"boolean","description":"true to remove the quota entirely. Mutually exclusive with size_mb."}
                    },
                    "required":["cluster_id","bucket"]
                }`),
			},
			Execute: toolSetBucketQuota,
		},
		{
			Risk: ToolWrite,
			Spec: ai.ToolSpec{
				Name: "set_circuit_breaker_limit",
				Description: "Set one threshold on the S3 gateway's circuit breaker. Type is either " +
					"'Count' (max in-flight requests) or 'MB' (max upload size). Reversible — call again " +
					"with a different value to change it. This tool only SETS a value; enable/disable of " +
					"the breaker itself is operator-only. Off by default — operator must opt in via " +
					"/ai-config/tools.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name or UUID. Required."},
                        "type":{"type":"string","enum":["Count","MB"],"description":"Threshold dimension."},
                        "value":{"type":"integer","description":"Positive integer; capped at 1,000,000,000."}
                    },
                    "required":["cluster_id","type","value"]
                }`),
			},
			Execute: toolSetCircuitBreakerLimit,
		},
	}
}

// toolSetBucketQuota wraps the `s3.bucket.quota` shell command. We
// don't reuse the gin-handler version because the assistant context
// has no gin.Context — we go straight to the shell runner.
func toolSetBucketQuota(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
		Bucket    string `json:"bucket"`
		SizeMB    uint64 `json:"size_mb"`
		Disable   bool   `json:"disable"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	if p.Bucket == "" {
		return nil, fmt.Errorf("bucket is required")
	}
	// Pre-flight: either disable, or a size_mb in range. The LLM
	// will sometimes pass both — disable wins explicitly to avoid
	// surprise.
	shellArgs := []string{"-name=" + p.Bucket}
	if p.Disable {
		shellArgs = append(shellArgs, "-disable")
	} else {
		if p.SizeMB < minBucketQuotaMB || p.SizeMB > maxBucketQuotaMB {
			return nil, fmt.Errorf("size_mb=%d is outside the allowed range [%d, %d]",
				p.SizeMB, minBucketQuotaMB, maxBucketQuotaMB)
		}
		shellArgs = append(shellArgs, "-sizeMB="+strconv.FormatUint(p.SizeMB, 10))
	}

	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}

	tctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	out, err := d.Sw.RunShellCommandAtWithBin(tctx, cl.MasterAddr, cl.WeedBinPath, "s3.bucket.quota", shellArgs, nil)

	actor := ActorFromCtx(ctx)
	actorLabel := actor.Kind + ":" + firstNonEmpty(actor.Email, actor.ChatID)
	_ = d.PG.Audit(ctx, actorLabel, "ai.tool.set_bucket_quota", "cluster", cl.ID.String(), map[string]any{
		"bucket":  p.Bucket,
		"size_mb": p.SizeMB,
		"disable": p.Disable,
		"tool":    "set_bucket_quota",
	})

	if err != nil {
		return nil, fmt.Errorf("shell s3.bucket.quota: %w (output: %s)", err, out)
	}
	return map[string]any{
		"cluster": cl.Name,
		"bucket":  p.Bucket,
		"size_mb": p.SizeMB,
		"disable": p.Disable,
		"output":  out,
	}, nil
}

// toolSetCircuitBreakerLimit wraps `s3.circuitBreaker -set -type=X -value=N`.
// Same shape as set_bucket_quota — server-side validation, then shell.
func toolSetCircuitBreakerLimit(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
		Type      string `json:"type"`
		Value     int64  `json:"value"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	if p.Type != "Count" && p.Type != "MB" {
		return nil, fmt.Errorf("type must be \"Count\" or \"MB\", got %q", p.Type)
	}
	if p.Value <= 0 {
		return nil, fmt.Errorf("value must be positive, got %d", p.Value)
	}
	switch p.Type {
	case "Count":
		if p.Value > maxCircuitBreakerCount {
			return nil, fmt.Errorf("Count value %d exceeds cap %d", p.Value, maxCircuitBreakerCount)
		}
	case "MB":
		if p.Value > maxCircuitBreakerMB {
			return nil, fmt.Errorf("MB value %d exceeds cap %d", p.Value, maxCircuitBreakerMB)
		}
	}

	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}

	shellArgs := []string{
		"-set",
		"-type=" + p.Type,
		"-value=" + strconv.FormatInt(p.Value, 10),
	}
	tctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := d.Sw.RunShellCommandAtWithBin(tctx, cl.MasterAddr, cl.WeedBinPath, "s3.circuitBreaker", shellArgs, nil)

	actor := ActorFromCtx(ctx)
	actorLabel := actor.Kind + ":" + firstNonEmpty(actor.Email, actor.ChatID)
	_ = d.PG.Audit(ctx, actorLabel, "ai.tool.set_circuit_breaker_limit", "cluster", cl.ID.String(), map[string]any{
		"type":  p.Type,
		"value": p.Value,
		"tool":  "set_circuit_breaker_limit",
	})

	if err != nil {
		return nil, fmt.Errorf("shell s3.circuitBreaker: %w (output: %s)", err, out)
	}
	return map[string]any{
		"cluster": cl.Name,
		"type":    p.Type,
		"value":   p.Value,
		"output":  out,
	}, nil
}
