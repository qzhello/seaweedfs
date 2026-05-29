# 舰队批量健康探活(手动) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Check all" button on the clusters list page that fans out a concurrent server-side health probe across every cluster and shows a tiered green/yellow/red status (+ reasons) per cluster.

**Architecture:** New `POST /clusters/health-check` endpoint (cap `cluster.read`) fans out with errgroup (concurrency 8, per-cluster 8s deadline), gathering 4 best-effort signals per cluster (master reachability, raft quorum, filer reachability, replication health), each reusing existing helpers, and rolls them up to one status via a pure function. Frontend stores the one-shot result in local state (not SWR) and renders per-row health badges + a summary.

**Tech Stack:** Go (gin, errgroup, golang.org/x/sync), Next.js + React + TypeScript, SWR (existing list only), Tailwind.

---

## Build/Test Environment Note

Local Go is **1.25 via auto-toolchain** (`go build ./...`, `go test ./...`, `gofmt` all work). Always run `gofmt -l <file>` (must print nothing). If a toolchain error appears, fall back to gofmt + grep and note it.

Frontend: `npm run typecheck` has a PRE-EXISTING RED baseline in unrelated files (`lib/i18n.ts`, `app/costs/_panels/bucket-plan.tsx`, etc.). Acceptance = no NEW errors in the touched file: `cd web && npm run typecheck 2>&1 | grep "<file>"` shows nothing new.

All backend paths are relative to `seaweedfs-tiering-controller/`. Frontend paths relative to `seaweedfs-tiering-controller/web/`.

## Verified existing signatures (reuse these — do not reinvent)

- `(p *PG) ListClusters(ctx) ([]store.Cluster, error)` — `internal/store/clusters.go:40`. `store.Cluster` fields: `ID uuid.UUID`, `Name string`, `MasterAddr string`, `Enabled bool` (+ others).
- `(c *seaweed.Client) ProbeMaster(master string) error` — `internal/seaweed/preflight.go:66` (HTTP+gRPC reachability, ~3s cached; **not** ctx-aware).
- `(c *seaweed.Client) FetchMasterRaftServers(ctx, addr) ([]seaweed.MasterRaftServer, time.Duration, error)` — `client.go:234`. `MasterRaftServer{ Id, Address, GrpcAddress, Suffrage, IsLeader }`.
- `(c *seaweed.Client) ListFilers(ctx, masterAddr) ([]seaweed.FilerNode, error)` — `client.go:124`. `FilerNode{ Address, Version, ... }`.
- `probeFilerStatus(ctx, addr) (time.Duration, error)` — `internal/api/cluster_filers.go:158` (same `api` package).
- `computeReplicationHealth(ctx, d, cl) (replicationHealthResp, error)` — `internal/api/replication_health.go:70`. Fields used: `SoleCopies int`, `UnderReplicated int`, `OverReplicated int`, `ECPotentiallyShortShards int`.
- `auth.RequireCap(d.Caps, "cluster.read")`; route precedent for a static sibling of `:id`: `v1.GET("/clusters/score/history", ...)` already registers fine, so `v1.POST("/clusters/health-check", ...)` is safe in this gin version.
- Frontend: `useClusters()` SWR hook (`api.ts:822`), `api` object (`api.ts:1664`), `jpost(url, body)` helper. `HealthBadge({tone:"ok"|"warn"|"err", children, title})` (`components/health-badge.tsx`). Clusters page (`app/clusters/page.tsx`) uses `PageToolbar actions={...}`, `KpiStrip`, a `<table className="grid">` with a Status column, `confirm as confirmDlg`, `Loader2` likely available via lucide.

---

## File Structure

- **Create** `internal/api/cluster_health_check.go` — types (`healthSignal`, `clusterHealthResult`, `fleetHealthSummary`), pure `rollupClusterStatus`, `gatherClusterHealth`, handler `fleetHealthCheck`.
- **Create** `internal/api/cluster_health_check_test.go` — table-driven tests for `rollupClusterStatus`.
- **Modify** `internal/api/server.go` — register the route.
- **Modify** `web/lib/api.ts` — types + `api.fleetHealthCheck()`.
- **Modify** `web/app/clusters/page.tsx` — "Check all" button + per-row badge + summary.
- **Modify** `web/lib/i18n.ts` — zh keys.

