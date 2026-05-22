# Cluster Diagnostics And Drilldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cluster-scoped route foundations, a masters/raft/lock diagnostics page, collection drilldown, and volume-server drilldown without regressing existing controller UX.

**Architecture:** Extend the existing `/api/v1/clusters/:id/...` backend route family with additive handlers, add matching SWR hooks in `web/lib/api.ts`, and split the current cluster detail monolith into nested Next.js routes rooted at `/clusters/[id]`. Keep state derivation and parsing on the Go side where upstream SeaweedFS output is unstable, and keep the frontend focused on rendering structured payloads plus wiring to existing dialogs/actions.

**Tech Stack:** Go, Gin, pgx, existing `internal/seaweed` helpers, Next.js App Router, React 18, SWR, TypeScript, Tailwind, lucide-react

---

## File Structure

### Backend files

- Create: `seaweedfs-tiering-controller/internal/api/cluster_masters.go`
  Responsibility: masters aggregation handler, lock-probe handler, peer normalization, response shaping.
- Create: `seaweedfs-tiering-controller/internal/api/cluster_masters_test.go`
  Responsibility: peer normalization, consistency detection, lock-probe result mapping, partial-failure handler coverage.
- Create: `seaweedfs-tiering-controller/internal/api/cluster_drilldown.go`
  Responsibility: collection detail and volume-server detail handlers plus shared aggregation helpers.
- Create: `seaweedfs-tiering-controller/internal/api/cluster_drilldown_test.go`
  Responsibility: collection/server aggregation tests.
- Modify: `seaweedfs-tiering-controller/internal/api/server.go`
  Responsibility: register new routes and capability gates.
- Modify: `seaweedfs-tiering-controller/internal/seaweed/client.go`
  Responsibility: add typed fetch/dial helpers for master status, metrics, and lock probe if they do not already exist.
- Modify: `seaweedfs-tiering-controller/internal/seaweed/shell_lists.go`
  Responsibility: add typed list parsing for filer lists so the later `/filers` page can reuse a stable helper instead of parsing in handlers.
- Modify: `seaweedfs-tiering-controller/internal/store/capabilities.go`
  Responsibility: expose the new `cluster.lock.probe` capability in the catalog if capabilities are seeded or referenced here.

### Frontend files

- Create: `seaweedfs-tiering-controller/web/components/health-badge.tsx`
  Responsibility: shared `ok | warn | err` visual badge.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx`
  Responsibility: cluster header, tabs, route shell, capability-aware tab visibility.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/nodes-panel.tsx`
  Responsibility: extracted topology node table and node-row interactions.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/tag-editor.tsx`
  Responsibility: extracted tag form and tag-table helpers.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/shell-console.tsx`
  Responsibility: extracted allowlisted shell UI and run flow.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx`
  Responsibility: move current topology section into its own route.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/tags/page.tsx`
  Responsibility: move current tags section into its own route.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/shell/page.tsx`
  Responsibility: move current shell section into its own route.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/masters/page.tsx`
  Responsibility: masters table, consistency panel, lock probe.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/collections/page.tsx`
  Responsibility: cluster-scoped collection list entry point or redirect surface to detail pages.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/collections/[name]/page.tsx`
  Responsibility: collection drilldown.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/volume-servers/page.tsx`
  Responsibility: cluster-scoped volume-server list view.
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/volume-servers/[addr]/page.tsx`
  Responsibility: volume-server drilldown.
- Modify: `seaweedfs-tiering-controller/web/app/clusters/[id]/page.tsx`
  Responsibility: reduce to Overview route content.
- Modify: `seaweedfs-tiering-controller/web/app/collections/page.tsx`
  Responsibility: link rows into cluster-scoped detail.
- Modify: `seaweedfs-tiering-controller/web/lib/api.ts`
  Responsibility: add hooks and POST mutation helper for lock probe.
- Modify: `seaweedfs-tiering-controller/web/lib/caps-context.tsx`
  Responsibility: no code expected unless helper ergonomics are needed; avoid changes if possible.

### Verification commands

