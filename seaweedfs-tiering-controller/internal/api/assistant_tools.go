package api

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// runnableSkillAction maps a skill key to the legacy task.Action that the
// executor's actionToSkill() recognises. propose_skill only accepts keys
// in this map — these are the SOPs the executor can actually run. Keep in
// sync with executor.actionToSkill (that map is unexported, hence the
// small duplication here).
var runnableSkillAction = map[string]string{
	"volume.tier_upload":     "tier_upload",
	"volume.tier_download":   "tier_download",
	"volume.ec_encode":       "ec_encode",
	"volume.ec_decode":       "ec_decode",
	"volume.delete_replica":  "delete_replica",
	"volume.balance":         "balance",
	"volume.shrink":          "shrink",
	"volume.fix_replication": "fix_replication",
	"volume.vacuum":          "vacuum",
	"volume.fsck":            "fsck",
	"collection.move":        "collection_move",
	"cluster.failover_check": "failover_check",
}

// volumeScopedSkills need a concrete volume_id; the rest run at the
// cluster (or collection) level.
var volumeScopedSkills = map[string]bool{
	"volume.tier_upload":     true,
	"volume.tier_download":   true,
	"volume.ec_encode":       true,
	"volume.ec_decode":       true,
	"volume.delete_replica":  true,
	"volume.shrink":          true,
	"volume.fix_replication": true,
	"volume.vacuum":          true,
	"volume.fsck":            true,
}

// resolveClusterRef looks up a cluster by either its UUID or its name.
// The assistant LLM naturally passes the human-readable cluster name it
// sees on screen (e.g. "qa_demo") rather than the UUID, so every tool
// that takes a cluster_id accepts both forms.
func resolveClusterRef(ctx context.Context, d Deps, ref string) (*store.Cluster, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("cluster_id is required (pass a cluster name or UUID)")
	}
	if id, err := uuid.Parse(ref); err == nil {
		cl, gerr := d.PG.GetCluster(ctx, id)
		if gerr != nil {
			return nil, fmt.Errorf("cluster lookup: %w", gerr)
		}
		return cl, nil
	}
	// Not a UUID — treat ref as a cluster name (case-insensitive).
	clusters, err := d.PG.ListClusters(ctx)
	if err != nil {
		return nil, fmt.Errorf("cluster lookup: %w", err)
	}
	for i := range clusters {
		if strings.EqualFold(clusters[i].Name, ref) {
			return &clusters[i], nil
		}
	}
	names := make([]string, 0, len(clusters))
	for _, c := range clusters {
		names = append(names, c.Name)
	}
	return nil, fmt.Errorf("no cluster named %q — known clusters: %s", ref, strings.Join(names, ", "))
}

// ToolRisk classifies how dangerous a tool is. Persisted in
// ai_tool_policies.risk_level as a code-side declaration: the
// operator cannot upgrade risk via the UI (e.g. mark a destructive
// tool as 'read' to slip past their own gate). It governs the
// default ai_allowed flag for new installs and the colour of the
// admin UI badge.
type ToolRisk string

const (
	ToolRead        ToolRisk = "read"        // pure query, no side effects
	ToolWrite       ToolRisk = "write"       // mutation; reversible
	ToolDestructive ToolRisk = "destructive" // mutation; not reversible
)

// assistantTool is one tool the floating assistant LLM can call.
// Specs are exposed to the model verbatim; Execute runs server-side
// against the controller's own dependencies.
//
// Risk gates two things:
//
//  1. The default value of ai_tool_policies.ai_allowed when the row
//     is first registered (read=true, write/destructive=false).
//  2. The UI badge so operators see at a glance how cautious they
//     should be when flipping the toggle.
//
// Note: ai_allowed=false makes the LLM physically unable to call the
// tool — it never appears in the toolspec list. There is no separate
// "approval prompt" flow yet. If you need that, layer it inside the
// tool's Execute (look up actor → require human-actor for writes).
type assistantTool struct {
	Spec    ai.ToolSpec
	Risk    ToolRisk
	Execute func(ctx context.Context, d Deps, args json.RawMessage) (any, error)
}

