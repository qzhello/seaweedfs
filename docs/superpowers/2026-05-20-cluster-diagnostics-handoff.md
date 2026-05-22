# Cluster Diagnostics Handoff

## Status: ALL TASKS COMPLETE (2026-05-20 resume)

The original plan is fully implemented and both backend test packages are
green. Frontend typecheck is clean on every file owned by this plan; the
only remaining `tsc` errors live in unrelated pages (`app/ai-config`,
`app/ai-learning`, `lib/i18n.ts`) that existed before the plan started.

- Design spec: `docs/superpowers/specs/2026-05-20-cluster-diagnostics-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-20-cluster-diagnostics-implementation-plan.md`

## Task Summary

| # | Task                                          | Status |
|---|-----------------------------------------------|--------|
| 1 | Route split skeleton                          | DONE   |
| 2 | Shared frontend primitives + API hooks         | DONE (types updated to match real backend) |
| 3 | Masters aggregation backend                   | DONE   |
| 4 | Lock probe route + capability gate            | DONE   |
| 5 | Masters frontend page                         | DONE   |
| 6 | Collection detail backend                     | DONE   |
| 7 | Collection detail frontend + global link      | DONE   |
| 8 | Volume-server detail backend                  | DONE (shipped with Task 6 in `cluster_drilldown.go`) |
| 9 | Volume-server detail frontend + topology link | DONE   |
| 10 | Final verification                           | DONE   |

## What was added in the resume turn

### Backend (`internal/api`, `internal/seaweed`, migrations)

- `cluster_masters.go` — added `clusterMasterLockProbe` handler,
  `mapLockProbeResult`, `pickProbeTarget`, `lockProbeClientName`, and
  response/request types. Uses the existing aggregation pipeline to pick
  the raft leader; mapping centralised so tests don't need a live master.
- `cluster_masters_test.go` — added `TestMapLockProbeResult` covering
  acquired/held/not-leader/dial-failure mappings.
- `cluster_drilldown.go` — added collection + volume-server aggregators
  (`buildCollectionDetail`, `buildVolumeServerDetail`), their handlers,
  `formatReplicaPlacement`, and response types.
- `cluster_drilldown_test.go` — covers normal/EC collections, the empty
  default collection, volume-server aggregation across two disks, and the
  SeaweedFS decimal replica-placement encoding.
- `seaweed/client.go` — added `LockProbeOutcome`, `ProbeMasterAdminLock`
  (LeaseAdminToken + immediate ReleaseAdminToken), and
  `parseAlreadyLockedHolder` for parsing the master's error format.
- `seaweed/lock_probe_test.go` — table-driven coverage of the holder parser
  (canonical error, grpc-wrapped, unrelated error, empty value).
- `internal/api/server.go` — registered the four new routes:
  - `GET  /clusters/:id/masters`              (cluster.read)
  - `POST /clusters/:id/masters/lock-probe`   (cluster.lock.probe)
  - `GET  /clusters/:id/collections/:name`    (volume.read)
  - `GET  /clusters/:id/volume-servers/:addr` (volume.read)
- `migrations/pg/026_cluster_lock_probe_cap.sql` — seeds the new
  `cluster.lock.probe` capability and grants it to admin/operator/viewer/
  auditor (read-shaped probe, safe for all read roles).

### Frontend (`web/`)

- `web/lib/api.ts` — replaced the stub `ClusterMasterRow`/`ClusterMastersResponse`/
  `VolumeServerDetail`/`CollectionDetail` types with shapes that match the
  Go handlers byte-for-byte. Added `MasterConsistency`/`MasterConsistencyIssue`,
  `DiskSummary`, `VolumeReplicaRow`. Fixed `useCollectionDetail` to honour
  the `_default_` sentinel. Updated `api.lockProbe` payload shape.
- `web/app/clusters/[id]/layout.tsx` — re-added the **Masters** tab now
  that the page exists; the layout fetcher gates the new route under
  `cluster.read`.
- `web/app/clusters/[id]/masters/page.tsx` — new page. Shows aggregated
  rows, a consistency panel (badges + per-issue codes), and a "Probe
  admin lock" button gated on `cluster.lock.probe`. Result card renders
  free / held(holder) / quorum_unhealthy distinctly.
- `web/app/clusters/[id]/collections/[name]/page.tsx` — new page.
  KPI cards, replication-placement table, server distribution (links to
  volume-server detail), and a per-replica volume table. Balance button
  reuses `VolumeBalanceDialog` with the collection prefilled.
- `web/app/collections/page.tsx` — global list rows now link to the
  cluster-scoped detail page (honouring the `_default_` sentinel).
- `web/app/clusters/[id]/volume-servers/[addr]/page.tsx` — new page.
  Header KPIs, per-disk summary, per-collection summary (links back),
  and a per-volume row table. Cross-links from EC/replica rows.
- `web/app/clusters/[id]/_components/nodes-panel.tsx` — topology node
  identifier is now a `Link` to the new volume-server detail page.

## Verification

```bash
cd seaweedfs-tiering-controller
env GOCACHE=/tmp/go-build /Users/quzhihao/GolandProjects/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.0.darwin-arm64/bin/go test ./internal/api ./internal/seaweed
```

Result: both packages PASS, including the new mapping/parsing tests.
A `-race` run also passes (only a benign macOS `LC_DYSYMTAB` linker
warning is emitted).

```bash
pnpm --prefix seaweedfs-tiering-controller/web typecheck
```

Result: every file owned by the plan compiles cleanly. The remaining
errors are pre-existing in `lib/i18n.ts` (duplicate keys),
`app/ai-config`, `app/ai-learning`, and `app/alerts`.

## Manual smoke checklist

The following routes should now be reachable in the browser:

```
/clusters/<id>
/clusters/<id>/topology
/clusters/<id>/masters
/clusters/<id>/tags
/clusters/<id>/shell
/clusters/<id>/collections/<name>      (or _default_ for the unnamed collection)
/clusters/<id>/volume-servers/<addr>
```

The `Probe admin lock` button on `/clusters/<id>/masters` is the
operator-visible fix for the original "应用按钮一直转圈" diagnostic gap:
it identifies the lock holder (or proves the lock is free) without
granting any mutating capability.

## Migration ordering

Apply `migrations/pg/026_cluster_lock_probe_cap.sql` on existing
deployments so the lock-probe button works for non-admin roles. Without
it, the route still works for admin users via the wildcard `*` cap.