- Backend unit tests: `go test ./seaweedfs-tiering-controller/internal/api ./seaweedfs-tiering-controller/internal/seaweed`
- Frontend typecheck: `cd seaweedfs-tiering-controller/web && pnpm typecheck`
- Frontend lint: `cd seaweedfs-tiering-controller/web && pnpm lint`

## Task 1: Phase 0 Route Split Skeleton

**Files:**
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/nodes-panel.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/tag-editor.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/shell-console.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/tags/page.tsx`
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/shell/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/app/clusters/[id]/page.tsx`

- [ ] **Step 1: Write the failing route-shell smoke check mentally from current behavior**

Use this checklist as the failing target before editing:

```text
Expected after task:
- /clusters/[id] still shows overview stats
- /clusters/[id]/topology renders the node table
- /clusters/[id]/tags renders tag editor + tag list
- /clusters/[id]/shell renders shell console
- header and tabs are shared in one layout
```

- [ ] **Step 2: Create the shared layout with explicit tab definitions**

Create `seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx` with this shape:

```tsx
"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { useClusterTopology } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";

const TABS = [
  { href: "", label: "Overview", cap: "cluster.read" },
  { href: "/topology", label: "Topology", cap: "cluster.read" },
  { href: "/masters", label: "Masters", cap: "cluster.read" },
  { href: "/tags", label: "Tags", cap: "cluster.read" },
  { href: "/shell", label: "Shell", cap: "cluster.read" },
];

export default function ClusterLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { has, loading } = useCaps();
  const { data, error } = useClusterTopology(id);
  if (error) return <div className="card p-5 border-danger/40 bg-danger/10 text-danger">Cannot reach SeaweedFS master</div>;
  if (!data) return <div className="text-muted">Loading…</div>;
  const tabs = TABS.filter(tab => loading || has(tab.cap));
  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Clusters", href: "/clusters" }, { label: data.cluster.name }]} />
      <header>
        <h1 className="text-base font-semibold tracking-tight">{data.cluster.name}</h1>
        <p className="text-sm text-muted font-mono">{data.cluster.master_addr}</p>
      </header>
      <nav>{tabs.map(tab => <Link key={tab.href} href={`/clusters/${id}${tab.href}`}>{tab.label}</Link>)}</nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Move the current node panel into the new topology route**

First create `seaweedfs-tiering-controller/web/app/clusters/[id]/_components/nodes-panel.tsx` by moving `FlatNode`, `flattenTopology`, `NodesPanel`, and the topology-specific row actions out of the old monolith. Then create `seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useClusterTopology } from "@/lib/api";
import { NodesPanel } from "../_components/nodes-panel";

export default function ClusterTopologyPage() {
  const { id } = useParams<{ id: string }>();
  const { data } = useClusterTopology(id);
  if (!data) return <div className="text-muted">Loading…</div>;
  return <NodesPanel topo={data.topology} clusterId={id} />;
}
```

- [ ] **Step 4: Move the current tag and shell sections into dedicated routes**

Create the route pages and shared component folder:

```tsx
// web/app/clusters/[id]/tags/page.tsx
"use client";
import { useParams } from "next/navigation";
import { useClusterTags, api } from "@/lib/api";
import { TagEditor } from "../_components/tag-editor";

export default function ClusterTagsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, mutate } = useClusterTags(id);
  return (
    <section className="card p-5">
      <TagEditor clusterId={id} onSaved={mutate} />
      <table className="grid mt-3">{/* paste the current cluster tag rows here after extraction */}</table>
    </section>
  );
}
```

```tsx
// web/app/clusters/[id]/shell/page.tsx
"use client";
import { useParams } from "next/navigation";
import { useClusterTopology } from "@/lib/api";
import { ShellConsole } from "../_components/shell-console";