// assistantToolRegistry returns the deps-bound tool catalogue. We
// build it per-request (cheap) rather than at startup because each
// invocation captures a fresh d.PG / d.Sw closure with the request
// context attached — keeps tools simple and stateless.
func assistantToolRegistry() []assistantTool {
	return []assistantTool{
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "list_clusters",
				Description: "List all SeaweedFS clusters known to this controller (id, name, master_addr, business_domain, enabled).",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
			},
			Execute: toolListClusters,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "list_volumes",
				Description: "List volumes for a cluster, with optional collection filter. Returns volume id, server, size, collection, replica placement, and EC flag.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID. Required."},
                        "collection":{"type":"string","description":"Optional collection name filter."},
                        "only_ec":{"type":"boolean","description":"If true, return only EC volumes."},
                        "limit":{"type":"integer","description":"Cap on returned rows (default 50, max 500)."}
                    },
                    "required":["cluster_id"]
                }`),
			},
			Execute: toolListVolumes,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "get_ec_shards",
				Description: "Return the EC shard matrix for a cluster: which 14 shards each EC volume has and which are missing. Use this to find degraded volumes.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID."},
                        "only_unhealthy":{"type":"boolean","description":"If true, only return volumes with at least one missing shard."}
                    },
                    "required":["cluster_id"]
                }`),
			},
			Execute: toolGetECShards,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "list_skills",
				Description: "List the operational SOPs (skills) on the platform. Returns key, name, category, risk_level, and summary for each enabled skill.",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
			},
			Execute: toolListSkills,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "get_skill",
				Description: "Fetch one skill's full definition by key (e.g. 'ec.rebuild', 'volume.balance'). Returns body, steps, and risk metadata.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "key":{"type":"string","description":"Skill key, e.g. 'ec.rebuild'."}
                    },
                    "required":["key"]
                }`),
			},
			Execute: toolGetSkill,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "get_temperature",
				Description: "Per-collection storage temperature across the platform: total size, 7-day reads, and cold+frozen bytes. Use this to find which collections have cooled down and are migration candidates.",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
			},
			Execute: toolGetTemperature,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "get_costs",
				Description: "Monthly storage cost breakdown for a cluster: total spend, per-backend cost, top collections by spend, and how much storage is unpriced. Answers 'what does this cluster cost' / 'where is the money going'.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID. Required."}
                    },
                    "required":["cluster_id"]
                }`),
			},
			Execute: toolGetCosts,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "get_capacity_forecast",
				Description: "Capacity runway per cluster: current fill %, growth rate, and projected days-to-full from the linear trend. Answers 'when does cluster X run out of space'.",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
			},
			Execute: toolGetCapacityForecast,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "list_capacity_incidents",
				Description: "Capacity incidents — clusters whose tiering was auto-paused after hitting a capacity wall. Defaults to open incidents.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "status":{"type":"string","description":"open | resolved. Default open."}
                    }
                }`),
			},
			Execute: toolListCapacityIncidents,
		},
		{
			Risk: ToolRead,
			Spec: ai.ToolSpec{
				Name:        "path_preview",
				Description: "Walk a filer path on a cluster and summarise the files under it: matched file count, total bytes, age distribution, and per-collection breakdown. Optionally filter by minimum age in days or a filename glob. Use this to size up old data before recommending a migration.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID. Required."},
                        "path":{"type":"string","description":"Filer path, e.g. /buckets/logs. Required."},
                        "min_age_days":{"type":"integer","description":"Only count files older than this many days."},
                        "glob":{"type":"string","description":"Optional filename glob, e.g. *.log."}
                    },
                    "required":["cluster_id","path"]
                }`),
			},
			Execute: toolPathPreview,
		},
		{
			Risk: ToolWrite,
			Spec: ai.ToolSpec{
				Name: "toggle_skill",
				Description: "Enable or disable a SOP (skill) by key. Reversible. " +
					"Useful when an operator asks the assistant to 'turn off the X playbook' or " +
					"'enable the new Y procedure'. Off by default — needs explicit operator " +
					"opt-in in /ai-config/tools before the assistant can call it.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "key":{"type":"string","description":"Skill key to toggle."},
                        "enabled":{"type":"boolean","description":"true to enable, false to disable."}
                    },
                    "required":["key","enabled"]
                }`),
			},
			Execute: toolToggleSkill,
		},
		{
			Risk: ToolWrite,
			Spec: ai.ToolSpec{
				Name: "propose_skill",
				Description: "Propose running an operational SOP (skill) on a cluster. " +
					"This does NOT execute anything — it creates a PENDING task the operator " +
					"must explicitly approve before it runs. Call this instead of telling the " +
					"operator to run a command by hand. Runnable skill keys: volume.tier_upload, " +
					"volume.tier_download, volume.ec_encode, volume.ec_decode, volume.delete_replica, " +
					"volume.balance, volume.shrink, volume.fix_replication, volume.vacuum, " +
					"volume.fsck, collection.move, cluster.failover_check. The volume.* skills " +
					"(except volume.balance) require volume_id. Off by default — needs operator " +
					"opt-in in /ai-config/tools.",
				Schema: json.RawMessage(`{
                    "type":"object",
                    "properties":{
                        "cluster_id":{"type":"string","description":"Cluster name (as shown in the UI) or UUID. Required."},
                        "skill_key":{"type":"string","description":"One of the runnable skill keys listed in the description."},
                        "volume_id":{"type":"integer","description":"Target volume id. Required for volume-scoped skills."},
                        "collection":{"type":"string","description":"Target collection, for collection-scoped skills."},
                        "reason":{"type":"string","description":"Why this SOP should run — shown to the operator on the proposal card."}
                    },
                    "required":["cluster_id","skill_key","reason"]
                }`),
			},
			Execute: toolProposeSkill,
		},
	}
}

// --- Tool implementations ---------------------------------------------------

func toolListClusters(ctx context.Context, d Deps, _ json.RawMessage) (any, error) {
	cs, err := d.PG.ListClusters(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		MasterAddr     string `json:"master_addr"`
		BusinessDomain string `json:"business_domain"`
		Enabled        bool   `json:"enabled"`
	}
	out := make([]row, 0, len(cs))
	for _, c := range cs {
		out = append(out, row{
			ID:             c.ID.String(),
			Name:           c.Name,
			MasterAddr:     c.MasterAddr,
			BusinessDomain: c.BusinessDomain,
			Enabled:        c.Enabled,
		})
	}
	return map[string]any{"clusters": out}, nil
}

func toolListVolumes(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID  string `json:"cluster_id"`
		Collection string `json:"collection"`
		OnlyEC     bool   `json:"only_ec"`
		Limit      int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}
	vols, _, err := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
	if err != nil {
		return nil, fmt.Errorf("fetch volumes: %w", err)
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	type row struct {
		ID         uint32 `json:"id"`
		Server     string `json:"server"`
		Size       uint64 `json:"size"`
		Collection string `json:"collection"`
		IsEC       bool   `json:"is_ec"`
		ReadOnly   bool   `json:"read_only"`
		Rack       string `json:"rack,omitempty"`
		DataCenter string `json:"data_center,omitempty"`
	}
	out := make([]row, 0, limit)
	for _, v := range vols {
		if p.Collection != "" && v.Collection != p.Collection {
			continue
		}
		if p.OnlyEC && !v.IsEC {
			continue
		}
		out = append(out, row{
			ID: v.ID, Server: v.Server, Size: v.Size,
			Collection: v.Collection, IsEC: v.IsEC, ReadOnly: v.ReadOnly,
			Rack: v.Rack, DataCenter: v.DataCenter,
		})
		if len(out) >= limit {
			break
		}
	}
	return map[string]any{
		"cluster":   cl.Name,
		"truncated": len(out) >= limit,
		"count":     len(out),
		"volumes":   out,
	}, nil
}

func toolGetECShards(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID     string `json:"cluster_id"`
		OnlyUnhealthy bool   `json:"only_unhealthy"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}
	vols, _, err := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
	if err != nil {
		return nil, fmt.Errorf("fetch volumes: %w", err)
	}
	matrix := buildECShards(vols)
	rows := matrix.Volumes
	if p.OnlyUnhealthy {
		filtered := make([]ecVolumeMatrixRow, 0, len(rows))
		for _, r := range rows {
			if !r.Healthy {
				filtered = append(filtered, r)
			}
		}
		rows = filtered
	}
	// Trim shards_by_index from the JSON we hand the LLM — the
	// per-server fanout is large and rarely needed for diagnosis. The
	// model can call back with get_ec_shards on a smaller scope later.
	type row struct {
		ID            uint32 `json:"id"`
		Collection    string `json:"collection"`
		TotalSize     uint64 `json:"total_size"`
		Present       []int  `json:"present"`
		Missing       []int  `json:"missing"`
		ShardsPresent int    `json:"shards_present"`
		ShardsMissing int    `json:"shards_missing"`
		Healthy       bool   `json:"healthy"`
	}
	slim := make([]row, 0, len(rows))
	for _, r := range rows {
		slim = append(slim, row{
			ID:            r.ID,
			Collection:    r.Collection,
			TotalSize:     r.TotalSize,
			Present:       r.Present,
			Missing:       r.Missing,
			ShardsPresent: r.ShardsPresent,
			ShardsMissing: r.ShardsMissing,
			Healthy:       r.Healthy,
		})
	}
	return map[string]any{
		"cluster":      cl.Name,
		"total_shards": matrix.TotalShards,
		"count":        len(slim),
		"volumes":      slim,
	}, nil
}

