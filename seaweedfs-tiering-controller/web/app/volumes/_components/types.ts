// Volume row shape returned by /volumes. Field names are
// PascalCase to mirror the Go server tags so we don't waste cycles
// renaming. cluster_id / cluster_name are the lone exceptions —
// they're added by the controller for cross-cluster fan-out.
export interface Volume {
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
  IsEC?: boolean;
  Shards?: number[];
  ShardSizes?: number[];
  cluster_id?: string;
  cluster_name?: string;
}

export type ReadFilter = "all" | "writable" | "readonly";
export type ECFilter = "all" | "ec" | "normal";
export type DistMode = "node" | "rack" | "collection";
export type ChartKey = "distribution" | "heatmap" | "composition";

// Compact chart row: every card is one fixed height so the three sit
// on one line without one growing taller than the others.
export const COMPACT_CHART_H = 260;

export const ALL_CHARTS: { key: ChartKey; label: string }[] = [
  { key: "distribution", label: "Distribution" },
  { key: "heatmap",      label: "7-day Read Heatmap" },
  { key: "composition",  label: "Composition" },
];

// Chart-visibility state lives in localStorage so each operator can
// hide what they don't care about and the choice survives reloads.
export const VIS_KEY = "tier.volumes.chart_visible";
export const DRAWER_KEY = "tier.volumes.charts_open";

export function loadVisible(): Record<ChartKey, boolean> {
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

export function loadDrawerOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(DRAWER_KEY) === "1"; } catch { return false; }
}