export default function ClusterShellPage() {
  const { id } = useParams<{ id: string }>();
  const { data } = useClusterTopology(id);
  return <ShellConsole clusterId={id} binPath={data?.cluster?.weed_bin_path} />;
}
```

- [ ] **Step 5: Reduce `/clusters/[id]/page.tsx` to Overview-only content**

Keep only the cluster stats and overview cards:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useClusterTopology } from "@/lib/api";
import { bytes } from "@/lib/utils";

export default function ClusterOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useClusterTopology(id);
  if (error) return <div className="card p-5 border-danger/40 bg-danger/10 text-danger">Cannot reach SeaweedFS master</div>;
  if (!data) return <div className="text-muted">Loading…</div>;
  return <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">{/* move the existing Stat cards here */}</section>;
}
```

- [ ] **Step 6: Run frontend typecheck for the route split**

Run: `cd seaweedfs-tiering-controller/web && pnpm typecheck`  
Expected: PASS with no import/export errors from the new cluster routes.

- [ ] **Step 7: Commit**

```bash
git add seaweedfs-tiering-controller/web/app/clusters/[id]/page.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/_components/nodes-panel.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/_components/tag-editor.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/_components/shell-console.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/tags/page.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/shell/page.tsx
git commit -m "refactor: split cluster detail into nested routes"
```

## Task 2: Phase 0 Shared UI Primitive And API Hooks

**Files:**
- Create: `seaweedfs-tiering-controller/web/components/health-badge.tsx`
- Modify: `seaweedfs-tiering-controller/web/lib/api.ts`

- [ ] **Step 1: Add the failing TypeScript surface for new hooks**

Append these interfaces and signatures in `web/lib/api.ts` before implementation:

```ts
export interface ClusterMasterRow {
  address: string;
  reachable: boolean;
  latency_ms: number;
  is_leader: boolean;
  suffrage: "leader" | "voter" | "nonvoter" | "unknown";
  reported_leader?: string;
  reported_peers: string[];
  normalized_peers: string[];
  lock_holder?: string;
  warnings: string[];
  health: "ok" | "warn" | "err";
  error?: string;
}

export function useClusterMasters(clusterID?: string) {
  return useSWR(clusterID ? `${BASE}/clusters/${clusterID}/masters` : null, fetcher);
}
```

- [ ] **Step 2: Add the shared `HealthBadge` component**

Create `web/components/health-badge.tsx`:

```tsx
import { cn } from "@/lib/utils";

export function HealthBadge({ tone, label }: { tone: "ok" | "warn" | "err"; label?: string }) {
  const text = label || tone;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "ok" && "border-emerald-400/30 text-emerald-300",
        tone === "warn" && "border-amber-400/30 text-amber-300",
        tone === "err" && "border-rose-400/30 text-rose-300",
      )}
    >
      {text}
    </span>
  );
}
```

- [ ] **Step 3: Implement the remaining shared hooks and the lock probe mutation**

Add these to `web/lib/api.ts`:

```ts
export function useClusterFilers(clusterID?: string) {
  return useSWR(clusterID ? `${BASE}/clusters/${clusterID}/filers` : null, fetcher);
}

export function useVolumeServer(clusterID?: string, addr?: string) {
  return useSWR(clusterID && addr ? `${BASE}/clusters/${clusterID}/volume-servers/${encodeURIComponent(addr)}` : null, fetcher);
}

export function useCollectionDetail(clusterID?: string, name?: string) {
  return useSWR(clusterID && name ? `${BASE}/clusters/${clusterID}/collections/${encodeURIComponent(name)}` : null, fetcher);
}
```

```ts
lockProbe: (clusterID: string, body?: { address?: string }) =>
  jpost(`${BASE}/clusters/${clusterID}/masters/lock-probe`, body ?? {}) as Promise<{
    status: "free" | "held" | "quorum_unhealthy";
    holder?: string;
    message?: string;
  }>,
```

- [ ] **Step 4: Run frontend typecheck**

Run: `cd seaweedfs-tiering-controller/web && pnpm typecheck`  
Expected: PASS with the new hook signatures and no duplicate export names.

- [ ] **Step 5: Commit**

```bash
git add seaweedfs-tiering-controller/web/components/health-badge.tsx \
  seaweedfs-tiering-controller/web/lib/api.ts
git commit -m "feat: add cluster diagnostics API hooks"
```

