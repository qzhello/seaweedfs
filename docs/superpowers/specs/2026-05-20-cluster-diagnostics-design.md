# Cluster Diagnostics And Drilldown Design

## Context

The current controller UI already exceeds the official SeaweedFS admin UI in multi-cluster operations, task execution, guided mutations, and capability-aware access control. Its main gap is cluster diagnosis depth. The highest-value missing surface is master/raft visibility: when a cluster has quorum issues, peer-list divergence, or a stuck admin lock, the current UI forces the operator back into logs and ad-hoc shell commands.

The current implementation shape matters:

- Backend routes live in `seaweedfs-tiering-controller/internal/api/server.go` and mostly extend the `/api/v1/clusters/:id/...` namespace.
- Frontend cluster detail is currently a single page in `seaweedfs-tiering-controller/web/app/clusters/[id]/page.tsx`.
- Existing read surfaces are capability-gated with `cluster.read` or `volume.read`; mutating actions use dedicated capabilities.
- The UI already has reusable patterns for SWR hooks, modal actions, and plan/apply workflows.

This design keeps those patterns intact and adds new routes and pages without changing existing behavior in-place.

## Goals

1. Remove the current blind spot around raft membership, leader state, and admin lock health.
2. Turn cluster detail from a monolithic page into a route family that can host drilldown pages cleanly.
3. Add the most operationally valuable drilldowns next: collection detail and volume server detail.
4. Preserve existing controller strengths: multi-cluster workflows, SSE operations, guided mutations, and capability-aware UI gating.

## Non-Goals

- Re-implement the official admin UI one-for-one.
- Replace existing global pages such as `/ec` or `/collections`.
- Add file browsing in this rollout.
- Change existing shell or task execution semantics.

## Recommended Delivery Order

Use the minimum useful path:

1. Phase 0: shared route and hook foundation
2. Phase 1: cluster masters + raft + lock diagnostics
3. Phase 4: collection detail
4. Phase 3: volume server detail

This order addresses the current production pain first, then upgrades the two most-used drilldown surfaces.

## Product Decisions

### 1. Cluster detail structure

Keep `/clusters/[id]` as the canonical entry point, but split the implementation into nested routes:

- `/clusters/[id]` -> Overview
- `/clusters/[id]/topology`
- `/clusters/[id]/masters`
- `/clusters/[id]/filers`
- `/clusters/[id]/volume-servers`
- `/clusters/[id]/collections`
- `/clusters/[id]/ec`
- `/clusters/[id]/tags`
- `/clusters/[id]/shell`

The top-level layout should carry the cluster header, breadcrumbs, and tab navigation. Existing content from the current single page gets redistributed into the Overview, Tags, Topology, and Shell tabs without removing capability checks or actions.

### 2. File Browser

Do not include a file browser in this rollout. It is lower value than diagnostics and drilldowns, and it adds both API breadth and risk around destructive file operations.

### 3. Permissions

Use existing read capabilities for passive pages:

- `cluster.read` for cluster-scoped status pages
- `volume.read` for storage state pages

Do not fold lock probing into `cluster.read`. Add a dedicated capability:

- `cluster.lock.probe`

Reason: lock probing is operationally safe but still more active than ordinary reads. Separating it avoids accidentally granting it to every read-only user and matches the existing capability style.

### 4. `/ec` coexistence

Keep the existing top-level `/ec` page as the cross-cluster operational summary. Add the future shard-matrix view as a cluster-scoped detail surface under `/clusters/[id]/ec/...`.

Reason: the two pages answer different questions. The top-level page is for fleet-wide action selection; the cluster-scoped page is for deep diagnosis.

## Architecture

### Frontend route model

Introduce a cluster detail layout that owns:

- cluster fetch/bootstrap
- shared tab definitions
- capability-aware tab visibility
- common error and loading treatment

The current `web/app/clusters/[id]/page.tsx` should become the Overview tab or be split into smaller components used by Overview, Topology, Tags, and Shell pages.

The preferred structure is:

- `web/app/clusters/[id]/layout.tsx`
- `web/app/clusters/[id]/page.tsx`
- `web/app/clusters/[id]/masters/page.tsx`
- `web/app/clusters/[id]/filers/page.tsx`
- `web/app/clusters/[id]/volume-servers/page.tsx`
- `web/app/clusters/[id]/volume-servers/[addr]/page.tsx`
- `web/app/clusters/[id]/collections/page.tsx`
- `web/app/clusters/[id]/collections/[name]/page.tsx`
- `web/app/clusters/[id]/ec/page.tsx`
- `web/app/clusters/[id]/tags/page.tsx`
- `web/app/clusters/[id]/shell/page.tsx`

