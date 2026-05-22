"use client";
import { useVolumes, useHeatmap, useClusters, useVolumeTrendBulk } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, X, Search, Database, Filter, Eye, EyeOff, BarChart3, Copy, Check, Wand2, Undo2, ShieldCheck, Plus, Scale, Trash2, MoreHorizontal, MapPin, Activity } from "lucide-react";
import { ECEncodeDialog } from "@/components/ec/encode-dialog";
import { ECDecodeDialog } from "@/components/ec/decode-dialog";
import { VolumeFixReplicationDialog } from "@/components/volume/fix-replication-dialog";
import { VolumeGrowDialog } from "@/components/volume/grow-dialog";
import { VolumeBalanceDialog } from "@/components/volume/balance-dialog";
import { VolumeDeleteEmptyDialog } from "@/components/volume/delete-empty-dialog";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/table-skeleton";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import {
  VolumeRowActions, VolumeBulkBar, VolumeActionDialog, type VolumeRowLike,
} from "@/components/volume-actions";
import { useCluster } from "@/lib/cluster-context";
// Helpers + sub-components extracted from this file when it grew past
// the 800-line hard cap. types holds the wire shape + chart constants;
// query parses the search box; chart-builders shape data; the rest
// are visual components.
import {
  type Volume, type ReadFilter, type ECFilter, type DistMode, type ChartKey,
  COMPACT_CHART_H, ALL_CHARTS, VIS_KEY, DRAWER_KEY, loadVisible, loadDrawerOpen,
} from "./_components/types";
import { parseVolumeQuery } from "./_components/query";
import { DistKeyList } from "./_components/dist-key-list";
import { buildDist, buildCompositionOption, buildHeatmap } from "./_components/chart-builders";
import { BulkEncodeButton, BulkDecodeButton, OperationsMenu } from "./_components/bulk-actions";
import { Sparkline } from "@/components/sparkline";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });


export default function VolumesPage() {
  const { t } = useT();
  const { data: clusters } = useClusters();

  // Cluster context is global (topbar switcher). Empty string === all
  // clusters, which the /volumes endpoint already handles by fanning
  // out across enabled clusters.
  const { clusterID, setClusterID } = useCluster();
  const [collection, setCollection] = useState<string>("");
  const [diskType, setDiskType] = useState<string>("");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [ecFilter, setECFilter] = useState<ECFilter>("all");
  const [text, setText] = useState("");
  const [distMode, setDistMode] = useState<DistMode>("node");

  const { data: vd, mutate: mutateVolumes, isLoading: volumesLoading, isValidating: volumesValidating } = useVolumes(clusterID || undefined);
  const { data: hm, mutate: mutateHeat } = useHeatmap(168);
  const all = (vd?.items || []) as Volume[];

  const { collections, diskTypes } = useMemo(() => {
    const cs = new Set<string>(); const ds = new Set<string>();
    for (const v of all) {
      if (v.Collection) cs.add(v.Collection);
      if (v.DiskType) ds.add(v.DiskType);
    }
    return { collections: [...cs].sort(), diskTypes: [...ds].sort() };
  }, [all]);

  // Search supports key:value qualifiers so operators can disambiguate
  // collisions (e.g. searching "1" used to match both ID=1 and any IP
  // octet containing "1"). Recognised keys: id, collection, server,
  // rack. id:N matches exactly; id:1,2,5 matches any of the listed IDs.
  // Bare tokens still do case-insensitive substring across all fields.
  const query = useMemo(() => parseVolumeQuery(text), [text]);
  // `__default__` is a sentinel for "volumes with no explicit
  // collection name" (SeaweedFS treats Collection="" as the default
  // bucket). It surfaces as "默认" in the dropdown so operators can
  // filter to that group without typing an empty string.
  const hasDefaultCollection = useMemo(
    () => all.some(v => !v.Collection),
    [all],
  );

  const filtered = useMemo(() => all.filter(v => {
    if (collection === "__default__") {
      if (v.Collection) return false;
    } else if (collection && v.Collection !== collection) return false;
    if (diskType && (v.DiskType || "hdd") !== diskType) return false;
    if (readFilter === "writable" && v.ReadOnly) return false;
    if (readFilter === "readonly" && !v.ReadOnly) return false;
    if (ecFilter === "ec" && !v.IsEC) return false;
    if (ecFilter === "normal" && v.IsEC) return false;
    if (query.idSet && !query.idSet.has(Number(v.ID))) return false;
    if (query.collection && (v.Collection || "").toLowerCase() !== query.collection) return false;
    if (query.server && !(v.Server || "").toLowerCase().includes(query.server)) return false;
    if (query.rack && (v.Rack || "").toLowerCase() !== query.rack) return false;
    if (query.free.length) {
      const hay = `${v.ID} ${v.Collection || ""} ${v.Server || ""} ${v.Rack || ""}`.toLowerCase();
      for (const tok of query.free) if (!hay.includes(tok)) return false;
    }
    return true;
  }), [all, collection, diskType, readFilter, ecFilter, query]);

  // Chart visibility — rehydrated from localStorage on mount so SSR
  // and the first client render agree (no hydration mismatch).
  const [visible, setVisible] = useState<Record<ChartKey, boolean>>({
    distribution: true, heatmap: true, composition: true,
  });
  useEffect(() => { setVisible(loadVisible()); }, []);
  const toggleChart = (k: ChartKey) => {
    setVisible(prev => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem(VIS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const hiddenCharts = ALL_CHARTS.filter(c => !visible[c.key]);
  const shownCount   = ALL_CHARTS.length - hiddenCharts.length;

  const [chartsOpen, setChartsOpen] = useState(false);
  useEffect(() => { setChartsOpen(loadDrawerOpen()); }, []);
  // Charts drawer and nav-sidebar collapse are independent controls —
  // each has its own button and its own localStorage key. We
  // deliberately do NOT touch the nav state from here.
  const toggleDrawer = () => {
    setChartsOpen(o => {
      const next = !o;
      try { localStorage.setItem(DRAWER_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const pg = usePagination(filtered, 50);

  // Per-row 30-day sparklines: fetch feature history only for the volume
  // IDs on the current page, in one bulk call. The hook keys SWR on the
  // sorted id list, so paging refetches while SWRConfig keeps the prior
  // page's lines on screen until the new data lands.
  const pageVolumeIDs = useMemo(() => pg.slice.map(v => Number(v.ID)), [pg.slice]);
  const { data: trendData } = useVolumeTrendBulk(pageVolumeIDs);
  const trendByID = trendData?.items ?? {};

  // ---- selection + action dialog state -----------------------------------
  // Selection keys = "<cluster_id>:<id>:<server>" so the same volume on
  // different replicas is selectable independently (volume.delete is
  // node-scoped). Set is rebuilt as a fresh object so React notices.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Per-row selection: each (cluster, vol, server) tuple ticks
  // independently. Replica-aware operations (ec.encode) compute replica
  // counts from the full volume list inside their own dialogs, so the
  // table doesn't need to fold replicas into one row.
  const keyOf = (v: Volume) => `${v.cluster_id || ""}:${v.ID}:${v.Server}`;
  const toggleRow = (v: Volume) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      const k = keyOf(v);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const togglePage = () => {
    const allOn = pg.slice.every((v) => selectedKeys.has(keyOf(v)));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const v of pg.slice) {
        if (allOn) next.delete(keyOf(v));
        else next.add(keyOf(v));
      }
      return next;
    });
  };
  const selectedRows: VolumeRowLike[] = filtered.filter((v) => selectedKeys.has(keyOf(v)));

  const [actionDialog, setActionDialog] = useState<{ action: string; rows: VolumeRowLike[] } | null>(null);
  // Local EC encode dialog state, decoupled from the generic VolumeActionDialog
  // since ec.encode has cluster-scoped parameters (fullPercent / quietFor /
  // disk type / RP) that don't fit the per-row shell action framework.
  const [ecEncodeFor, setEcEncodeFor] = useState<{
    clusterID: string;
    volumeIds: number[];
    sourceVolumes: { logicalBytes: number; replicaCount: number }[];
    collection?: string;
    volumeIdsByCollection: { collection: string; volumeIds: number[] }[];
  } | null>(null);
  // Decode is per-EC-volume — fewer parameters, but same per-volume loop
  // on the server. The dialog opens with the de-duped volume ID list.
  const [ecDecodeFor, setEcDecodeFor] = useState<{
    clusterID: string;
    volumeIds: number[];
  } | null>(null);
  // volume.fix.replication is cluster-scoped (no per-volume selector in
  // the shell command), so the dialog opens against the currently-
  // selected cluster from the topbar context.
  const [fixReplFor, setFixReplFor] = useState<string | null>(null);
  // Grow / Balance / Delete-empty are all cluster-scoped admin ops
  // promoted from their own pages into this toolbar so the operator
  // never leaves the volume list to launch them.
  const [growFor, setGrowFor] = useState<string | null>(null);
  const [balanceFor, setBalanceFor] = useState<string | null>(null);
  const [deleteEmptyFor, setDeleteEmptyFor] = useState<string | null>(null);
  // "Operations" menu drives all four ops (Fix / Grow / Balance / Delete
  // empty). Hidden by default; opens to a dropdown so we don't leak
  // four buttons across the toolbar.
  const [opsMenuOpen, setOpsMenuOpen] = useState(false);

  const dist = useMemo(() => buildDist(filtered, distMode), [filtered, distMode]);
  const heat = useMemo(() => buildHeatmap(hm?.items || []), [hm]);

  const totalWritable = filtered.filter(v => !v.ReadOnly).length;
  const totalReadOnly = filtered.length - totalWritable;
  const totalBytes = filtered.reduce((s, v) => s + (Number(v.Size) || 0), 0);
  // EC rollup. Each EC row is one shard-bag on one node — count distinct
  // volume IDs (across clusters) for an accurate "EC 卷数" figure rather
  // than a shard count.
  const ecVolumeCount = useMemo(() => {
    const s = new Set<string>();
    for (const v of filtered) {
      if (v.IsEC) s.add(`${v.cluster_id || ""}:${v.ID}`);
    }
    return s.size;
  }, [filtered]);

  const chips: { key: string; label: string; clear: () => void }[] = [
    clusterID && { key: "cluster", label: (clusters?.items ?? []).find((c: any) => c.id === clusterID)?.name ?? "cluster", clear: () => setClusterID("") },
    collection && { key: "collection", label: collection === "__default__" ? t("(default)") : collection, clear: () => setCollection("") },
    diskType && { key: "disk", label: diskType, clear: () => setDiskType("") },
    readFilter !== "all" && { key: "read", label: readFilter === "readonly" ? "read-only" : "writable", clear: () => setReadFilter("all") },
    ecFilter !== "all" && { key: "ec", label: ecFilter === "ec" ? "EC only" : "Normal only", clear: () => setECFilter("all") },
    text && { key: "text", label: `"${text}"`, clear: () => setText("") },
  ].filter(Boolean) as any;

  const clearAll = () => { setClusterID(""); setCollection(""); setDiskType(""); setReadFilter("all"); setECFilter("all"); setText(""); };

  // Clicking a chart row drives the right-side table filter. Collection
  // has a dedicated dropdown; node/rack go through the search box with
  // qualifier syntax so the active-filter chips still show what's on.
  // Clicking the same row again toggles the filter off — the operator
  // doesn't have to hunt for the chip's X to undo.
  const filterByDistKey = (key: string) => {
    if (!key) return;
    if (distMode === "collection") {
      // The dist chart labels the no-collection bucket as "(default)";
      // map it to the __default__ sentinel that the page filter uses.
      const target = key === "(default)" ? "__default__" : key;
      if (target.startsWith("(")) return; // other "(unknown)" etc. aren't filterable
      setCollection(c => (c === target ? "" : target));
    } else {
      const qual = distMode === "rack" ? "rack" : "server";
      const next = `${qual}:${key}`;
      setText(t => (t === next ? "" : next));
    }
  };
  // The list highlights the currently-active row so the operator can see
  // at a glance which group is filtering the table. Mirror of the
  // sentinel-mapping in filterByDistKey so the active highlight lines
  // up with the bar label.
  const activeDistKey = useMemo(() => {
    if (distMode === "collection") {
      return collection === "__default__" ? "(default)" : collection;
    }
    if (distMode === "rack")       return query.rack;
    return query.server;
  }, [distMode, collection, query]);

  return (
    // Layout when charts are open: header / filter strip / bulk bar
    // run full width across both columns; only the *chart aside* (col 1)
    // and the *table* (col 2) share a row, side-by-side.
    //
    // grid-flow-dense lets the aside back-fill the empty col-1 cell next
    // to the table even though it appears later in JSX. Without dense
    // flow it would land in a new row below the table.
    <div className={chartsOpen
      ? "grid grid-cols-[minmax(0,440px)_minmax(0,1fr)] grid-flow-dense gap-5 items-start [&>aside]:col-start-1"
      : "space-y-5"
    }>
      <header className={`flex items-end justify-between gap-4 flex-wrap ${chartsOpen ? "col-span-2" : ""}`}>
        <div>
          <h1 className="text-base font-semibold tracking-tight">{t("Volumes")}</h1>
          <div className="text-xs text-muted mt-1">
            <span className="font-mono text-text">{filtered.length}</span>
            <span> / {all.length}</span>
            <span className="mx-2 text-muted/40">|</span>
            <span>{bytes(totalBytes)}</span>
            <span className="mx-2 text-muted/40">|</span>
            <span>{totalWritable} writable</span>
            {totalReadOnly > 0 && <>
              <span className="mx-2 text-muted/40">·</span>
              <span className="text-warning">{totalReadOnly} read-only</span>
            </>}
            {ecVolumeCount > 0 && <>
              <span className="mx-2 text-muted/40">·</span>
              <span className="text-accent">{ecVolumeCount} {t("EC")}</span>
            </>}
            {vd?.clusters_ok != null && <>
              <span className="mx-2 text-muted/40">|</span>
              <span>{vd.clusters_ok} cluster{vd.clusters_ok === 1 ? "" : "s"} ok</span>
            </>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
            <input
              value={text} onChange={e => setText(e.target.value)}
              placeholder={t("id:1  collection:logs  server:10.0.0.5  rack:r1")}
              title={t("Use key:value for exact match (id, collection, server, rack). Bare words match any field.")}
              className="input w-72 pl-8"
            />
          </div>
          <RefreshButton loading={volumesValidating} onClick={() => Promise.all([mutateVolumes(), mutateHeat()])}/>
          {/* All four cluster-scoped admin ops live behind one
              "Operations" button so the toolbar stays compact and the
              ops surface stays consistent. Disabled when no cluster
              is picked because every op needs a single master target. */}
          <OperationsMenu
            disabled={!clusterID}
            emptyCount={all.filter(v => Number(v.Size) === 0).length}
            onPick={(key) => {
              if (!clusterID) return;
              setOpsMenuOpen(false);
              if (key === "fix")     setFixReplFor(clusterID);
              if (key === "grow")    setGrowFor(clusterID);
              if (key === "balance") setBalanceFor(clusterID);
              if (key === "empty")   setDeleteEmptyFor(clusterID);
            }}
            open={opsMenuOpen}
            setOpen={setOpsMenuOpen}
          />
          {/* Charts live in a right-side drawer so the table keeps full
              width by default. Counter shows visible/hidden split so
              the operator knows what to expect on open. */}
          <button
            onClick={toggleDrawer}
            className={`btn inline-flex items-center gap-1.5 ${chartsOpen ? "bg-accent/15 text-accent" : ""}`}
            title={chartsOpen ? t("Hide charts") : t("Show charts")}
          >
            <BarChart3 size={14}/>
            <span>{t("Charts")}</span>
            <span className="text-[10px] text-muted">{shownCount}/{ALL_CHARTS.length}</span>
          </button>
        </div>
      </header>

      {/* Compact filter strip — single row on desktop, wraps on mobile.
          The cluster picker lives in the topbar; here we only have the
          collection / disk / read-only filters. */}
      <section className={`card px-4 py-3 ${chartsOpen ? "col-span-2" : ""}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="select w-auto py-1 text-xs" value={collection} onChange={e => setCollection(e.target.value)}>
            <option value="">{t("All collections")}</option>
            {hasDefaultCollection && (
              <option value="__default__">{t("(default)")}</option>
            )}
            {collections.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select w-auto py-1 text-xs" value={diskType} onChange={e => setDiskType(e.target.value)}>
            <option value="">{t("Any disk")}</option>
            {diskTypes.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(["all", "writable", "readonly"] as const).map(s => (
              <button key={s} onClick={() => setReadFilter(s)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  readFilter === s ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                }`}>
                {s === "all" ? t("All") : s === "writable" ? t("Writable") : t("Read-only")}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(["all", "ec", "normal"] as const).map(s => (
              <button key={s} onClick={() => setECFilter(s)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  ecFilter === s ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                }`}>
                {s === "all" ? t("All") : s === "ec" ? t("EC") : t("Normal")}
              </button>
            ))}
          </div>
          <div className="flex-1"/>
          {chips.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 flex-wrap">
                {chips.map(f => (
                  <button key={f.key} onClick={f.clear}
                    className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/30 text-accent px-2 py-0.5 text-[11px] hover:bg-accent/20 hover:border-accent/50 transition-colors"
                    title="Remove">
                    {f.label}<X size={10}/>
                  </button>
                ))}
              </div>
              <button onClick={clearAll}
                className="text-[11px] text-muted hover:text-text underline underline-offset-2">
                clear
              </button>
            </>
          )}
        </div>
      </section>

      {/* VolumeBulkBar renders null when nothing is selected. We only
          wrap it when it has something to show AND charts are open so
          we don't leave an empty grid row. */}
      {selectedRows.length > 0 && (
        chartsOpen ? (
          <div className="col-span-2 flex items-center gap-2 flex-wrap">
            <VolumeBulkBar
              selected={selectedRows}
              onClear={() => setSelectedKeys(new Set())}
              onPick={(actionKey, rows) => setActionDialog({ action: actionKey, rows })}
            />
            <BulkEncodeButton selected={selectedRows} allVolumes={all} onOpen={setEcEncodeFor}/>
            <BulkDecodeButton selected={selectedRows} onOpen={setEcDecodeFor}/>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <VolumeBulkBar
              selected={selectedRows}
              onClear={() => setSelectedKeys(new Set())}
              onPick={(actionKey, rows) => setActionDialog({ action: actionKey, rows })}
            />
            <BulkEncodeButton selected={selectedRows} allVolumes={all} onOpen={setEcEncodeFor}/>
            <BulkDecodeButton selected={selectedRows} onOpen={setEcDecodeFor}/>
          </div>
        )
      )}

      {/* Detail table — when charts are open, sits in col 2 next to the
          chart aside on the left. */}
      <section className={`card overflow-hidden ${chartsOpen ? "col-start-2" : ""}`}>
        {vd === undefined ? (
          <TableSkeleton rows={6} headers={["ID", "Cluster", "Collection", "Server", "Rack", "Disk", "Size", "Trend", "Files", "R/O", "Modified"]}/>
        ) : filtered.length === 0 ? (
          all.length === 0 ? (
            <EmptyState icon={Database}
              title="No volumes found"
              hint="Check that at least one cluster is enabled and its master is reachable."/>
          ) : (
            <EmptyState icon={Filter} size="sm"
              title="No volumes match the current filter"
              hint="Clear filters above or broaden the search."/>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={pg.slice.length > 0 && pg.slice.every((v) => selectedKeys.has(keyOf(v)))}
                    onChange={togglePage}
                    aria-label="select page"
                  />
                </th>
                <th>ID</th><th>{t("Clusters")}</th><th>{t("Collection")}</th><th>{t("Server")}</th>
                <th>{t("Rack")}</th><th>{t("Disk")}</th><th className="num">{t("Size")}</th>
                <th style={{ width: 124 }} className="text-center" title={t("30-day reads_7d trend · faint area = size")}>{t("Trend")}</th>
                <th className="num">{t("Files")}</th><th>{t("R/O")}</th><th>{t("Modified")}</th>
                <th style={{ width: 36 }}></th>
              </tr></thead>
              <tbody>
                {pg.slice.map(v => {
                  const k = keyOf(v);
                  const checked = selectedKeys.has(k);
                  return (
                  <tr key={k} className={checked ? "bg-accent/5" : undefined}>
                    <td><input type="checkbox" checked={checked} onChange={() => toggleRow(v)} aria-label={`select volume ${v.ID}`}/></td>
                    <td className="font-mono">
                      {v.cluster_id ? (
                        <a
                          href={`/clusters/${v.cluster_id}/volumes/${v.ID}`}
                          className="text-accent hover:underline"
                          title={t("View placement (replicas / EC shards)")}
                        >{v.ID}</a>
                      ) : (
                        <span className="text-muted" title={t("Cluster unknown — open the volume's cluster to see placement")}>{v.ID}</span>
                      )}
                      <a
                        href={`/volumes/${v.ID}`}
                        className="ml-1 inline-flex items-center text-muted hover:text-accent align-middle"
                        title={t("View read pattern / cohort analytics")}
                      >
                        <Activity size={11}/>
                      </a>
                      {v.IsEC && (
                        <span
                          className="ml-1 badge border-accent/40 text-accent"
                          title={`EC shards: [${(v.Shards ?? []).join(" ")}]`}>
                          EC{v.Shards?.length ? ` ${v.Shards.length}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="text-xs">{v.cluster_name || "—"}</td>
                    <td>{v.Collection || <span className="text-muted">—</span>}</td>
                    <td className="font-mono text-xs text-muted">{v.Server}</td>
                    <td className="text-xs text-muted">{v.Rack || "—"}</td>
                    <td><span className="badge">{v.DiskType || "hdd"}</span></td>
                    <td className="num">{bytes(v.Size)}</td>
                    <td className="text-center align-middle"><Sparkline points={trendByID[String(v.ID)] ?? []}/></td>
                    <td className="num">{v.FileCount.toLocaleString()}</td>
                    <td>{v.ReadOnly ? <span className="text-warning text-xs">●</span> : <span className="text-muted/40 text-xs">○</span>}</td>
                    <td className="text-muted text-xs">{v.ModifiedAtSec ? new Date(v.ModifiedAtSec * 1000).toLocaleString() : "—"}</td>
                    <td><VolumeRowActions v={v as VolumeRowLike} onPick={(a, rows) => setActionDialog({ action: a, rows })}/></td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination {...pg}/>
          </div>
        )}
        {actionDialog && (
          <VolumeActionDialog
            actionKey={actionDialog.action}
            rows={actionDialog.rows}
            onClose={(didRun) => {
              setActionDialog(null);
              if (didRun) {
                setSelectedKeys(new Set());
                mutateVolumes();
              }
            }}
          />
        )}
        {ecEncodeFor && (
          <ECEncodeDialog
            clusterID={ecEncodeFor.clusterID}
            mode="volumes"
            volumeIds={ecEncodeFor.volumeIds}
            initialCollection={ecEncodeFor.collection}
            collections={collections}
            diskTypes={diskTypes}
            sourceVolumes={ecEncodeFor.sourceVolumes}
            volumeIdsByCollection={ecEncodeFor.volumeIdsByCollection}
            allVolumes={all}
            onClose={() => setEcEncodeFor(null)}
            onDone={() => { setSelectedKeys(new Set()); mutateVolumes(); }}
          />
        )}
        {ecDecodeFor && (
          <ECDecodeDialog
            clusterID={ecDecodeFor.clusterID}
            volumeIds={ecDecodeFor.volumeIds}
            diskTypes={diskTypes}
            onClose={() => setEcDecodeFor(null)}
            onDone={() => { setSelectedKeys(new Set()); mutateVolumes(); }}
          />
        )}
        {fixReplFor && (
          <VolumeFixReplicationDialog
            clusterID={fixReplFor}
            collections={collections}
            onClose={() => setFixReplFor(null)}
            onDone={() => mutateVolumes()}
          />
        )}
        {growFor && (
          <VolumeGrowDialog
            clusterID={growFor}
            allVolumes={all}
            onClose={() => setGrowFor(null)}
            onDone={() => mutateVolumes()}
          />
        )}
        {balanceFor && (
          <VolumeBalanceDialog
            clusterID={balanceFor}
            allVolumes={all}
            onClose={() => setBalanceFor(null)}
          />
        )}
        {deleteEmptyFor && (
          <VolumeDeleteEmptyDialog
            clusterID={deleteEmptyFor}
            allVolumes={all}
            onClose={() => setDeleteEmptyFor(null)}
            onDone={() => mutateVolumes()}
          />
        )}
        {vd?.cluster_errors?.length ? (
          <div className="px-4 py-3 border-t border-border/60 text-xs text-warning">
            {vd.cluster_errors.length} cluster(s) failed to respond:
            <ul className="list-disc pl-5 mt-1">
              {vd.cluster_errors.map((e: any, i: number) => (
                <li key={i} className="font-mono">{e.cluster} ({e.master}): {e.error}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* Charts panel. Declared *after* the table so CSS Grid auto-flow
          places it in the same row as the table (col 2) — otherwise
          the aside would land in an earlier row and push the table
          down. col-start-2 placement comes from the parent's arbitrary
          variant; sticky keeps the panel pinned while the operator
          scrolls the table on the left. */}
      {chartsOpen && (
        <aside className="card flex flex-col sticky top-16 max-h-[calc(100vh-5rem)]">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <h2 className="text-sm font-medium inline-flex items-center gap-2">
              <BarChart3 size={14}/> {t("Charts")}
              <span className="text-[11px] text-muted">{shownCount}/{ALL_CHARTS.length}</span>
            </h2>
            <button onClick={toggleDrawer} className="p-1 text-muted hover:text-text" title={t("Close")}>
              <X size={16}/>
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {visible.distribution && (
              <div className="card flex flex-col">
                <header className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-2 min-w-0">
                    <HardDrive size={12}/>
                    <span className="truncate">{t("Distribution")}</span>
                    <span className="text-text normal-case font-normal tracking-normal text-[11px]">· {distMode}</span>
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <div className="inline-flex rounded-md border border-border overflow-hidden">
                      {(["node", "rack", "collection"] as const).map(m => (
                        <button key={m} onClick={() => setDistMode(m)}
                          className={`px-2 py-0.5 text-[10px] transition-colors ${
                            distMode === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                          }`}>
                          {m === "node" ? t("Node") : m === "rack" ? t("Rack") : t("Collection")}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => toggleChart("distribution")} title={t("Hide")} className="p-1 text-muted hover:text-text">
                      <EyeOff size={12}/>
                    </button>
                  </div>
                </header>
                {dist.bars.length === 0 ? (
                  <div className="text-xs text-muted py-10 text-center flex-1">{t("No data.")}</div>
                ) : (
                  <div className="px-2 py-1">
                    {/* The chart used to live above this list, but with
                        >10 nodes the ECharts bars crammed and the list
                        was duplicated below for filtering. Now the list
                        IS the chart — each row carries its own bar so
                        the visual + interaction live together. */}
                    <DistKeyList
                      bars={dist.bars}
                      onPick={filterByDistKey}
                      activeKey={activeDistKey}
                      label={t("Click a row to filter the table on the right.")}
                    />
                  </div>
                )}
              </div>
            )}

            {visible.heatmap && (
              <div className="card flex flex-col">
                <header className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted truncate">
                    {t("7-day Read Heatmap")}
                  </h2>
                  <button onClick={() => toggleChart("heatmap")} title={t("Hide")} className="p-1 text-muted hover:text-text">
                    <EyeOff size={12}/>
                  </button>
                </header>
                {heat.volumes.length === 0 ? (
                  <div className="text-xs text-muted py-10 text-center flex-1">{t("No access events recorded yet — start the collector.")}</div>
                ) : (
                  <div className="px-1 py-1">
                    <ReactECharts style={{ height: COMPACT_CHART_H }} option={{
                      backgroundColor: "transparent",
                      tooltip: { position: "top", formatter: (p: any) => `vol ${heat.volumes[p.data[1]]}<br/>${heat.hours[p.data[0]]}<br/>reads ${p.data[2]}` },
                      grid: { top: 8, left: 44, right: 12, bottom: 36 },
                      xAxis: { type: "category", data: heat.hours, axisLabel: { color: C.textMuted, fontSize: 9, rotate: 45 } },
                      yAxis: { type: "category", data: heat.volumes, axisLabel: { color: C.textMuted, fontSize: 9 } },
                      visualMap: { min: 0, max: heat.max, calculable: false, orient: "horizontal", left: "center", bottom: 0,
                        inRange: { color: ["#1b2030", "#2a4d8f", "#74a4ff", "#ffd166", "#ef476f"] },
                        textStyle: { color: C.textMuted, fontSize: 9 }, itemWidth: 8, itemHeight: 6 },
                      series: [{ type: "heatmap", data: heat.points, progressive: 5000, itemStyle: { borderRadius: 1 } }],
                    }}/>
                  </div>
                )}
              </div>
            )}

            {visible.composition && (
              <div className="card flex flex-col">
                <header className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted truncate">
                    {t("Composition")}
                  </h2>
                  <button onClick={() => toggleChart("composition")} title={t("Hide")} className="p-1 text-muted hover:text-text">
                    <EyeOff size={12}/>
                  </button>
                </header>
                <div className="px-1 py-1">
                  <ReactECharts style={{ height: COMPACT_CHART_H }} option={buildCompositionOption(filtered)}/>
                </div>
              </div>
            )}

            {hiddenCharts.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                <Eye size={12}/>
                <span>{t("Hidden:")}</span>
                {hiddenCharts.map(c => (
                  <button
                    key={c.key}
                    onClick={() => toggleChart(c.key)}
                    className="rounded-full border border-border bg-panel2 px-2 py-0.5 text-[11px] hover:bg-panel hover:text-text transition-colors"
                  >
                    {t(c.label)}
                  </button>
                ))}
              </div>
            )}
            {shownCount === 0 && hiddenCharts.length > 0 && (
              <div className="text-xs text-muted py-6 text-center">
                {t("All charts are hidden. Click a chip above to bring one back.")}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