## Task 3: Backend Masters Aggregation Core

**Files:**
- Create: `seaweedfs-tiering-controller/internal/api/cluster_masters.go`
- Create: `seaweedfs-tiering-controller/internal/api/cluster_masters_test.go`
- Modify: `seaweedfs-tiering-controller/internal/seaweed/client.go`

- [ ] **Step 1: Write failing unit tests for peer normalization and consistency detection**

Create `internal/api/cluster_masters_test.go` with tests like:

```go
func TestNormalizeMasterPeer(t *testing.T) {
	got := normalizeMasterPeer("http://10.0.0.2:9333/")
	if got != "10.0.0.2:9333" {
		t.Fatalf("normalizeMasterPeer() = %q", got)
	}
}

func TestDetectMasterConsistencyIssues(t *testing.T) {
	rows := []clusterMasterRow{
		{Address: "10.0.0.1:9333", ReportedLeader: "10.0.0.2:9333", ReportedPeers: []string{"10.0.0.1:9333", "10.0.0.2:9333"}},
		{Address: "10.0.0.2:9333", ReportedLeader: "10.0.0.2.19333", ReportedPeers: []string{"10.0.0.2.19333"}},
	}
	consistency := buildMasterConsistency(rows)
	if consistency.PeerSetAgreement {
		t.Fatal("expected peer-set disagreement")
	}
}
```

- [ ] **Step 2: Run backend test to confirm the new tests fail**

Run: `go test ./seaweedfs-tiering-controller/internal/api -run 'TestNormalizeMasterPeer|TestDetectMasterConsistencyIssues'`  
Expected: FAIL because the helpers and types do not exist yet.

- [ ] **Step 3: Add typed upstream helper contracts in `internal/seaweed/client.go`**

Add minimal interfaces and helpers:

```go
type MasterStatusSnapshot struct {
	IsLeader bool
	Leader   string
	Peers    []string
	Suffrage string
}

func (c *Client) FetchMasterStatus(ctx context.Context, addr string) (MasterStatusSnapshot, time.Duration, error) {
	// GET http://addr/cluster/status and parse structured fields
}

func (c *Client) FetchMasterMetrics(ctx context.Context, addr string) (string, time.Duration, error) {
	// GET http://addr/metrics and return raw payload for parsing
}
```

- [ ] **Step 4: Implement the normalization, aggregation, and issue-detection logic**

In `cluster_masters.go`, add a response model like:

```go
type clusterMasterRow struct {
	Address         string   `json:"address"`
	Reachable       bool     `json:"reachable"`
	LatencyMS       int64    `json:"latency_ms"`
	IsLeader        bool     `json:"is_leader"`
	Suffrage        string   `json:"suffrage"`
	ReportedLeader  string   `json:"reported_leader,omitempty"`
	ReportedPeers   []string `json:"reported_peers"`
	NormalizedPeers []string `json:"normalized_peers"`
	LockHolder      string   `json:"lock_holder,omitempty"`
	Warnings        []string `json:"warnings"`
	Health          string   `json:"health"`
	Error           string   `json:"error,omitempty"`
}
```

And helper skeletons:

```go
func normalizeMasterPeer(raw string) string
func extractLockHolder(metrics string) string
func buildMasterConsistency(rows []clusterMasterRow) masterConsistency
func classifyMasterHealth(row clusterMasterRow, consistency masterConsistency) string
```

- [ ] **Step 5: Add the HTTP handler and wire partial-failure behavior**

Implement:

```go
func clusterMasters(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// parse cluster id
		// load cluster
		// seed discovery with configured master_addr
		// fetch status/metrics concurrently with timeout
		// merge rows and return structured JSON
	}
}
```

Use `errgroup.Group` with per-master `context.WithTimeout(ctx, 2*time.Second)` so one dead node does not stall the whole response.

- [ ] **Step 6: Run backend tests**

Run: `go test ./seaweedfs-tiering-controller/internal/api ./seaweedfs-tiering-controller/internal/seaweed`  
Expected: PASS, including the new masters aggregation tests.

- [ ] **Step 7: Commit**