func toolListSkills(ctx context.Context, d Deps, _ json.RawMessage) (any, error) {
	skills, err := d.PG.ListSkills(ctx, "")
	if err != nil {
		return nil, err
	}
	type row struct {
		Key       string `json:"key"`
		Name      string `json:"name"`
		Category  string `json:"category"`
		RiskLevel string `json:"risk_level"`
		Enabled   bool   `json:"enabled"`
		Summary   string `json:"summary"`
		Version   int    `json:"version"`
	}
	seen := map[string]struct{}{}
	out := []row{}
	for _, s := range skills {
		if _, ok := seen[s.Key]; ok {
			continue
		}
		seen[s.Key] = struct{}{}
		out = append(out, row{
			Key: s.Key, Name: s.Name, Category: s.Category,
			RiskLevel: s.RiskLevel, Enabled: s.Enabled,
			Summary: skillSummaryText(s.Definition), Version: s.Version,
		})
	}
	return map[string]any{"count": strconv.Itoa(len(out)), "skills": out}, nil
}

func toolGetSkill(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	if p.Key == "" {
		return nil, fmt.Errorf("key is required")
	}
	s, err := d.PG.GetSkillCurrent(ctx, p.Key)
	if err != nil {
		return nil, fmt.Errorf("skill lookup: %w", err)
	}
	return map[string]any{
		"key":        s.Key,
		"name":       s.Name,
		"category":   s.Category,
		"risk_level": s.RiskLevel,
		"version":    s.Version,
		"enabled":    s.Enabled,
		"definition": json.RawMessage(s.Definition),
	}, nil
}

