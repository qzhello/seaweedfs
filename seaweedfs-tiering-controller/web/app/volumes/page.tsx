"use client";
import { useVolumes, useHeatmap, useClusters } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { HardDrive, X, Search, Database, Filter } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/table-skeleton";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import {
  VolumeRowActions, VolumeBulkBar, VolumeActionDialog, type VolumeRowLike,
} from "@/components/volume-actions";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type ReadFilter = "all" | "writable" | "readonly";
type DistMode = "node" | "rack" | "collection";

// Bar chart sizing: render every row at a comfortable height so the user can
// see all groups at a glance instead of scrolling a cramped 280px viewport.
const ROW_H = 28;
const CHART_PAD = 64;   // top + bottom (legend + axis breathing room)
const MIN_CHART_H = 180;
const MAX_CHART_H = 700; // safety cap for clusters with hundreds of nodes

export default function VolumesPage() {
  const { t } = useT();
  const { data: clusters } = useClusters();

  const [clusterID, setClusterID] = useState<string>("");
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
        </div>
      </header>

      {/* Compact filter strip — single row on desktop, wraps on mobile */}
      <section className="card px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select className="select w-auto py-1 text-xs" value={clusterID} onChange={e => setClusterID(e.target.value)}>
            <option value="">{t("All clusters")}</option>
            {(clusters?.items ?? []).map((c: any) => (
              <option key={c.id} value={c.id} disabled={c.enabled === false}>
                {c.name}{c.enabled === false ? " (off)" : ""}
              </option>
            ))}
          </select>
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

      {/* Distribution chart — compact, with mode switcher in the title bar */}
      <section className="card">
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-2">
            <HardDrive size={12}/> {t("Distribution")}
            <span className="text-text normal-case font-normal tracking-normal">
              by {distMode}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-muted">
              {dist.totalGroups} {distMode}{dist.totalGroups === 1 ? "" : "s"}
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(["node", "rack", "collection"] as const).map(m => (
                <button key={m} onClick={() => setDistMode(m)}
                  className={`px-2.5 py-1 text-[11px] transition-colors ${
                    distMode === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                  }`}>
                  {m === "node" ? t("Node") : m === "rack" ? t("Rack") : t("Collection")}
                </button>
              ))}
            </div>
          </div>
        </header>
        {dist.bars.length === 0 ? (
          <div className="text-sm text-muted py-10 text-center">No volumes match the current filter.</div>
        ) : (
          <div className="px-2 py-2">
            <ReactECharts
              style={{ height: Math.min(MAX_CHART_H, Math.max(MIN_CHART_H, dist.bars.length * ROW_H + CHART_PAD)) }}
              option={buildDistOption(dist)}
            />
          </div>
        )}
      </section>

      {/* Two-column lower section on desktop: heatmap | summary */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card lg:col-span-2">
          <header className="px-4 py-2.5 border-b border-border/60">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted">
              {t("7-day Read Heatmap")}
            </h2>
          </header>
          {heat.volumes.length === 0 ? (
            <div className="text-sm text-muted py-10 text-center">{t("No access events recorded yet — start the collector.")}</div>
          ) : (
            <div className="px-2 py-2">
              <ReactECharts style={{ height: 280 }} option={{
                backgroundColor: "transparent",
                tooltip: { position: "top", formatter: (p: any) => `vol ${heat.volumes[p.data[1]]}<br/>${heat.hours[p.data[0]]}<br/>reads ${p.data[2]}` },
                grid: { top: 10, left: 50, right: 20, bottom: 50 },
                xAxis: { type: "category", data: heat.hours, axisLabel: { color: C.textMuted, fontSize: 11, rotate: 45 } },
                yAxis: { type: "category", data: heat.volumes, axisLabel: { color: C.textMuted, fontSize: 11 } },
                visualMap: { min: 0, max: heat.max, calculable: true, orient: "horizontal", left: "center", bottom: 0,
                  inRange: { color: ["#1b2030", "#2a4d8f", "#74a4ff", "#ffd166", "#ef476f"] },
                  textStyle: { color: C.textMuted, fontSize: 10 } },
                series: [{ type: "heatmap", data: heat.points, progressive: 5000, itemStyle: { borderRadius: 1 } }],
              }}/>
            </div>
          )}
        </div>

        {/* At-a-glance composition pie */}
        <div className="card">
          <header className="px-4 py-2.5 border-b border-border/60">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted">
              {t("Composition")}
            </h2>
          </header>
          <div className="px-3 py-2">
            <ReactECharts style={{ height: 280 }} option={buildCompositionOption(filtered)}/>
          </div>
        </div>
      </section>

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
    grid: { left: 180, right: 24, top: 28, bottom: 8 },
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