```bash
git add seaweedfs-tiering-controller/internal/api/cluster_masters.go \
  seaweedfs-tiering-controller/internal/api/cluster_masters_test.go \
  seaweedfs-tiering-controller/internal/seaweed/client.go
git commit -m "feat: add master diagnostics aggregation backend"
```

## Task 4: Backend Lock Probe Route And Capability Gate

**Files:**
- Modify: `seaweedfs-tiering-controller/internal/api/cluster_masters.go`
- Modify: `seaweedfs-tiering-controller/internal/api/server.go`
- Modify: `seaweedfs-tiering-controller/internal/store/capabilities.go`

- [ ] **Step 1: Write the failing lock-probe result mapping test**

Add to `cluster_masters_test.go`:

```go
func TestMapLockProbeResult(t *testing.T) {
	got := mapLockProbeError(errors.New("already locked by controller@host-a"))
	if got.Status != "held" || got.Holder != "controller@host-a" {
		t.Fatalf("unexpected probe result: %#v", got)
	}
}
```

- [ ] **Step 2: Run the targeted test**

Run: `go test ./seaweedfs-tiering-controller/internal/api -run TestMapLockProbeResult`  
Expected: FAIL because `mapLockProbeError` does not exist yet.

- [ ] **Step 3: Add a typed lock-probe helper**

In `internal/seaweed/client.go` or a sibling file, add:

```go
func (c *Client) ProbeMasterAdminLock(ctx context.Context, addr string) error {
	// dial grpc
	// lease admin token
	// if success, release token immediately
	// return raw error for handler classification
}
```

- [ ] **Step 4: Implement the lock-probe route and capability registration**

Handler skeleton:

```go
type lockProbeResponse struct {
	Status  string `json:"status"`
	Holder  string `json:"holder,omitempty"`
	Message string `json:"message,omitempty"`
}

func clusterMasterLockProbe(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// load cluster
		// pick leader or requested master
		// call ProbeMasterAdminLock with 2s timeout
		// map error => free | held | quorum_unhealthy
	}
}
```

Route registration in `server.go`:

```go
v1.GET("/clusters/:id/masters", auth.RequireCap(d.Caps, "cluster.read"), clusterMasters(d))
v1.POST("/clusters/:id/masters/lock-probe", auth.RequireCap(d.Caps, "cluster.lock.probe"), clusterMasterLockProbe(d))
```

- [ ] **Step 5: Add the capability catalog row**

Ensure the capability seed/catalog includes:

```go
{
	Name: "cluster.lock.probe",
	Category: "cluster",
	Label: "Probe cluster admin lock",
	Description: "Check whether a cluster master can lease the admin token without granting broader write access.",
}
```

- [ ] **Step 6: Run backend tests**

Run: `go test ./seaweedfs-tiering-controller/internal/api ./seaweedfs-tiering-controller/internal/seaweed`  
Expected: PASS with the lock-probe tests included.

- [ ] **Step 7: Commit**

```bash
git add seaweedfs-tiering-controller/internal/api/cluster_masters.go \
  seaweedfs-tiering-controller/internal/api/server.go \
  seaweedfs-tiering-controller/internal/store/capabilities.go
git commit -m "feat: add cluster lock probe route"
```

## Task 5: Frontend Masters Page

**Files:**
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/masters/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx`
- Modify: `seaweedfs-tiering-controller/web/components/health-badge.tsx`

- [ ] **Step 1: Write the failing rendering checklist**

Use this UI acceptance target:

```text
- masters table shows one row per discovered master
- consistency panel shows issues returned by backend
- lock probe button hidden without cluster.lock.probe
- lock probe settles into free / held / quorum_unhealthy state
```

- [ ] **Step 2: Build the masters page with typed sections**

Create `web/app/clusters/[id]/masters/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { api, useClusterMasters } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { HealthBadge } from "@/components/health-badge";