---

## Task 1: Backend types + `rollupClusterStatus` pure function (TDD)

**Files:**
- Create: `internal/api/cluster_health_check.go`
- Create: `internal/api/cluster_health_check_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/api/cluster_health_check_test.go`:

```go
package api

import "testing"

func TestRollupClusterStatus(t *testing.T) {
	sig := func(status string) healthSignal { return healthSignal{Key: "x", Status: status} }
	cases := []struct {
		name string
		in   []healthSignal
		want string
	}{
		{name: "all ok -> green", in: []healthSignal{sig("ok"), sig("ok")}, want: "green"},
		{name: "empty -> green", in: nil, want: "green"},
		{name: "warn -> yellow", in: []healthSignal{sig("ok"), sig("warn")}, want: "yellow"},
		{name: "unknown -> yellow", in: []healthSignal{sig("ok"), sig("unknown")}, want: "yellow"},
		{name: "down -> red", in: []healthSignal{sig("ok"), sig("down")}, want: "red"},
		{name: "down beats warn -> red", in: []healthSignal{sig("warn"), sig("down")}, want: "red"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rollupClusterStatus(tc.in); got != tc.want {
				t.Fatalf("rollupClusterStatus(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/api/ -run TestRollupClusterStatus -v`
Expected: FAIL — `undefined: healthSignal` / `undefined: rollupClusterStatus`.

- [ ] **Step 3: Write the types + pure function**

Create `internal/api/cluster_health_check.go`:

```go
package api

// Fleet health check: a one-shot, manual probe across every cluster.
// Each cluster aggregates a few best-effort signals into a single
// green/yellow/red verdict so an operator can eyeball the whole fleet.

// healthSignal is one probed dimension of a cluster's health.
// Status: "ok" | "warn" | "down" | "unknown".
type healthSignal struct {
	Key    string `json:"key"`    // master | quorum | filers | replication
	Status string `json:"status"` // ok | warn | down | unknown
	Detail string `json:"detail,omitempty"`
}

// clusterHealthResult is the per-cluster verdict returned to the UI.
type clusterHealthResult struct {
	ClusterID string         `json:"cluster_id"`
	Name      string         `json:"name"`
	Enabled   bool           `json:"enabled"`
	Status    string         `json:"status"` // green | yellow | red | skipped
	Reachable bool           `json:"reachable"`
	LatencyMS int64          `json:"latency_ms"`
	Signals   []healthSignal `json:"signals"`
	Reasons   []string       `json:"reasons"`
}

type fleetHealthSummary struct {
	Green   int `json:"green"`
	Yellow  int `json:"yellow"`
	Red     int `json:"red"`
	Skipped int `json:"skipped"`
	Total   int `json:"total"`
}

type fleetHealthResponse struct {
	Results []clusterHealthResult `json:"results"`
	Summary fleetHealthSummary    `json:"summary"`
}

// rollupClusterStatus maps signal statuses to a cluster verdict:
// any "down" -> "red"; else any "warn"/"unknown" -> "yellow"; else "green".
func rollupClusterStatus(signals []healthSignal) string {
	worst := "green"
	for _, s := range signals {
		switch s.Status {
		case "down":
			return "red"
		case "warn", "unknown":
			worst = "yellow"
		}
	}
	return worst
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/api/ -run TestRollupClusterStatus -v`
Expected: PASS (all 6 cases).
Also: `gofmt -l internal/api/cluster_health_check.go internal/api/cluster_health_check_test.go` → no output.

- [ ] **Step 5: Commit**

```bash
git add internal/api/cluster_health_check.go internal/api/cluster_health_check_test.go
git commit -m "feat(api): fleet health types + rollupClusterStatus pure fn"
```

---

