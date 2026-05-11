"use client";
import { useVolumes, useHeatmap, useClusters } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { HardDrive, X, Search, Database, Filter, Eye, EyeOff, BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/table-skeleton";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import {
  VolumeRowActions, VolumeBulkBar, VolumeActionDialog, type VolumeRowLike,
} from "@/components/volume-actions";
import { useCluster } from "@/lib/cluster-context";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type ReadFilter = "all" | "writable" | "readonly";
type DistMode = "node" | "rack" | "collection";

// Compact chart row: every card is one fixed height so the three sit on
// one line without one growing taller than the others. Distribution
// caps to the top 10 groups in compact mode; the operator's full list
// is still in the detail table below.
const COMPACT_CHART_H = 260;
const DIST_TOP_N      = 10;

// chart-visibility state lives in localStorage so each operator can
// hide what they don't care about and the choice survives reloads.
const VIS_KEY = "tier.volumes.chart_visible";
type ChartKey = "distribution" | "heatmap" | "composition";
const ALL_CHARTS: { key: ChartKey; label: string }[] = [
  { key: "distribution", label: "Distribution" },
  { key: "heatmap",      label: "7-day Read Heatmap" },
  { key: "composition",  label: "Composition" },
];
function loadVisible(): Record<ChartKey, boolean> {
  const base: Record<ChartKey, boolean> = { distribution: true, heatmap: true, composition: true };
  if (typeof window === "undefined") return base;
  try {
    const raw = localStorage.getItem(VIS_KEY);
    if (!raw) return base;
    return { ...base, ...(JSON.parse(raw) as Partial<Record<ChartKey, boolean>>) };
  } catch {
    return base;
  }
}