Shared state should stay local to each route through SWR rather than introducing a larger client-side store.

### Backend route model

Extend the existing cluster route family in `internal/api/server.go` with additive endpoints only.

Phase 0 adds shared read endpoints and data shapes needed by later tabs.

Phase 1 adds:

- `GET /api/v1/clusters/:id/masters`
- `POST /api/v1/clusters/:id/masters/lock-probe`

Phase 3 adds:

- `GET /api/v1/clusters/:id/volume-servers/:addr`

Phase 4 adds:

- `GET /api/v1/clusters/:id/collections/:name`

Future phases can add filers and EC routes under the same namespace.

### Shared frontend foundation

Phase 0 should introduce:

- `useClusterMasters(id)`
- `useClusterFilers(id)`
- `useVolumeServer(id, addr)`
- `useCollectionDetail(id, name)`
- `useEcShards(id)`

in `seaweedfs-tiering-controller/web/lib/api.ts`.

Also add a small reusable component:

- `seaweedfs-tiering-controller/web/components/health-badge.tsx`

This badge should standardize `ok | warn | err` display across masters, filers, and future EC/health panels.

## Phase 1: Masters, Raft, And Lock Diagnosis

### User experience

The masters page should answer four operator questions immediately:

1. Who does the cluster think the leader is?
2. Do all masters agree on the membership list?
3. Are any masters misconfigured as non-voters or malformed peers?
4. Is the admin lock free, held, or impossible to acquire because quorum is unhealthy?

The page should have three sections:

- A masters table
- A raft consistency panel
- A lock probe card

### Masters table

Columns:

- master address
- reachability / latency
- role: Leader, Voter, NonVoter, Unknown
- self-reported leader
- self-reported peers
- admin-lock holder
- health badge

The health badge semantics:

- `ok`: peer set consistent, leader agreement present, reachable, no malformed membership
- `warn`: reachable but reports a suspicious state such as non-leader config, missing self, or inconsistent formatting
- `err`: unreachable, quorum disagreement, or clearly divergent peer tables

### Raft consistency panel

This panel should normalize and compare the peer list seen by each master.

It must highlight:

- duplicate peer entries
- address formatting divergence for the same node
- missing self from a master's own peer list
- leader not present in peer lists
- differing peer-set cardinality across masters

The output should be operator-facing, not a raw dump. Show the aligned peer matrix first and a concise warning list second.

### Lock probe

The button triggers a short-lived probe against a selected master or the cluster leader.

Response states:

- `free`: token acquired and released successfully
- `held`: lock already held; include current holder when the server can determine it
- `quorum_unhealthy`: timeout or lease failure that suggests raft is not healthy enough to grant the token

The UI must never leave this in an indeterminate spinner state. It should settle within the server timeout budget and show a stable result card.

### Backend behavior

`GET /clusters/:id/masters` should:

- load the cluster record from Postgres
- discover the effective master set from the configured address plus each master's reported peers
- fan out to each known master concurrently
- collect `/cluster/status`
- collect `/metrics`
- derive lock-holder information from `SeaweedFS_master_admin_lock` metrics when present
- compute normalized peer sets and inconsistencies
- return a merged response suitable for direct rendering

The response should prefer explicit fields over frontend parsing of raw text. Suggested shape:

```json
{
  "cluster": { "id": "...", "name": "...", "master_addr": "..." },
  "masters": [
    {
      "address": "10.0.0.1:9333",
      "reachable": true,
      "latency_ms": 12,
      "is_leader": false,
      "suffrage": "voter",
      "reported_leader": "10.0.0.2:9333",
      "reported_peers": ["10.0.0.1:9333", "10.0.0.2:9333"],
      "normalized_peers": ["10.0.0.1:9333", "10.0.0.2:9333"],
      "lock_holder": "",
      "warnings": ["missing_self"],
      "health": "warn"
    }
  ],
  "consistency": {
    "healthy": false,
    "leader_agreement": false,
    "peer_set_agreement": false,
    "issues": [
      {
        "code": "peer_format_divergence",
        "message": "master A reports 10.0.0.2:9333 while master B reports 10.0.0.2.19333"
      }
    ]
  }
}
```

`POST /clusters/:id/masters/lock-probe` should:

- load the cluster
- dial the master gRPC endpoint with a 2 second timeout
- call `LeaseAdminToken`
- if lease succeeds, immediately call release and return `free`
- if lease fails with a known lock-held signal, return `held`
- if timeout or transport error occurs, return `quorum_unhealthy`

Suggested shape:

```json
{
  "status": "held",
  "holder": "controller@host-a",
  "message": "already locked by controller@host-a"
}
```

### Data-source and parsing considerations

