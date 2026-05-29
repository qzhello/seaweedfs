# 导航即时渲染 UI、数据渐进填充 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Navigation renders the UI shell (breadcrumb, tab strip, page header, card/table outlines) instantly and fills data in progressively, replacing the current full-area "wait for data then render" behaviour.

**Architecture:** Lift persistent chrome out of every loading gate so it always renders; gate ONLY the data region behind `isLoading && !data`, showing a structure-matching skeleton (`TableSkeleton`/`CardSkeleton` from `components/table-skeleton.tsx`). Permission-denied and `error` branches keep returning their whole-block terminal cards. No backend, no SWR, no data-flow changes.

**Tech Stack:** Next.js App Router, React, TypeScript, SWR, Tailwind. Existing skeleton primitives in `web/components/table-skeleton.tsx`.

---

## Test / Acceptance Policy (all tasks)

No backend changes. For every task:
- `cd web && npm run typecheck 2>&1 | grep "<changed-file>"` → **no NEW errors** vs the repo's pre-existing tsc RED baseline (the baseline lives in unrelated files like `i18n.ts`; only the changed file matters). If the grep shows nothing, you're clean.
- Re-read the edited JSX for balanced tags.
- There are no unit tests for these presentational components; correctness is verified by typecheck + the manual smoke checklist in the final section. Do NOT invent brittle render tests.

All paths are relative to `seaweedfs-tiering-controller/web/`. Work from `/Users/quzhihao/GolandProjects/seaweedfs_qzh/seaweedfs-tiering-controller/web`.

## The shared transformation (reference for every page task)

Every target subpage currently ends like this:
```tsx
  if (capsLoading) return null;
  if (!has("<cap>")) return <div className="card ...">…no permission…</div>;
  if (error) return ( <div className="card …error…">…</div> );
  if (isLoading || !data) {
    return ( <div …full-area spinner/skeleton… /> );   // ← REMOVE this whole block
  }
  return (
    <div className="space-y-5">      {/* or space-y-4/6 */}
      <header …>…title / Refresh button…</header>
      …data sections that read data.xxx…
    </div>
  );
```

Transform to:
```tsx
  if (capsLoading) return null;
  if (!has("<cap>")) return <div …no permission… />;   // keep (terminal)
  if (error) return ( <div …error… /> );               // keep (terminal)
  // (deleted the `if (isLoading || !data) return …` block)
  return (
    <div className="space-y-5">
      <header …>…title / Refresh button…</header>       {/* always renders */}
      {isLoading && !data
        ? <Skeleton… />                                 {/* data-region placeholder */}
        : ( <> …data sections that read data.xxx… </> )}
    </div>
  );
```

Rules:
- Keep the `capsLoading` / `!has` / `error` early returns exactly as they are.
- The header (title text, icons, Refresh button) must render unconditionally. The Refresh button's `disabled={isValidating}` stays.
- Any header sub-value that reads `data.xxx` must either move into the skeleton-gated region OR (for detail pages) be sourced from the route param when available — see per-page notes.
- Use `isLoading && !data` (NOT `isLoading || !data`) so a cached previous render is shown immediately on revisits.
- Wrap multiple real sections in a fragment `<>…</>` for the ternary's false branch.

---

## Task 1: Layout — render breadcrumb + tabs instantly

**File:** Modify `app/clusters/[id]/layout.tsx`

Current (around lines 56-78): after the topology hook, a block bails out before the chrome:
```tsx
  const { data, error } = useClusterTopology(shouldFetchTopology ? id : undefined);

  if (!data && !error) {
    if (capsLoading) return null;
    if (isReadSurface && !canReadCluster) {
      return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view this cluster.")}</div>;
    }
    if (isShellRoute && !canUseShell) {
      return <div className="card p-6 text-sm text-muted">{t("You do not have permission to use this shell console.")}</div>;
    }
    return <CardSkeleton lines={3} title={false}/>;
  }

  const cluster = data?.cluster || null;
  …
```

- [ ] **Step 1: Replace the bail-out block so chrome always renders**

Replace the entire `if (!data && !error) { … }` block above with the permission/caps guards kept but the `CardSkeleton` whole-area return removed:

```tsx
  // capsLoading gates tab visibility (TABS use `loading`), so wait for caps
  // but NOT for topology — chrome must render immediately.
  if (capsLoading) return null;
  if (isReadSurface && !canReadCluster) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view this cluster.")}</div>;
  }
  if (isShellRoute && !canUseShell) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to use this shell console.")}</div>;
  }
  const topologyPending = !data && !error;

  const cluster = data?.cluster || null;
```

(Leave the existing `const topology = data?.topology || null;` and `const visibleTabs = …` lines as they are.)