// --- Caller identity (actor) ------------------------------------------------

// actorKey is the unexported context key under which the SSE handler
// stores the synthesized actor identity for one tool call. Lookups
// return ("", false) when no key is set — that's the legacy direct-API
// path (operator hit a controller endpoint directly without going
// through the assistant), so callers should treat that as
// "operator:<email>" from the auth principal.
type actorKey struct{}

// Actor identifies who is responsible for one tool execution. Used in
// audit log entries and (potentially) in write-tool gate checks.
//
// Kind is one of:
//   "user"        — direct operator action (email is set)
//   "ai"          — autonomous LLM tool call inside a chat
//
// ChatID / Provider are set for "ai" actors so audit entries can be
// traced back to the originating chat thread for postmortems.
type Actor struct {
	Kind     string `json:"kind"`
	Email    string `json:"email,omitempty"`
	Provider string `json:"provider,omitempty"`
	ChatID   string `json:"chat_id,omitempty"`
}

// WithActor returns a ctx that carries the given actor. The tool
// executor reads it back via ActorFromCtx to stamp audit entries.
func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFromCtx returns the actor stored on ctx, or a zero value when
// the ctx came from a non-assistant code path. Tools that need to
// reject AI callers should check `a.Kind == "ai"` explicitly.
func ActorFromCtx(ctx context.Context) Actor {
	v, _ := ctx.Value(actorKey{}).(Actor)
	return v
}