## Task 2: `gatherClusterHealth` + `fleetHealthCheck` handler + route

**Files:**
- Modify: `internal/api/cluster_health_check.go` (append)
- Modify: `internal/api/server.go` (route)

- [ ] **Step 1: Append the per-cluster gatherer**

Add to `internal/api/cluster_health_check.go`. Add imports at the top of the file (it currently has no import block — add one):

```go
import (
	"context"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)
```

```go
const (
	fleetHealthConcurrency = 8
	fleetHealthPerCluster  = 8 * time.Second
)

// gatherClusterHealth probes one cluster's signals best-effort and rolls
// them up. Never returns an error — every failure becomes a signal status
// so one bad cluster cannot fail the batch.
func gatherClusterHealth(ctx context.Context, d Deps, cl store.Cluster) clusterHealthResult {
	res := clusterHealthResult{
		ClusterID: cl.ID.String(),
		Name:      cl.Name,
		Enabled:   cl.Enabled,
	}
	if !cl.Enabled {
		res.Status = "skipped"
		return res
	}

	// 1. master reachability (ProbeMaster is not ctx-aware; it has its own
	//    internal dial timeout + ~3s cache).
	start := time.Now()
	mErr := d.Sw.ProbeMaster(cl.MasterAddr)
	res.LatencyMS = time.Since(start).Milliseconds()
	res.Reachable = mErr == nil
	if mErr != nil {
		res.Signals = []healthSignal{{Key: "master", Status: "down", Detail: mErr.Error()}}
		res.Status = "red"
		res.Reasons = []string{"master unreachable: " + mErr.Error()}
		return res
	}
	res.Signals = append(res.Signals, healthSignal{Key: "master", Status: "ok"})

	// 2-4. quorum / filers / replication in parallel, each best-effort.
	var quorum, filers, repl healthSignal
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { quorum = probeQuorum(gctx, d, cl); return nil })
	g.Go(func() error { filers = probeFilers(gctx, d, cl); return nil })
	g.Go(func() error { repl = probeReplication(gctx, d, cl); return nil })
	_ = g.Wait()
	res.Signals = append(res.Signals, quorum, filers, repl)

	res.Status = rollupClusterStatus(res.Signals)
	for _, s := range res.Signals {
		if s.Status != "ok" && s.Detail != "" {
			res.Reasons = append(res.Reasons, s.Key+": "+s.Detail)
		}
	}
	return res
}

// probeQuorum checks the master raft cluster has a leader and a voting majority.
func probeQuorum(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	servers, _, err := d.Sw.FetchMasterRaftServers(ctx, cl.MasterAddr)
	if err != nil {
		return healthSignal{Key: "quorum", Status: "unknown", Detail: err.Error()}
	}
	voters, votersUp := 0, 0
	leader := false
	for _, s := range servers {
		isVoter := s.Suffrage == "" || s.Suffrage == "Voter" || s.Suffrage == "voter"
		if isVoter {
			voters++
			votersUp++
		}
		if s.IsLeader {
			leader = true
		}
	}
	if !leader {
		return healthSignal{Key: "quorum", Status: "down", Detail: "no raft leader"}
	}
	if voters > 0 && votersUp <= voters/2 {
		return healthSignal{Key: "quorum", Status: "down", Detail: "lost voting majority"}
	}
	return healthSignal{Key: "quorum", Status: "ok"}
}

// probeFilers lists filers from the master and probes each /status in parallel.
func probeFilers(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	nodes, err := d.Sw.ListFilers(ctx, cl.MasterAddr)
	if err != nil {
		return healthSignal{Key: "filers", Status: "unknown", Detail: err.Error()}
	}
	if len(nodes) == 0 {
		return healthSignal{Key: "filers", Status: "unknown", Detail: "no filers registered"}
	}
	var g errgroup.Group
	down := make([]string, len(nodes))
	for i, n := range nodes {
		i, n := i, n
		g.Go(func() error {
			if _, perr := probeFilerStatus(ctx, n.Address); perr != nil {
				down[i] = n.Address
			}
			return nil
		})
	}
	_ = g.Wait()
	unreachable := make([]string, 0, len(down))
	for _, a := range down {
		if a != "" {
			unreachable = append(unreachable, a)
		}
	}
	if len(unreachable) > 0 {
		return healthSignal{Key: "filers", Status: "warn",
			Detail: fmt.Sprintf("%d/%d filer unreachable", len(unreachable), len(nodes))}
	}
	return healthSignal{Key: "filers", Status: "ok"}
}

// probeReplication summarizes replica/EC health (uses the topology cache).
func probeReplication(ctx context.Context, d Deps, cl store.Cluster) healthSignal {
	clp := cl
	rep, err := computeReplicationHealth(ctx, d, &clp)
	if err != nil {
		return healthSignal{Key: "replication", Status: "unknown", Detail: err.Error()}
	}
	problems := rep.SoleCopies + rep.UnderReplicated + rep.OverReplicated + rep.ECPotentiallyShortShards
	if problems > 0 {
		return healthSignal{Key: "replication", Status: "warn",
			Detail: fmt.Sprintf("sole=%d under=%d over=%d ec_short=%d",
				rep.SoleCopies, rep.UnderReplicated, rep.OverReplicated, rep.ECPotentiallyShortShards)}
	}
	return healthSignal{Key: "replication", Status: "ok"}
}
```