- Peer list comparison must normalize known formatting variants before flagging true divergence.
- The raw configured `master_addr` remains important and should be surfaced separately from discovered peers, because a bad configured entry is itself diagnostic signal.
- Unreachable masters should still appear in the response if they were discovered from any source.
- The backend should time-box fan-out so one hung endpoint does not stall the whole page.

## Phase 4: Collection Detail

Collection detail is the next best follow-up because `/collections` already exists and operators need drilldown before taking actions such as balance or EC encode.

Add:

- `GET /api/v1/clusters/:id/collections/:name`
- `web/app/clusters/[id]/collections/[name]/page.tsx`

The page should show:

- KPI summary: volume count, total size, file count, deleted bytes, delete ratio
- EC ratio
- replication distribution
- per-server distribution heatmap
- volume list with links onward where applicable

Collection-scoped actions should reuse existing dialogs with initial values prefilled rather than inventing new mutation flows.

## Phase 3: Volume Server Detail

Volume server detail follows collection detail.

Add:

- `GET /api/v1/clusters/:id/volume-servers/:addr`
- `web/app/clusters/[id]/volume-servers/[addr]/page.tsx`

The page should show:

- identity and placement: data center, rack, address, version, start time
- aggregate capacity and used bytes
- per-disk bars
- hosted volumes table with sorting and filters
- existing actions launched through current plan/apply dialogs or shell action wrappers

Topology rows should link here directly.

## Routing And Linking Changes

The existing cluster detail page should expose a tab strip. At minimum:

- Overview
- Topology
- Masters
- Tags
- Shell

Future tabs can be shown once their routes land. Do not show dead tabs that 404.

Other navigation changes:

- Add a `Raft health` link or badge from Topology/Overview into `Masters`
- Make collection names link from `/collections` into cluster-scoped detail
- Make topology node rows link into volume server detail

## Capability Model

Add new capability catalog entry:

- `cluster.lock.probe`

Suggested gating:

- `/clusters/:id/masters` -> `cluster.read`
- `/clusters/:id/masters/lock-probe` -> `cluster.lock.probe`
- `/clusters/:id/collections/:name` -> `volume.read`
- `/clusters/:id/volume-servers/:addr` -> `volume.read`

Frontend tab visibility should match backend enforcement. A user lacking `cluster.lock.probe` should still see the Masters page but not the probe button.

## Error Handling

Backend responses should degrade partially instead of failing whole pages when one node is broken.

Rules:

- One unreachable master should not make `/masters` return 502 if the rest of the cluster can still be described.
- Per-node errors should be embedded in the row payload.
- Only fail the entire request when the cluster itself cannot be resolved or no useful upstream data can be fetched at all.

Frontend pages should distinguish:

- cluster missing
- upstream unavailable
- partial data with warnings

## Testing Strategy

### Backend

- unit tests for peer normalization and consistency detection
- unit tests for metrics parsing of admin lock holder
- unit tests for lock-probe response mapping
- handler tests for partial failure responses

### Frontend

- component tests for health badge and masters warning rendering
- page-level tests for tab visibility by capability
- interaction test for lock probe state transitions

### Manual verification

Validate against a deliberately unhealthy cluster:

- duplicate peer entry
- mismatched peer formatting
- leader disagreement
- empty lock holder
- held lock
- unreachable master

Success means the Masters page makes these states obvious without consulting logs.

## Risks And Mitigations

### Risk: overcoupling UI to raw SeaweedFS output

Mitigation: normalize and structure data in the backend, not in React components.

### Risk: lock probe semantics differ across SeaweedFS versions

Mitigation: keep the API response state machine coarse (`free`, `held`, `quorum_unhealthy`) and preserve the original error string for display and debugging.

### Risk: cluster route split causes regressions in the current single-page experience

Mitigation: move existing sections incrementally into nested routes and keep `/clusters/[id]` as Overview, not as a redirect.

### Risk: capability drift between nav, tabs, and backend

Mitigation: gate all routes server-side first, then mirror that same capability string in frontend visibility checks.

## Rollout Plan

1. Add shared route layout, tabs, hooks, and `HealthBadge`.
2. Add backend masters aggregation endpoint and lock probe endpoint.
3. Ship the Masters page behind existing cluster navigation.
4. Add collection detail endpoint and page.
5. Add volume server detail endpoint and page.

Each step is independently releasable.

## Acceptance Criteria

This design is successful when:

- an operator can open `/clusters/[id]/masters` and immediately understand leader, peers, suffrage, and lock state
- cluster detail no longer needs to remain a single oversized page to grow
- collection and volume server list views become real drilldown entry points
- existing top-level `/ec` remains intact for fleet-wide workflows
- no existing mutating flows lose capability protection or guided UX
