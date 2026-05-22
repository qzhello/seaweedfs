// Pure data-shaping helpers for the volume page's chart drawer.
// Kept out of the React component file so page.tsx stays focused on
// state + layout, and so unit tests don't need a JSX renderer.

import { chartColors as C } from "@/lib/chart-theme";
import type { Volume, DistMode } from "./types";

// buildDist aggregates volume rows into (key, writable, readonly,
// bytes, clusters) tuples keyed by node / rack / collection. The
// returned `bars` are sorted by total volume count descending so the
// busiest groups appear first.
export function buildDist(items: Volume[], mode: DistMode) {
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

// buildCompositionOption — ECharts pie config for the disk-type
// breakdown. Palette picks distinct hues so adjacent slices read
// cleanly at glance.
// Returns `any` because ECharts options are huge and not worth
// type-annotating just to ship.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildCompositionOption(items: Volume[]): any {
  const buckets = new Map<string, number>();
  for (const v of items) {
    const k = v.DiskType || "hdd";
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const palette = ["#3b9eff", "#eab308", "#a78bfa", "#ef4444", "#22c55e"];
  const data = [...buckets.entries()].map(([name, value], i) => ({
    name, value, itemStyle: { color: palette[i % palette.length] },
  }));
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      textStyle: { color: C.text, fontSize: 12 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// buildHeatmap reshapes /heatmap rows into the (hours[], volumes[],
// points[][3], max) bag the ECharts heatmap series consumes. Hours
// are truncated to YYYY-MM-DDTHH so a single bucket is one cell.
export function buildHeatmap(items: { hour: string; volume_id: number; reads: number }[]) {
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