Note on `computeReplicationHealth` arg: it takes `*store.Cluster`. `ListClusters` returns `[]store.Cluster` (values), so `gatherClusterHealth` receives a value and passes `&clp` (a local copy's address) — safe.

- [ ] **Step 2: Append the handler**

```go
// fleetHealthCheck probes every cluster concurrently and returns a tiered
// health verdict per cluster. Read-only diagnostic (cap cluster.read); not
// gated by the safety Guard.
//
// POST /api/v1/clusters/health-check
func fleetHealthCheck(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusters, err := d.PG.ListClusters(c.Request.Context())
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		results := make([]clusterHealthResult, len(clusters))
		sem := make(chan struct{}, fleetHealthConcurrency)
		var g errgroup.Group
		for i, cl := range clusters {
			i, cl := i, cl
			g.Go(func() error {
				sem <- struct{}{}
				defer func() { <-sem }()
				cctx, cancel := context.WithTimeout(c.Request.Context(), fleetHealthPerCluster)
				defer cancel()
				results[i] = gatherClusterHealth(cctx, d, cl)
				return nil
			})
		}
		_ = g.Wait()

		var sum fleetHealthSummary
		sum.Total = len(results)
		for _, r := range results {
			switch r.Status {
			case "green":
				sum.Green++
			case "yellow":
				sum.Yellow++
			case "red":
				sum.Red++
			case "skipped":
				sum.Skipped++
			}
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "fleet.health-check", "fleet", "", map[string]any{
			"green": sum.Green, "yellow": sum.Yellow, "red": sum.Red, "skipped": sum.Skipped, "total": sum.Total,
		})
		c.JSON(200, fleetHealthResponse{Results: results, Summary: sum})
	}
}
```

Note: verify `d.PG.Audit` signature matches `(ctx, email, action, resourceType, resourceID string, ctx map[string]any) error` (it does elsewhere in this package, e.g. `cluster_raft_transfer.go`). `auth.Of(c)` returns `(principal, bool)` with `.Email`.

- [ ] **Step 3: Register the route in `server.go`**

In `internal/api/server.go`, near the other top-level `/clusters` routes (e.g. just after the `v1.GET("/clusters", listClusters(d))` registration, or beside `v1.GET("/clusters/score/history", ...)`), add:

```go
		// Manual fleet-wide health probe: fan out a tiered reachability +
		// quorum + filer + replication check across all clusters. Read-only.
		v1.POST("/clusters/health-check",
			auth.RequireCap(d.Caps, "cluster.read"), fleetHealthCheck(d))
```

(Static segment `health-check` is a sibling of `:id` — the existing `/clusters/score/history` route proves this gin version accepts it.)

- [ ] **Step 4: Build, vet, test, format**

Run:
```bash
go build ./... 2>&1 | head
go vet ./internal/api/ 2>&1 | head
go test ./internal/api/ -run TestRollupClusterStatus -v
gofmt -l internal/api/cluster_health_check.go internal/api/server.go
```
Expected: build clean; vet clean; test PASS; gofmt no output.
If `go build` surfaces a signature mismatch (e.g. `computeReplicationHealth` arg, `Audit` args, `ProbeMaster` is/ isn't ctx-aware, `FetchMasterRaftServers` return arity), fix to match the REAL signatures (they were verified in the plan header but confirm against the code) — keep the structure.

- [ ] **Step 5: Commit**

```bash
git add internal/api/cluster_health_check.go internal/api/server.go
git commit -m "feat(api): POST /clusters/health-check fleet probe (errgroup fan-out)"
```

---

## Task 3: Frontend API client — types + `fleetHealthCheck`

**Files:**
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add types**

In `web/lib/api.ts`, add near the other cluster types:

```ts
export interface FleetHealthSignal {
  key: string;        // master | quorum | filers | replication
  status: string;     // ok | warn | down | unknown
  detail?: string;
}

export interface FleetHealthResult {
  cluster_id: string;
  name: string;
  enabled: boolean;
  status: "green" | "yellow" | "red" | "skipped";
  reachable: boolean;
  latency_ms: number;
  signals: FleetHealthSignal[];
  reasons: string[];
}

export interface FleetHealthResponse {
  results: FleetHealthResult[];
  summary: { green: number; yellow: number; red: number; skipped: number; total: number };
}
```

- [ ] **Step 2: Add the API method**

In the `api` object, add:

```ts
  fleetHealthCheck: () =>
    jpost(`${BASE}/clusters/health-check`, {}) as Promise<FleetHealthResponse>,
```

- [ ] **Step 3: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep "lib/api.ts"   # expect no output
git add web/lib/api.ts
git commit -m "feat(web): FleetHealth types + api.fleetHealthCheck client"
```

---

## Task 4: Clusters page — "Check all" button + per-row badge + summary

**Files:**
- Modify: `web/app/clusters/page.tsx`

- [ ] **Step 1: Read the file**

Confirm: `useClusters()`, `items: ClusterRow[]`, `PageToolbar actions={<>…</>}`, `KpiStrip`, the `<table className="grid">` with `<thead>` columns (Name, Master, weed binary, Domain, Status, "") and `pg.slice.map(c => <tr key={c.id}>…)`. Confirm `Loader2` is importable from `lucide-react` (other pages import it). Confirm `HealthBadge` import path `@/components/health-badge`, and `api` is imported.

- [ ] **Step 2: Add imports + state + handler**

- Imports: add `Loader2, Activity` to the `lucide-react` import; add `import { HealthBadge } from "@/components/health-badge";`; add `type FleetHealthResult` to the `@/lib/api` import.
- Inside `ClustersPage`, after the existing `useState` lines, add:

```tsx
  const [health, setHealth] = useState<Record<string, FleetHealthResult> | null>(null);
  const [healthSummary, setHealthSummary] = useState<{ green: number; yellow: number; red: number; skipped: number; total: number } | null>(null);
  const [checking, setChecking] = useState(false);

  async function runFleetCheck() {
    setChecking(true);
    try {
      const res = await api.fleetHealthCheck();
      const byId: Record<string, FleetHealthResult> = {};
      for (const r of res.results) byId[r.cluster_id] = r;
      setHealth(byId);
      setHealthSummary(res.summary);
    } catch (e) {
      // Surface inline; do not crash the page.
      setHealthSummary(null);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  const healthTone = (status: string): "ok" | "warn" | "err" =>
    status === "green" ? "ok" : status === "red" ? "err" : "warn";
```

- [ ] **Step 3: Add the "Check all" button to the toolbar**

In the `PageToolbar actions={<>…</>}`, add (before or after the existing New cluster button):

```tsx
            <button className="btn flex items-center gap-1.5" onClick={runFleetCheck} disabled={checking}>
              {checking ? <Loader2 size={14} className="animate-spin"/> : <Activity size={14}/>}
              {t("Check all")}
            </button>
```

- [ ] **Step 4: Add the summary line (when a check has run)**

Immediately after the `KpiStrip` (or just above the `<section className="card">`), add:

```tsx
      {healthSummary && (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <HealthBadge tone="ok">{healthSummary.green} {t("healthy")}</HealthBadge>
          {healthSummary.yellow > 0 && <HealthBadge tone="warn">{healthSummary.yellow} {t("warning")}</HealthBadge>}
          {healthSummary.red > 0 && <HealthBadge tone="err">{healthSummary.red} {t("down")}</HealthBadge>}
          {healthSummary.skipped > 0 && <span className="text-muted">{healthSummary.skipped} {t("skipped")}</span>}
        </div>
      )}
```

- [ ] **Step 5: Add a Health column to the table**

- In `<thead><tr>`, add a header cell before the trailing empty `<th></th>`:
```tsx
                <th>{t("Health")}</th>
```
- In the row `<tr>`, add a cell before the actions `<td>`. It shows the badge when a result exists, with reasons in the `title` tooltip; "—" otherwise:
```tsx
                    <td>
                      {health?.[c.id] ? (
                        <HealthBadge
                          tone={healthTone(health[c.id].status)}
                          title={health[c.id].reasons.length ? health[c.id].reasons.join("\n") : t("All signals OK")}
                        >
                          {health[c.id].status === "skipped" ? t("skipped") : health[c.id].status}
                        </HealthBadge>
                      ) : (
                        <span className="text-muted/60">—</span>
                      )}
                    </td>
```
- Update the `TableSkeleton` headers array (the `loadingFirst` branch) to include the new column so column counts stay aligned: add `t("Health")` before the trailing `""`:
```tsx
          <TableSkeleton rows={5} headers={[t("Name"), t("Master"), t("weed binary"), t("Domain"), t("Status"), t("Health"), ""]}/>
```

- [ ] **Step 6: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep "clusters/page.tsx"   # expect no output
git add "web/app/clusters/page.tsx"
git commit -m "feat(web): fleet Check-all button + per-row health badge + summary"
```

---

## Task 5: i18n keys

**Files:**
- Modify: `web/lib/i18n.ts`

- [ ] **Step 1: Add zh keys (skip any that already exist)**

For each key below, first `grep -Fc '"<key>":' web/lib/i18n.ts` — add only if it returns 0 (avoid duplicate-key TS1117). Add the new ones to the zh map matching existing syntax:

```
"Check all": "检查全部",
"healthy": "健康",
"warning": "警告",
"down": "异常",
"skipped": "跳过",
"All signals OK": "所有信号正常",
```

Note: `"Health"` and `"down"` may already exist — grep first; if present, do not re-add.

- [ ] **Step 2: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep "lib/i18n.ts"   # no NEW errors; your keys each appear once
git add web/lib/i18n.ts
git commit -m "feat(web): zh i18n keys for fleet health check"
```

---

## Final Verification (after all tasks)

- [ ] `go build ./... && go test ./internal/api/ -run TestRollupClusterStatus -v` — build clean, test PASS.
- [ ] `cd web && npm run typecheck 2>&1 | grep -E "api.ts|clusters/page.tsx|i18n.ts"` — no NEW errors; `npm run build` succeeds.
- [ ] **Manual smoke:** clusters list page → click "Check all" → button spins → per-row badges fill (green/yellow/red/skipped), summary line shows counts; hover a non-green badge → reasons tooltip; a disabled cluster shows "skipped" and is excluded from green/yellow/red counts; an unreachable master shows red with "master unreachable: …". Without `cluster.read` cap the button request 403s (acceptable; optionally hide the button if the page already has a caps context).
- [ ] Dispatch a final whole-feature code reviewer; then use superpowers:finishing-a-development-branch.