// --- toggle_skill -----------------------------------------------------------

// toolToggleSkill flips a skill's enabled flag. Demo write tool used
// to exercise the policy + audit path. Read flow:
//
//   1. Find the current enabled version of the skill (GetSkillCurrent).
//   2. Call UpsertCustomSkill with enabled = the requested value.
//      This bumps the version by one — version history is preserved
//      so an operator can roll back via /skills/<key>/history.
//   3. Audit the change with the AI-or-human actor on ctx.
func toolToggleSkill(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		Key     string `json:"key"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	if p.Key == "" {
		return nil, fmt.Errorf("key is required")
	}
	cur, err := d.PG.GetSkillCurrent(ctx, p.Key)
	if err != nil {
		return nil, fmt.Errorf("skill lookup: %w", err)
	}
	if cur.Enabled == p.Enabled {
		return map[string]any{
			"key":     p.Key,
			"enabled": p.Enabled,
			"changed": false,
			"note":    "skill was already in the requested state",
		}, nil
	}
	actor := ActorFromCtx(ctx)
	actorLabel := actor.Kind + ":" + firstNonEmpty(actor.Email, actor.ChatID)
	cur.Enabled = p.Enabled
	cur.ChangeNote = fmt.Sprintf("toggled via assistant tool by %s", actorLabel)
	saved, err := d.PG.UpsertCustomSkill(ctx, *cur, actorLabel)
	if err != nil {
		return nil, fmt.Errorf("upsert: %w", err)
	}
	// Audit so the change shows up alongside other write actions in
	// /audit. Tool-driven writes are noisier than human ones; the
	// `action` prefix makes them filterable.
	_ = d.PG.Audit(ctx, actorLabel, "ai.tool.toggle_skill",
		"skill", saved.Key, map[string]any{
			"version": saved.Version, "enabled": saved.Enabled, "tool": "toggle_skill",
		})
	return map[string]any{
		"key":     saved.Key,
		"enabled": saved.Enabled,
		"version": saved.Version,
		"changed": true,
	}, nil
}

// --- propose_skill ----------------------------------------------------------

// toolProposeSkill turns an SOP suggestion into a PENDING task. It never
// executes anything: the task lands in `pending` and only runs once the
// operator approves it (via the in-chat card or the /tasks page), so the
// normal approval / audit / autonomy gates still apply.
func toolProposeSkill(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID  string `json:"cluster_id"`
		SkillKey   string `json:"skill_key"`
		VolumeID   int32  `json:"volume_id"`
		Collection string `json:"collection"`
		Reason     string `json:"reason"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	p.SkillKey = strings.TrimSpace(p.SkillKey)
	p.Reason = strings.TrimSpace(p.Reason)

	action, ok := runnableSkillAction[p.SkillKey]
	if !ok {
		keys := make([]string, 0, len(runnableSkillAction))
		for k := range runnableSkillAction {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return nil, fmt.Errorf("%q is not a runnable skill — choose one of: %s",
			p.SkillKey, strings.Join(keys, ", "))
	}
	if p.Reason == "" {
		return nil, fmt.Errorf("reason is required — explain why this SOP should run")
	}
	if volumeScopedSkills[p.SkillKey] && p.VolumeID <= 0 {
		return nil, fmt.Errorf("skill %q operates on a single volume — provide volume_id", p.SkillKey)
	}

	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}

	// Confirm the skill is loaded + enabled so the operator does not
	// approve a task that will only fail at the executor.
	sk, serr := d.PG.GetSkillCurrent(ctx, p.SkillKey)
	if serr != nil {
		return nil, fmt.Errorf("skill %q not found on this platform", p.SkillKey)
	}
	if !sk.Enabled {
		return nil, fmt.Errorf("skill %q is disabled — enable it in /skills first", p.SkillKey)
	}

	actor := ActorFromCtx(ctx)
	actorLabel := actor.Kind + ":" + firstNonEmpty(actor.Email, actor.ChatID)

	target, _ := json.Marshal(map[string]any{
		"kind":       "ai_skill_proposal",
		"skill_key":  p.SkillKey,
		"reason":     p.Reason,
		"created_by": actorLabel,
		"created_at": time.Now().UTC().Format(time.RFC3339),
	})
	features, _ := json.Marshal(map[string]any{"source": "ai_assistant", "chat_id": actor.ChatID})

	t := store.Task{
		VolumeID:       p.VolumeID,
		Collection:     strings.TrimSpace(p.Collection),
		Action:         action,
		Target:         target,
		Score:          1.0, // operator-curated, not scheduler-scored
		Features:       features,
		Explanation:    fmt.Sprintf("[AI proposal] run SOP %s\n\n%s", p.SkillKey, p.Reason),
		Status:         "pending",
		IdempotencyKey: fmt.Sprintf("ai-skill:%s:%s:%d", cl.ID, p.SkillKey, p.VolumeID),
	}
	// business_domain is a Postgres enum — "" is not a valid value, so
	// pass nil and let the column be NULL.
	taskID, err := d.PG.InsertTaskWithCluster(ctx, t, &cl.ID, nil)
	if err != nil {
		if err == store.ErrDuplicateTask {
			return map[string]any{
				"proposal":  true,
				"duplicate": true,
				"skill_key": p.SkillKey,
				"cluster":   cl.Name,
				"message": fmt.Sprintf("A pending task for %s already exists on %s — approve the existing one.",
					p.SkillKey, cl.Name),
			}, nil
		}
		return nil, fmt.Errorf("create task: %w", err)
	}

	_ = d.PG.Audit(ctx, actorLabel, "ai.tool.propose_skill", "task", taskID.String(), map[string]any{
		"skill_key": p.SkillKey, "cluster_id": cl.ID.String(),
		"volume_id": p.VolumeID, "tool": "propose_skill",
	})

	return map[string]any{
		"proposal":  true,
		"task_id":   taskID.String(),
		"skill_key": p.SkillKey,
		"cluster":   cl.Name,
		"volume_id": p.VolumeID,
		"status":    "pending",
		"message": fmt.Sprintf("Queued %s on %s as a pending task. The operator must approve it before it runs.",
			p.SkillKey, cl.Name),
	}, nil
}