// Drawer open/closed lives next to per-chart visibility so the operator
// can leave the drawer closed by default (table-first workflow) and
// open it only when they want a glance at the visuals.
const DRAWER_KEY = "tier.volumes.charts_open";
function loadDrawerOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(DRAWER_KEY) === "1"; } catch { return false; }
}

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

  const filtered = useMemo(() => all.filter(v => {
    if (collection && v.Collection !== collection) return false;
    if (diskType && (v.DiskType || "hdd") !== diskType) return false;
    if (readFilter === "writable" && v.ReadOnly) return false;
    if (readFilter === "readonly" && !v.ReadOnly) return false;
    if (text) {
      const t = text.toLowerCase();
      const hay = `${v.ID} ${v.Collection || ""} ${v.Server || ""} ${v.Rack || ""}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  }), [all, collection, diskType, readFilter, text]);

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
  const toggleDrawer = () => {
    setChartsOpen(o => {
      const next = !o;
      try { localStorage.setItem(DRAWER_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const pg = usePagination(filtered, 50);

  // ---- selection + action dialog state -----------------------------------
  // Selection keys = "<cluster_id>:<id>:<server>" so the same volume on
  // different replicas is selectable independently (volume.delete is
  // node-scoped). Set is rebuilt as a fresh object so React notices.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
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

  const dist = useMemo(() => buildDist(filtered, distMode), [filtered, distMode]);
  const heat = useMemo(() => buildHeatmap(hm?.items || []), [hm]);

  const totalWritable = filtered.filter(v => !v.ReadOnly).length;
  const totalReadOnly = filtered.length - totalWritable;
  const totalBytes = filtered.reduce((s, v) => s + (Number(v.Size) || 0), 0);

  const chips: { key: string; label: string; clear: () => void }[] = [
    clusterID && { key: "cluster", label: (clusters?.items ?? []).find((c: any) => c.id === clusterID)?.name ?? "cluster", clear: () => setClusterID("") },
    collection && { key: "collection", label: collection, clear: () => setCollection("") },
    diskType && { key: "disk", label: diskType, clear: () => setDiskType("") },
    readFilter !== "all" && { key: "read", label: readFilter === "readonly" ? "read-only" : "writable", clear: () => setReadFilter("all") },
    text && { key: "text", label: `"${text}"`, clear: () => setText("") },
  ].filter(Boolean) as any;

  const clearAll = () => { setClusterID(""); setCollection(""); setDiskType(""); setReadFilter("all"); setText(""); };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Volumes")}</h1>
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
              placeholder="id / collection / server / rack"
              className="input w-72 pl-8"
            />
          </div>
          <RefreshButton loading={volumesValidating} onClick={() => Promise.all([mutateVolumes(), mutateHeat()])}/>
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
      <section className="card px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select className="select w-auto py-1 text-xs" value={collection} onChange={e => setCollection(e.target.value)}>
            <option value="">{t("All collections")}</option>
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

      {/* Charts moved into a right-side drawer — the table is the
          primary surface, charts open on demand and stay docked while
          the operator works the list. */}
      {chartsOpen && (
        <aside className="fixed top-0 right-0 z-40 h-screen w-[420px] xl:w-[480px] border-l border-border bg-panel/95 backdrop-blur shadow-2xl flex flex-col">
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
                  <div className="px-1 py-1">
                    <ReactECharts
                      style={{ height: COMPACT_CHART_H }}
                      option={buildDistOption({ ...dist, bars: dist.bars.slice(0, DIST_TOP_N) })}
                    />
                    {dist.bars.length > DIST_TOP_N && (
                      <div className="text-[10px] text-muted text-center pb-1">
                        top {DIST_TOP_N} of {dist.bars.length} — full list in the table below
                      </div>
                    )}
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

            {/* Restore hidden charts inside the drawer so the operator
                doesn't lose access to any of them once collapsed. */}
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

      <VolumeBulkBar
        selected={selectedRows}
        onClear={() => setSelectedKeys(new Set())}
        onPick={(actionKey, rows) => setActionDialog({ action: actionKey, rows })}
      />

      {/* Detail table */}
      <section className="card overflow-hidden">
        {vd === undefined ? (
          <TableSkeleton rows={6} headers={["ID", "Cluster", "Collection", "Server", "Rack", "Disk", "Size", "Files", "R/O", "Modified"]}/>
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
                      <a href={`/volumes/${v.ID}`} className="text-accent hover:underline">{v.ID}</a>
                    </td>
                    <td className="text-xs">{v.cluster_name || "—"}</td>
                    <td>{v.Collection || <span className="text-muted">—</span>}</td>
                    <td className="font-mono text-xs text-muted">{v.Server}</td>
                    <td className="text-xs text-muted">{v.Rack || "—"}</td>
                    <td><span className="badge">{v.DiskType || "hdd"}</span></td>
                    <td className="num">{bytes(v.Size)}</td>
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
    </div>
  );
}

interface Volume {
  ID: number;
  Collection?: string;
  Size: number;
  FileCount: number;
  ReadOnly?: boolean;
  DiskType?: string;
  Server: string;
  Rack?: string;
  DataCenter?: string;
  ModifiedAtSec?: number;
  cluster_id?: string;
  cluster_name?: string;
}

function buildDist(items: Volume[], mode: DistMode) {
  type Agg = { key: string; writable: number; readonly: number; bytes: number; clusters: Set<string> };
  const by = new Map<string, Agg>();
  let readOnly = 0;
  for (const v of items) {
    const key = mode === "rack"
      ? (v.Rack || "(no-rack)")
      : mode === "collection"
        ? (v.Collection || "(default)")
        : (v.Server || "(unknown)");
    let a = by.get(key);
    if (!a) {
      a = { key, writable: 0, readonly: 0, bytes: 0, clusters: new Set<string>() };
      by.set(key, a);
    }
    if (v.ReadOnly) { a.readonly++; readOnly++; } else { a.writable++; }
    a.bytes += Number(v.Size) || 0;
    if (v.cluster_name) a.clusters.add(v.cluster_name);
  }
  const bars = [...by.values()]
    .map(a => ({ ...a, clusters: [...a.clusters] }))
    .sort((a, b) => (b.writable + b.readonly) - (a.writable + a.readonly));
  const byKey = new Map(bars.map(b => [b.key, b]));
  return { bars, byKey, totalGroups: bars.length, readOnly };
}

// Render every group as its own bar. Chart height grows with row count
// (see ROW_H above) so the operator sees the full distribution at once
// instead of dragging a scrollbar inside the chart.
function buildDistOption(dist: ReturnType<typeof buildDist>) {
  return {
    backgroundColor: "transparent",
    grid: { left: 110, right: 12, top: 22, bottom: 8 },
    legend: {
      data: ["Writable", "Read-only"], top: 0, right: 24,
      textStyle: { color: C.textMuted, fontSize: 11 },
      icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 14,
    },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, textStyle: { color: C.text, fontSize: 12 },
      formatter: (params: any) => {
        const name = params[0].name;
        const meta = dist.byKey.get(name);
        const lines = params.map((p: any) =>
          `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${p.value}</b>`,
        ).join("<br/>");
        const sizeLine = meta ? `<br/><span style="color:${C.textMuted}">size: ${bytes(meta.bytes)}</span>` : "";
        const clusterLine = meta?.clusters?.length
          ? `<br/><span style="color:${C.textMuted}">cluster: ${meta.clusters.join(", ")}</span>` : "";
        return `<b>${name}</b><br/>${lines}${sizeLine}${clusterLine}`;
      },
    },
    xAxis: {
      type: "value", axisLabel: { color: C.textMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: C.grid } },
    },
    yAxis: {
      type: "category",
      data: dist.bars.map(b => b.key),
      inverse: true,
      axisLabel: {
        color: C.textMuted, fontSize: 11,
        formatter: (v: string) => v.length > 24 ? "…" + v.slice(-23) : v,
      },
      axisLine: { lineStyle: { color: C.axisLine } },
      axisTick: { show: false },
    },
    series: [
      {
        name: "Writable", type: "bar", stack: "v", barMaxWidth: 18,
        itemStyle: { color: C.accent, borderRadius: [3, 0, 0, 3] },
        emphasis: { focus: "series" },
        data: dist.bars.map(b => b.writable),
        label: { show: true, position: "insideLeft", color: "#eaf2ff", fontSize: 11, fontWeight: 600,
                 formatter: (p: any) => p.value > 0 ? p.value : "" },
      },
      {
        name: "Read-only", type: "bar", stack: "v", barMaxWidth: 18,
        itemStyle: { color: C.warning, borderRadius: [0, 3, 3, 0] },
        emphasis: { focus: "series" },
        data: dist.bars.map(b => b.readonly),
        label: { show: true, position: "insideRight", color: C.textOnWarning, fontSize: 11, fontWeight: 600,
                 formatter: (p: any) => p.value > 0 ? p.value : "" },
      },
    ],
  };
}

function buildCompositionOption(items: Volume[]) {
  const buckets = new Map<string, number>();
  for (const v of items) {
    const k = v.DiskType || "hdd";
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const palette = ["oklch(74% 0.18 230)", "oklch(70% 0.15 60)", "oklch(74% 0.10 270)", "oklch(70% 0.18 30)", "oklch(70% 0.15 150)"];
  const data = [...buckets.entries()].map(([name, value], i) => ({
    name, value, itemStyle: { color: palette[i % palette.length] },
  }));
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      textStyle: { color: C.text, fontSize: 12 },
      formatter: (p: any) => `${p.name}<br/>${p.value} volume(s) (${p.percent}%)`,
    },
    legend: {
      orient: "vertical", left: 8, top: "center",
      textStyle: { color: C.textMuted, fontSize: 10 },
      icon: "roundRect", itemWidth: 8, itemHeight: 8,
    },
    series: [{
      type: "pie", radius: ["50%", "72%"], center: ["62%", "50%"],
      padAngle: 2, itemStyle: { borderRadius: 4, borderColor: "transparent", borderWidth: 0 },
      label: { color: C.text, fontSize: 10, formatter: "{d}%" },
      labelLine: { length: 6, length2: 4 },
      data,
    }],
  };
}

function buildHeatmap(items: { hour: string; volume_id: number; reads: number }[]) {
  const hourSet = new Set<string>(); const volSet = new Set<number>();
  items.forEach(p => { hourSet.add(p.hour.slice(0, 13)); volSet.add(p.volume_id); });
  const hours = [...hourSet].sort();
  const volumes = [...volSet].sort((a, b) => a - b);
  const hourIdx = new Map(hours.map((h, i) => [h, i]));
  const volIdx  = new Map(volumes.map((v, i) => [v, i]));
  let max = 0;
  const points = items.map(p => {
    const x = hourIdx.get(p.hour.slice(0, 13))!; const y = volIdx.get(p.volume_id)!;
    if (p.reads > max) max = p.reads;
    return [x, y, p.reads];
  });
  return { hours, volumes, points, max: max || 1 };
}