- [ ] **Step 2: Skeleton-gate only the data-derived sub-header line**

The sub-header currently is:
```tsx
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted font-mono">{cluster?.master_addr || "master unavailable"}</p>
          {cluster && (
            <div className="flex items-center gap-2">
              <span className="badge">{cluster.business_domain}</span>
              <span className={`badge ${cluster.enabled ? "border-success/40 text-success" : "border-muted text-muted"}`}>
                {cluster.enabled ? t("enabled") : t("disabled")}
              </span>
            </div>
          )}
        </div>
```
Replace the `<p>` line's content so a `SkeletonBar` shows while topology is pending instead of the misleading "master unavailable":
```tsx
          <p className="text-xs text-muted font-mono">
            {topologyPending ? <SkeletonBar w="12rem"/> : (cluster?.master_addr || "master unavailable")}
          </p>
```
The `{cluster && (…badges…)}` block already no-ops when `cluster` is null, so badges simply appear once topology arrives. No other change needed there.

- [ ] **Step 3: Import `SkeletonBar`**

The file already imports `CardSkeleton` from `@/components/table-skeleton`. Change that import to also bring `SkeletonBar`:
```tsx
import { CardSkeleton, SkeletonBar } from "@/components/table-skeleton";
```
`CardSkeleton` may now be unused — if so, drop it from the import to avoid an unused-symbol lint:
```tsx
import { SkeletonBar } from "@/components/table-skeleton";
```
(Verify whether `CardSkeleton` is referenced anywhere else in the file before removing.)

- [ ] **Step 4: Verify the breadcrumb + tabs no longer depend on topology**

The breadcrumb uses `cluster?.name || id` (already null-safe). The tab strip's `visibleTabs` uses `capsLoading`/`has`/role only. Confirm by reading the final `return (...)` JSX that nothing in the breadcrumb/nav references a non-optional `data`/`cluster`/`topology` field. The `ClusterDetailContext.Provider` now provides `cluster: null, topology: null` while pending — that is the intended contract (subpages handle it in their own tasks).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck 2>&1 | grep "clusters/\[id\]/layout.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/layout.tsx"
git commit -m "feat(web): render cluster chrome (breadcrumb+tabs) instantly, skeleton topology"
```

---

## Task 2: Masters page — skeleton-first

**File:** Modify `app/clusters/[id]/masters/page.tsx`

This is a LIST page: static header + a consistency panel + a masters table + the Lock-probe and Raft-leadership cards. The header and both action cards do not depend on the masters list (`data.raft_servers` is read with `?? []`), so only the consistency panel + table get skeletons.

- [ ] **Step 1: Read the current structure**

Read the file. Confirm the gate `if (isLoading || !data) { return ( … ) }` (around line 44) and the post-gate `return ( <div className="space-y-5"> <header>…</header> <ConsistencyPanel …/> <section …masters table…/> <section …Lock probe…/> <section …Raft leadership…/> </div> )`.

- [ ] **Step 2: Remove the full-area gate; render header always**

Delete the `if (isLoading || !data) { return ( … ) }` block. Keep `if (capsLoading) return null;`, the `!has("cluster.read")` card, and the `error` card.

After deletion the component falls through to the main `return`. Because the main JSX reads `data.consistency` and `data.masters`, guard those usages: introduce safe locals right before the `return`:
```tsx
  const consistency = data?.consistency;
  const masters = data?.masters ?? [];
  const loadingData = isLoading && !data;
```
(There is an existing `const consistency = data.consistency;`-style line inside the old happy path — move/replace it with the optional version above so it is in scope for the whole return.)

- [ ] **Step 3: Skeleton-gate the consistency panel + masters table**

In the returned JSX:
- Wrap the consistency panel:
```tsx
        {loadingData ? <CardSkeleton lines={2}/> : (consistency && <ConsistencyPanel consistency={consistency}/>)}
```
- Wrap the masters table section body. Replace the `<tbody>{data.masters.map(...)}</tbody>` usage so the table shell renders with a skeleton body while loading:
```tsx
        {loadingData ? (
          <TableSkeleton rows={4} headers={[t("Address"), t("Health"), t("Role"), t("Reported leader"), t("Reported peers"), t("Latency"), t("Lock holder"), t("Warnings")]}/>
        ) : (
          <section className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="grid">
                <thead>…existing headers…</thead>
                <tbody>{masters.map((row) => <MasterRow key={row.address} row={row}/>)}</tbody>
              </table>
            </div>
          </section>
        )}