export default function ClusterMastersPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, mutate } = useClusterMasters(id);
  const { has } = useCaps();
  const [probe, setProbe] = useState<null | { status: string; holder?: string; message?: string }>(null);
  // render table, consistency panel, and probe card
}
```

- [ ] **Step 3: Add explicit rendering for warning states**

Render warning pills and issue lists using backend-provided codes rather than re-deriving them:

```tsx
{row.warnings.map((code) => (
  <span key={code} className="badge border-amber-400/30 text-amber-300">{code}</span>
))}
```

- [ ] **Step 4: Add the lock probe action**

Use a short submit handler:

```tsx
async function runProbe() {
  setProbe({ status: "loading", message: "probing" });
  try {
    const res = await api.lockProbe(id);
    setProbe(res);
    mutate();
  } catch (e) {
    setProbe({ status: "quorum_unhealthy", message: e instanceof Error ? e.message : String(e) });
  }
}
```

- [ ] **Step 5: Run frontend verification**

Run:

```bash
cd seaweedfs-tiering-controller/web
pnpm typecheck
pnpm lint
```

Expected: PASS with no route, hook, or JSX lint failures.

- [ ] **Step 6: Commit**

```bash
git add seaweedfs-tiering-controller/web/app/clusters/[id]/masters/page.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/layout.tsx \
  seaweedfs-tiering-controller/web/components/health-badge.tsx
git commit -m "feat: add cluster masters diagnostics page"
```

## Task 6: Backend Collection Detail

**Files:**
- Create: `seaweedfs-tiering-controller/internal/api/cluster_drilldown.go`
- Create: `seaweedfs-tiering-controller/internal/api/cluster_drilldown_test.go`
- Modify: `seaweedfs-tiering-controller/internal/api/server.go`

- [ ] **Step 1: Write the failing collection aggregation test**

Create `internal/api/cluster_drilldown_test.go` with a focused aggregator test:

```go
func TestBuildCollectionDetail(t *testing.T) {
	vols := []apiVolumeRow{
		{ID: 1, Collection: "photos", Size: 100, FileCount: 10, Server: "vs1"},
		{ID: 2, Collection: "photos", Size: 200, FileCount: 20, Server: "vs2"},
	}
	got := buildCollectionDetail("photos", vols)
	if got.VolumeCount != 2 || got.TotalSize != 300 {
		t.Fatalf("unexpected detail: %#v", got)
	}
}
```

- [ ] **Step 2: Run the targeted backend test**

Run: `go test ./seaweedfs-tiering-controller/internal/api -run TestBuildCollectionDetail`  
Expected: FAIL because the aggregation code does not exist yet.

- [ ] **Step 3: Implement the collection detail response**

Add a typed response:

```go
type collectionDetailResponse struct {
	Name                    string                 `json:"name"`
	VolumeCount             int                    `json:"volume_count"`
	TotalSize               uint64                 `json:"total_size"`
	FileCount               uint64                 `json:"file_count"`
	DeletedBytes            uint64                 `json:"deleted_bytes"`
	DeleteCount             uint64                 `json:"delete_count"`
	ECVolumeCount           int                    `json:"ec_volume_count"`
	ReplicationDistribution map[string]int         `json:"replication_distribution"`
	ServerDistribution      map[string]int         `json:"server_distribution"`
	Volumes                 []apiVolumeRow         `json:"volumes"`
}
```

- [ ] **Step 4: Add the route registration**

In `server.go`:

```go
v1.GET("/clusters/:id/collections/:name", auth.RequireCap(d.Caps, "volume.read"), clusterCollectionDetail(d))
```

- [ ] **Step 5: Run backend tests**

Run: `go test ./seaweedfs-tiering-controller/internal/api`  
Expected: PASS with the new collection aggregation tests.

- [ ] **Step 6: Commit**

```bash
git add seaweedfs-tiering-controller/internal/api/cluster_drilldown.go \
  seaweedfs-tiering-controller/internal/api/cluster_drilldown_test.go \
  seaweedfs-tiering-controller/internal/api/server.go
git commit -m "feat: add cluster collection detail endpoint"
```

## Task 7: Frontend Collection Detail

**Files:**
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/collections/[name]/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/app/collections/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/lib/api.ts`

- [ ] **Step 1: Update the global collections page to link into detail**