// --- read tools: temperature / cost / capacity / lifecycle ------------------

func toolGetTemperature(ctx context.Context, d Deps, _ json.RawMessage) (any, error) {
	if d.CH == nil {
		return nil, fmt.Errorf("ClickHouse is not configured — temperature data unavailable")
	}
	temps, err := d.CH.CollectionTemperatures(ctx)
	if err != nil {
		return nil, fmt.Errorf("temperature query: %w", err)
	}
	type row struct {
		Collection      string `json:"collection"`
		Volumes         uint64 `json:"volumes"`
		TotalSize       uint64 `json:"total_size"`
		Reads7d         uint64 `json:"reads_7d"`
		ColdFrozenBytes uint64 `json:"cold_frozen_bytes"`
		FrozenVolumes   uint64 `json:"frozen_volumes"`
	}
	const maxRows = 40
	out := make([]row, 0, maxRows)
	for _, t := range temps {
		if len(out) >= maxRows {
			break
		}
		out = append(out, row{
			Collection: t.Collection, Volumes: t.Volumes, TotalSize: t.TotalSize,
			Reads7d: t.Reads7d, ColdFrozenBytes: t.ColdSize + t.FrozenSize, FrozenVolumes: t.FrozenN,
		})
	}
	return map[string]any{
		"count":       len(out),
		"truncated":   len(temps) > maxRows,
		"collections": out,
	}, nil
}