```
- The Lock-probe `<section>` and Raft-leadership `<section>` render unconditionally (they already use `data.raft_servers ?? []` — keep that `?? []`).

- [ ] **Step 4: Imports**

Add `CardSkeleton, TableSkeleton` to the `@/components/table-skeleton` import (the file may not import them yet). Remove the now-unused `Loader2` ONLY if no longer referenced (the transfer/probe spinners still use it — keep it if so).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck 2>&1 | grep "masters/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/masters/page.tsx"
git commit -m "feat(web): masters page skeleton-first (header+cards instant, table skeleton)"
```

---

## Task 3: Filers page — skeleton-first (list page)

**File:** Modify `app/clusters/[id]/filers/page.tsx`

LIST page. Gate `if (isLoading || !data)` at line 27; header at line 40; table at line 90.

- [ ] **Step 1: Read the file** — note the header block (lines ~40-58: `<h2>` title + Refresh button) and the `<table className="grid">` with its `<thead>` column headers (read the exact `<th>` labels).

- [ ] **Step 2: Apply the shared transformation**
- Delete the `if (isLoading || !data) { return (…) }` block (keep caps/permission/error returns).
- Add `const rows = data?.filers ?? [];` and `const loadingData = isLoading && !data;` before the return (use the real field name — confirm via the `ClusterFilerRow`/`useClusterFilers` shape; the response type is `{filers: ClusterFilerRow[]}`).
- Render `<header>` unconditionally.
- Wrap the table: `{loadingData ? <TableSkeleton rows={5} headers={[…the exact <th> labels you read…]}/> : (<…existing table with rows.map…>)}`.

- [ ] **Step 3: Import** `TableSkeleton` from `@/components/table-skeleton`. Keep `RefreshCw`.

- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "filers/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/filers/page.tsx"
git commit -m "feat(web): filers page skeleton-first"
```

---

## Task 4: EC-shards page — skeleton-first (list page)

**File:** Modify `app/clusters/[id]/ec-shards/page.tsx`

LIST page. Gate at line 52; header at line 70; table at line 159. Note it also has a `useMemo` (line 31-33) that returns `[]` when `!data` — that already null-safe.

- [ ] **Step 1: Read the file** — header block (lines ~70-120, includes a Refresh button at 118) and the `<table className="grid">` headers at ~159.
- [ ] **Step 2: Apply the shared transformation**
- Delete the `if (isLoading || !data) { return (…) }` block.
- Add `const loadingData = isLoading && !data;` before the return. The existing memo already yields `[]` when `!data`, so the table body is safe; you only need to swap the table for a skeleton while loading.
- Render `<header>` unconditionally.
- Wrap the table region: `{loadingData ? <TableSkeleton rows={5} headers={[…exact <th> labels…]}/> : (<…existing table…>)}`. If the page shows an empty-state when the memo is `[]`, make sure the empty-state only shows when `!loadingData` (so loading shows the skeleton, not "no EC volumes").
- [ ] **Step 3: Import** `TableSkeleton`. Keep `RefreshCw`.
- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "ec-shards/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/ec-shards/page.tsx"
git commit -m "feat(web): ec-shards page skeleton-first"
```

---

## Task 5: Volume detail page — skeleton-first (detail page)

**File:** Modify `app/clusters/[id]/volumes/[vid]/page.tsx`

DETAIL page. Gate at line 32; header at line 48 (reads `data` for size/stats); EC shard layout at 83; replicas table at 110-113. The route param `vid` is available immediately (via `useParams`/props) — use it for the title so the page identity shows at once.

- [ ] **Step 1: Read the file** — identify (a) which header bits are static or come from the route param `vid` vs which read `data.xxx`, and (b) the replicas `<table>` headers (line ~113).