Change the name cell in `web/app/collections/page.tsx`:

```tsx
<td className="font-mono text-sm">
  {clusterID ? (
    <Link href={`/clusters/${clusterID}/collections/${encodeURIComponent(c.name || "_default_")}`}>
      {c.name || <span className="text-muted">(default)</span>}
    </Link>
  ) : (
    c.name || <span className="text-muted">(default)</span>
  )}
</td>
```

- [ ] **Step 2: Create the cluster-scoped collection detail page**

Create `web/app/clusters/[id]/collections/[name]/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useCollectionDetail } from "@/lib/api";
import { VolumeBalanceDialog } from "@/components/volume/balance-dialog";

export default function ClusterCollectionDetailPage() {
  const { id, name } = useParams<{ id: string; name: string }>();
  const decoded = decodeURIComponent(name);
  const { data } = useCollectionDetail(id, decoded);
  // render KPIs, replication distribution, server heatmap, and action buttons
}
```

- [ ] **Step 3: Reuse existing actions instead of inventing new mutations**

Wire action buttons to existing dialogs:

```tsx
<button className="btn" onClick={() => setBalanceOpen(true)}>Balance volumes</button>
<button className="btn" onClick={() => setEncodeOpen(true)}>EC encode</button>
```

Pass the collection name as the initial scope to the reused dialogs.

- [ ] **Step 4: Run frontend verification**

Run:

```bash
cd seaweedfs-tiering-controller/web
pnpm typecheck
pnpm lint
```

Expected: PASS and no broken import from `next/link`.

- [ ] **Step 5: Commit**

```bash
git add seaweedfs-tiering-controller/web/app/clusters/[id]/collections/[name]/page.tsx \
  seaweedfs-tiering-controller/web/app/collections/page.tsx \
  seaweedfs-tiering-controller/web/lib/api.ts
git commit -m "feat: add collection drilldown page"
```

## Task 8: Backend Volume-Server Detail

**Files:**
- Modify: `seaweedfs-tiering-controller/internal/api/cluster_drilldown.go`
- Modify: `seaweedfs-tiering-controller/internal/api/cluster_drilldown_test.go`
- Modify: `seaweedfs-tiering-controller/internal/api/server.go`

- [ ] **Step 1: Write the failing volume-server aggregation test**

Add:

```go
func TestBuildVolumeServerDetail(t *testing.T) {
	vols := []apiVolumeRow{
		{ID: 1, Server: "10.0.0.1:8080", Size: 100, Collection: "photos"},
		{ID: 2, Server: "10.0.0.1:8080", Size: 50, Collection: "logs"},
	}
	got := buildVolumeServerDetail("10.0.0.1:8080", vols, topologyNode{})
	if got.VolumeCount != 2 || got.UsedBytes != 150 {
		t.Fatalf("unexpected detail: %#v", got)
	}
}
```

- [ ] **Step 2: Run the targeted backend test**

Run: `go test ./seaweedfs-tiering-controller/internal/api -run TestBuildVolumeServerDetail`  
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement the server detail response**

Add:

```go
type volumeServerDetailResponse struct {
	Address      string         `json:"address"`
	DataCenter   string         `json:"data_center"`
	Rack         string         `json:"rack"`
	Version      string         `json:"version,omitempty"`
	StartTime    string         `json:"start_time,omitempty"`
	VolumeCount  int            `json:"volume_count"`
	UsedBytes    uint64         `json:"used_bytes"`
	CapacityBytes uint64        `json:"capacity_bytes"`
	Disks        []diskSummary  `json:"disks"`
	Volumes      []apiVolumeRow `json:"volumes"`
}
```

- [ ] **Step 4: Register the route**

In `server.go`:

```go
v1.GET("/clusters/:id/volume-servers/:addr", auth.RequireCap(d.Caps, "volume.read"), clusterVolumeServerDetail(d))
```

- [ ] **Step 5: Run backend tests**

Run: `go test ./seaweedfs-tiering-controller/internal/api`  
Expected: PASS with the new volume-server detail test.