func toolGetCosts(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}
	costs, err := computeCosts(ctx, d, cl.ID)
	if err != nil {
		return nil, fmt.Errorf("cost calc: %w", err)
	}
	type backendRow struct {
		Name          string  `json:"name"`
		Kind          string  `json:"kind"`
		MonthlyCost   float64 `json:"monthly_cost"`
		PhysicalBytes int64   `json:"physical_bytes"`
	}
	type collRow struct {
		Collection    string  `json:"collection"`
		PhysicalBytes int64   `json:"physical_bytes"`
		MonthlyCost   float64 `json:"monthly_cost"`
	}
	backends := make([]backendRow, 0, len(costs.Backends))
	for _, b := range costs.Backends {
		backends = append(backends, backendRow{b.Name, b.Kind, b.MonthlyCost, b.PhysicalBytes})
	}
	colls := make([]collRow, 0, 10)
	for _, cr := range costs.TopCollections {
		if len(colls) >= 10 {
			break
		}
		colls = append(colls, collRow{cr.Collection, cr.PhysicalBytes, cr.MonthlyCost})
	}
	return map[string]any{
		"cluster":              costs.ClusterID,
		"currency":             costs.Currency,
		"total_monthly_cost":   costs.TotalMonthlyCost,
		"counterfactual_cost":  costs.CounterfactualCost,
		"monthly_saving":       costs.MonthlySaving,
		"unpriced_bytes":       costs.UnpricedBytes,
		"backends":             backends,
		"top_collections":      colls,
		"recommendation_count": len(costs.Recommendations),
	}, nil
}

func toolGetCapacityForecast(ctx context.Context, d Deps, _ json.RawMessage) (any, error) {
	items, err := computeCapacityForecasts(ctx, d)
	if err != nil {
		return nil, fmt.Errorf("forecast: %w", err)
	}
	return map[string]any{"count": len(items), "forecasts": items}, nil
}

func toolListCapacityIncidents(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(args, &p) // args optional
	if p.Status == "" {
		p.Status = "open"
	}
	incs, err := d.PG.ListCapacityIncidents(ctx, p.Status, 50)
	if err != nil {
		return nil, fmt.Errorf("list incidents: %w", err)
	}
	type row struct {
		ID             string `json:"id"`
		Cluster        string `json:"cluster"`
		Status         string `json:"status"`
		FailureMessage string `json:"failure_message"`
		TriggeredAt    string `json:"triggered_at"`
		HasAIReport    bool   `json:"has_ai_report"`
	}
	out := make([]row, 0, len(incs))
	for _, inc := range incs {
		out = append(out, row{
			ID:             inc.ID.String(),
			Cluster:        inc.ClusterName,
			Status:         inc.Status,
			FailureMessage: inc.FailureMessage,
			TriggeredAt:    inc.TriggeredAt.Format(time.RFC3339),
			HasAIReport:    len(inc.AIReport) > 0,
		})
	}
	return map[string]any{"count": len(out), "incidents": out}, nil
}

func toolPathPreview(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID  string `json:"cluster_id"`
		Path       string `json:"path"`
		MinAgeDays int    `json:"min_age_days"`
		Glob       string `json:"glob"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("decode args: %w", err)
	}
	if p.Path == "" {
		return nil, fmt.Errorf("path is required")
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, err
	}
	filerAddr, err := resolveFilerAddr(ctx, d, cl, "")
	if err != nil {
		return nil, fmt.Errorf("resolve filer: %w", err)
	}
	cleanPath := cleanFilerPath(p.Path)
	w := newPathWalker(filerAddr, cl, pathMigrateFilters{
		Path:       cleanPath,
		Recursive:  true,
		MinAgeDays: p.MinAgeDays,
		Glob:       p.Glob,
	})
	if werr := w.walk(ctx, cleanPath, 0); werr != nil && !w.truncated {
		return nil, fmt.Errorf("walk: %w", werr)
	}
	res := w.finalize()
	return map[string]any{
		"path":          cleanPath,
		"matched_files": res.MatchedFiles,
		"total_bytes":   res.TotalBytes,
		"truncated":     res.Truncated,
		"by_age":        res.ByAge,
		"by_collection": res.ByCollection,
	}, nil
}