- [ ] **Step 2: Apply the detail-page transformation**
- Delete the `if (isLoading || !data) { return (…) }` block (keep caps/permission/error returns).
- Add `const loadingData = isLoading && !data;` before the return.
- Render a persistent title using `vid` (e.g. the `<header>`'s heading showing `Volume {vid}` from the route param). Keep any static chrome.
- Wrap everything that reads `data.xxx` (data-derived header stats, EC shard layout section, replicas table) in `{loadingData ? <CardSkeleton lines={5}/> : (<> …real sections… </>)}`. If both a stats card and a table exist, you may use `{loadingData ? (<><CardSkeleton lines={4}/><TableSkeleton rows={3}/></>) : (<>…real…</>)}`.

- [ ] **Step 3: Import** `CardSkeleton` (and `TableSkeleton` if you skeleton the replicas table) from `@/components/table-skeleton`.

- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "volumes/\[vid\]/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/volumes/[vid]/page.tsx"
git commit -m "feat(web): volume detail page skeleton-first"
```

---

## Task 6: EC-volume detail page — skeleton-first (detail page)

**File:** Modify `app/clusters/[id]/ec-volumes/[vid]/page.tsx`

DETAIL page. Gate at line 48; header at line 65 (reads `data`); a `!data.healthy` banner at 86; shard table at 162; another table at 223. Route param `vid` available immediately.

- [ ] **Step 1: Read the file** — note the header's static vs `data`-derived parts, the `{!data.healthy && (…)}` banner, and the two `<table>` headers (~162, ~223).
- [ ] **Step 2: Apply the detail-page transformation**
- Delete the `if (isLoading || !data) { return (…) }` block.
- Add `const loadingData = isLoading && !data;`.
- Render the title from `vid` persistently.
- Wrap the `data`-dependent regions (health banner, shard tables, derived header stats) in `{loadingData ? (<><CardSkeleton lines={4}/><TableSkeleton rows={4}/></>) : (<> …real… </>)}`. The `{!data.healthy && …}` banner must live inside the false (real) branch so `data` is non-null there.
- [ ] **Step 3: Import** `CardSkeleton, TableSkeleton`.
- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "ec-volumes/\[vid\]/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/ec-volumes/[vid]/page.tsx"
git commit -m "feat(web): ec-volume detail page skeleton-first"
```

---

## Task 7: Volume-server detail page — skeleton-first (detail page)

**File:** Modify `app/clusters/[id]/volume-servers/[addr]/page.tsx`

DETAIL page. Gate at line 45; header at line 62; "Disks" table at 86; "Collections on this server" table at 113; another table at 142. A memo at line 22 returns `[]` when `!data`. Route param `addr` (decoded) available immediately.

- [ ] **Step 1: Read the file** — header static vs `data`-derived; the three `<table>` headers.
- [ ] **Step 2: Apply the detail-page transformation**
- Delete the `if (isLoading || !data) { return (…) }` block.
- Add `const loadingData = isLoading && !data;`.
- Render the title from the decoded `addr` persistently.
- Wrap the data regions (disks table, collections table, derived stats) in `{loadingData ? (<><CardSkeleton lines={4}/><TableSkeleton rows={3}/></>) : (<> …real… </>)}`.
- [ ] **Step 3: Import** `CardSkeleton, TableSkeleton`.
- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "volume-servers/\[addr\]/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/volume-servers/[addr]/page.tsx"
git commit -m "feat(web): volume-server detail page skeleton-first"
```

---

## Task 8: Collection detail page — skeleton-first (detail page)

**File:** Modify `app/clusters/[id]/collections/[name]/page.tsx`

DETAIL page. Gate at line 56; header at line 72; "Replication placement" table at 102; "Per-server distribution" table at 124; another table at 145. Two memos (lines 32, 39) return `[]` when `!data`. Also uses a second hook `useVolumes(id)` (line 27) — that one is independent and already optional. Route param `name` (decoded) available immediately.

- [ ] **Step 1: Read the file** — header static vs `data`-derived; the three `<table>` headers.
- [ ] **Step 2: Apply the detail-page transformation**
- Delete the `if (isLoading || !data) { return (…) }` block (this gates on the primary `useCollectionDetail` `data`; the secondary `vd` from `useVolumes` is already optional and must NOT be added to the gate).
- Add `const loadingData = isLoading && !data;`.
- Render the title from the decoded `name` persistently.
- Wrap the `data`-dependent regions (placement table, per-server table, derived stats) in `{loadingData ? (<><CardSkeleton lines={4}/><TableSkeleton rows={3}/></>) : (<> …real… </>)}`.
- [ ] **Step 3: Import** `CardSkeleton, TableSkeleton`.
- [ ] **Step 4: Typecheck + commit**
```bash
npm run typecheck 2>&1 | grep "collections/\[name\]/page.tsx"
```
Expected: no output.
```bash
git add "app/clusters/[id]/collections/[name]/page.tsx"
git commit -m "feat(web): collection detail page skeleton-first"
```

---

## Final Verification (after all tasks)

- [ ] `cd web && npm run typecheck 2>&1 | grep -E "clusters/\[id\]"` — confirm no NEW errors in any touched cluster file vs baseline.
- [ ] `npm run build` succeeds.
- [ ] **Manual smoke (hard refresh = no SWR cache):** for the layout + each of the 7 subpages, on first visit confirm: breadcrumb + tab strip + page header + card/table outlines appear IMMEDIATELY; the data region shows a skeleton that is then replaced by real data; a second navigation to an already-visited page is instant and does NOT flash a skeleton (cached data shows). Permission-denied and backend-error states still show their terminal cards (not skeletons).
- [ ] Spot-check responsive breakpoints 768 / 1440 on one list page and one detail page — no overflow from the skeletons (they reuse existing card/table containers).
- [ ] Dispatch a final code reviewer for the whole change; then use superpowers:finishing-a-development-branch.