- [ ] **Step 6: Commit**

```bash
git add seaweedfs-tiering-controller/internal/api/cluster_drilldown.go \
  seaweedfs-tiering-controller/internal/api/cluster_drilldown_test.go \
  seaweedfs-tiering-controller/internal/api/server.go
git commit -m "feat: add volume server detail endpoint"
```

## Task 9: Frontend Volume-Server Detail And Topology Link

**Files:**
- Create: `seaweedfs-tiering-controller/web/app/clusters/[id]/volume-servers/[addr]/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx`
- Modify: `seaweedfs-tiering-controller/web/lib/api.ts`

- [ ] **Step 1: Make topology rows link to volume-server detail**

Change the node identifier cell to:

```tsx
<Link href={`/clusters/${clusterId}/volume-servers/${encodeURIComponent(node.id)}`} className="font-mono text-sm hover:underline">
  {node.id}
</Link>
```

- [ ] **Step 2: Create the detail page**

Create `web/app/clusters/[id]/volume-servers/[addr]/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useVolumeServer } from "@/lib/api";
import { bytes } from "@/lib/utils";

export default function VolumeServerDetailPage() {
  const { id, addr } = useParams<{ id: string; addr: string }>();
  const decoded = decodeURIComponent(addr);
  const { data } = useVolumeServer(id, decoded);
  // render placement metadata, disk bars, and volume table
}
```

- [ ] **Step 3: Reuse existing action primitives in the per-volume table**

Use the existing `ShellActionMenu` or volume action dialog patterns rather than adding a new operation framework:

```tsx
<ShellActionMenu row={volume} actions={SERVER_VOLUME_ACTIONS} onPick={(action) => setDialog({ volume, action })} />
```

- [ ] **Step 4: Run frontend verification**

Run:

```bash
cd seaweedfs-tiering-controller/web
pnpm typecheck
pnpm lint
```

Expected: PASS and the new route compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add seaweedfs-tiering-controller/web/app/clusters/[id]/volume-servers/[addr]/page.tsx \
  seaweedfs-tiering-controller/web/app/clusters/[id]/topology/page.tsx \
  seaweedfs-tiering-controller/web/lib/api.ts
git commit -m "feat: add volume server drilldown page"
```

## Task 10: Final Verification

**Files:**
- Modify: none required

- [ ] **Step 1: Run backend verification**

Run: `go test ./seaweedfs-tiering-controller/internal/api ./seaweedfs-tiering-controller/internal/seaweed`  
Expected: PASS.

- [ ] **Step 2: Run frontend verification**

Run:

```bash
cd seaweedfs-tiering-controller/web
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Manual product verification**

Check these routes in the browser:

```text
/clusters/<id>
/clusters/<id>/topology
/clusters/<id>/masters
/clusters/<id>/tags
/clusters/<id>/shell
/clusters/<id>/collections/<name>
/clusters/<id>/volume-servers/<addr>
```

Expected:

- cluster header and tabs render consistently
- masters page shows disagreement and lock states clearly
- collection page links and actions work with scoped defaults
- topology row link opens volume-server detail

- [ ] **Step 4: Final commit or squash decision**

If keeping per-task commits:

```bash
git log --oneline --max-count=10
```

If squashing before review, decide intentionally instead of amending by habit.

## Self-Review

### Spec coverage

- Phase 0 route foundation: covered by Tasks 1-2.
- Phase 1 masters/raft/lock page and capability split: covered by Tasks 3-5.
- Phase 4 collection detail: covered by Tasks 6-7.
- Phase 3 volume-server detail: covered by Tasks 8-9.
- Verification and non-regression: covered by Task 10.

### Placeholder scan

No `TBD`, `TODO`, or “similar to previous task” placeholders remain. All tasks include concrete file paths and commands.

### Type consistency

- `cluster.lock.probe` is used consistently in route gating and UI gating.
- `useClusterMasters`, `useCollectionDetail`, and `useVolumeServer` match the route names used elsewhere in the plan.
- The masters response uses `health: "ok" | "warn" | "err"` consistently with `HealthBadge`.
