"use client";
// EC overview page.
//
// Data is derived client-side from the existing /api/v1/volumes payload:
// each EC volume produces one row per node, so we fold the rows into a
// logical-volume view (shards_by_node, missing_shards, rp_violations)
// and feed three ECharts panels + a per-volume strip list.

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useVolumes, useClusters } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, axisStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import { Grid3x3, AlertTriangle, ShieldCheck, ShieldAlert, RefreshCw, Scale, Wand2, Undo2 } from "lucide-react";
import { ECEncodeDialog } from "@/components/ec/encode-dialog";
import { ECDecodeDialog } from "@/components/ec/decode-dialog";
import { ECPlanDialog } from "@/components/ec/plan-dialog";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

// Default SeaweedFS EC layout is RS(10+4). Anything more or fewer present
// is highlighted as degraded.
const TOTAL_SHARDS = 14;
const DATA_SHARDS = 10;

interface VolumeRow {
  ID: number;
  Collection?: string;
  Size?: number;
  Server: string;
  Rack?: string;
  DataCenter?: string;
  DiskType?: string;
  IsEC?: boolean;
  Shards?: number[];
  ShardSizes?: number[];
  cluster_id?: string;
  cluster_name?: string;
}

interface LogicalEC {
  key: string;             // `${cluster_id}:${id}`
  id: number;
  collection: string;
  cluster_id?: string;
  cluster_name?: string;
  diskType?: string;
  // shard index → list of nodes holding it (>1 means RP violation)
  shardsByIdx: Map<number, string[]>;
  // node → shard indices held on that node
  shardsByNode: Map<string, number[]>;
  // node → rack
  rackByNode: Map<string, string>;
  // node → dc
  dcByNode: Map<string, string>;
  totalBytes: number;
}

export default function ECPage() {
  const { t } = useT();
  const { clusterID, setClusterID } = useCluster();
  const { data: clusters } = useClusters();
  const { data: vd } = useVolumes(clusterID || undefined);
  const all = (vd?.items || []) as VolumeRow[];
  const ecRows = useMemo(() => all.filter(v => v.IsEC), [all]);

  const [collection, setCollection] = useState<string>("");
  const [planModal, setPlanModal] = useState<null | { kind: "rebuild" | "balance" }>(null);
  const [encodeOpen, setEncodeOpen] = useState(false);
  const [decodeTargets, setDecodeTargets] = useState<number[] | null>(null);
  // EC-only collection list drives the page filter dropdown.
  const collections = useMemo(() => {
    const cs = new Set<string>();
    for (const v of ecRows) if (v.Collection) cs.add(v.Collection);
    return [...cs].sort();
  }, [ecRows]);

  // Cluster-wide lookups (across EC and non-EC volumes) feed the encode /
  // rebuild / balance dialog combo boxes so the operator can pick a
  // collection that exists in the cluster, not only those already EC'd.
  const allCollections = useMemo(() => {
    const cs = new Set<string>();
    for (const v of all) if (v.Collection) cs.add(v.Collection);
    return [...cs].sort();
  }, [all]);
  const allDiskTypes = useMemo(() => {
    const ds = new Set<string>();
    for (const v of all) if (v.DiskType) ds.add(v.DiskType);
    return [...ds].sort();
  }, [all]);
  const allDataCenters = useMemo(() => {
    const ds = new Set<string>();
    for (const v of all) if (v.DataCenter) ds.add(v.DataCenter);
    return [...ds].sort();
  }, [all]);

  // Storage rollup for the encode dialog's size preview. When the user
  // has narrowed the page to one collection we can enumerate the matching
  // non-EC volumes from current state; otherwise we leave it undefined
  // (a regex collection picker matches at run-time and we can't predict).
  const encodeSourceVolumes = useMemo(() => {
    if (!collection) return undefined;
    const byID = new Map<number, { logicalBytes: number; replicaCount: number }>();
    for (const v of all) {
      if (v.IsEC) continue;
      if ((v.Collection || "") !== collection) continue;
      const cur = byID.get(v.ID);
      if (cur) {
        cur.replicaCount += 1;
        // Take the max per-replica size as the logical size — replicas
        // can briefly diverge during a copy and the max is the truthful
        // "amount of data" figure.
        cur.logicalBytes = Math.max(cur.logicalBytes, Number(v.Size) || 0);
      } else {
        byID.set(v.ID, { logicalBytes: Number(v.Size) || 0, replicaCount: 1 });
      }
    }
    return [...byID.values()];
  }, [all, collection]);

  const filtered = useMemo(() => {
    if (!collection) return ecRows;
    return ecRows.filter(v => (v.Collection || "") === collection);
  }, [ecRows, collection]);

  // Build the logical-volume view + per-node / per-rack rollups.
  const { volumes, nodes, racks, dcs } = useMemo(() => buildECView(filtered), [filtered]);

  // KPI roll-ups.
  const totalShards = volumes.reduce(
    (s, v) => s + Array.from(v.shardsByIdx.values()).reduce((a, b) => a + b.length, 0),
    0,
  );
  const degraded = volumes.filter(v => v.shardsByIdx.size < TOTAL_SHARDS);
  const unrecoverable = volumes.filter(v => v.shardsByIdx.size < DATA_SHARDS);
  const rpViolations = volumes.filter(v => (
    [...v.shardsByIdx.values()].some(servers => servers.length > 1)
  ));

  const heatmap = useMemo(() => buildHeatmap(volumes, nodes), [volumes, nodes]);
  // buildNodeBars (vertical ECharts bar) was replaced by the inline
  // NodeLoadList component below — better for >10 nodes since
  // horizontal rows scale by scroll instead of cramping labels.
  const rackStacks = useMemo(() => buildRackStacks(racks, dcs), [racks, dcs]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <Grid3x3 size={16}/> {t("EC overview")}
          </h1>
          <p className="text-xs text-muted mt-1">
            {t("RS(10+4): 10 data + 4 parity shards. Up to 4 shards can be lost before a volume becomes unrecoverable.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={clusterID}
            onChange={(e) => setClusterID(e.target.value)}
            className="select w-auto py-1.5 px-2 text-xs">
            <option value="">{t("All clusters")}</option>
            {(clusters?.items ?? []).map((c: { id: string; name: string }) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className="select w-auto py-1.5 px-2 text-xs">
            <option value="">{t("All collections")}</option>
            {collections.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            className="btn inline-flex items-center gap-1"
            disabled={!clusterID}
            title={clusterID ? "" : t("Pick a single cluster first.")}
            onClick={() => setPlanModal({ kind: "rebuild" })}>
            <RefreshCw size={12}/> rebuild
          </button>
          <button
            className="btn inline-flex items-center gap-1"
            disabled={!clusterID}
            title={clusterID ? "" : t("Pick a single cluster first.")}
            onClick={() => setPlanModal({ kind: "balance" })}>
            <Scale size={12}/> balance
          </button>
          <button
            className="btn btn-primary inline-flex items-center gap-1"
            disabled={!clusterID}
            title={clusterID ? "" : t("Pick a single cluster first.")}
            onClick={() => setEncodeOpen(true)}>
            <Wand2 size={12}/> {t("转 EC")}
          </button>
        </div>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI
          icon={<Grid3x3 size={16}/>}
          label={t("EC volumes")}
          value={volumes.length}
          sub={`${totalShards} ${t("shards total")}`}
        />
        <KPI
          icon={<ShieldCheck size={16}/>}
          label={t("Healthy")}
          value={volumes.length - degraded.length}
          sub={`${pct(volumes.length - degraded.length, volumes.length)}% ${t("of fleet")}`}
        />
        <KPI
          icon={<AlertTriangle size={16}/>}
          label={t("Degraded")}
          value={degraded.length}
          sub={`${unrecoverable.length} ${t("unrecoverable")}`}
          warn={degraded.length > 0}
          danger={unrecoverable.length > 0}
        />
        <KPI
          icon={<ShieldAlert size={16}/>}
          label={t("RP violations")}
          value={rpViolations.length}
          sub={t("same shard on multiple nodes")}
          warn={rpViolations.length > 0}
        />
      </div>

      {volumes.length === 0 ? (
        <div className="card p-8 text-center">
          <Grid3x3 size={32} className="mx-auto text-muted/40 mb-2"/>
          <div className="text-sm text-muted">
            {t("No EC volumes in the current scope.")}
          </div>
          <div className="text-xs text-muted/70 mt-1">
            {t("Run ec.encode in weed shell or wait for the auto-EC worker to encode cold volumes.")}
          </div>
        </div>
      ) : (
        <>
          {/* Heatmap row */}
          <div className="card p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-2 flex items-center gap-2">
              <span>{t("Shard × node heatmap")}</span>
              <Legend items={[
                { color: C.success, label: t("1 shard (normal)") },
                { color: C.warning, label: t(">1 shard (RP violation)") },
                { color: "rgba(255,255,255,0.06)", label: t("0 shards") },
              ]}/>
            </h2>
            <ReactECharts
              style={{ height: Math.min(540, Math.max(220, volumes.length * 18 + 60)) }}
              option={heatmap}
              notMerge={true}
            />
          </div>

          {/* Two charts side-by-side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="card p-3">
              <NodeLoadList nodes={nodes}/>
            </div>
            <div className="card p-3">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-2">
                {t("Shards per rack (by DC)")}
              </h2>
              <ReactECharts style={{ height: 280 }} option={rackStacks} notMerge={true}/>
            </div>
          </div>

          {/* Per-volume 14-segment strip list */}
          <div className="card p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-2">
              {t("Per-volume shard distribution")}
            </h2>
            <ul className="space-y-1.5">
              {volumes.map(v => (
                <VolumeStrip
                  key={v.key}
                  v={v}
                  onDecode={(id) => setDecodeTargets([id])}
                />
              ))}
            </ul>
          </div>
        </>
      )}

      {planModal && clusterID && (
        <ECPlanDialog
          kind={planModal.kind}
          clusterID={clusterID}
          initialCollection={collection}
          collections={allCollections}
          diskTypes={allDiskTypes}
          dataCenters={allDataCenters}
          onClose={() => setPlanModal(null)}
        />
      )}
      {encodeOpen && clusterID && (
        <ECEncodeDialog
          clusterID={clusterID}
          mode="collection"
          initialCollection={collection}
          collections={allCollections}
          diskTypes={allDiskTypes}
          sourceVolumes={encodeSourceVolumes}
          allVolumes={all}
          onClose={() => setEncodeOpen(false)}
        />
      )}
      {decodeTargets && clusterID && (
        <ECDecodeDialog
          clusterID={clusterID}
          volumeIds={decodeTargets}
          diskTypes={allDiskTypes}
          onClose={() => setDecodeTargets(null)}
        />
      )}
    </div>
  );
}

// ───────── helpers ─────────

function pct(n: number, total: number): string {
  if (!total) return "0";
  return ((n / total) * 100).toFixed(1);
}

function KPI({
  icon, label, value, sub, warn, danger,
}: {
  icon: React.ReactNode; label: string; value: number | string; sub?: string;
  warn?: boolean; danger?: boolean;
}) {
  const accent = danger ? "text-danger" : warn ? "text-warning" : "text-accent";
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted">
        <span className={accent}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={`text-2xl font-semibold mt-1 ${danger ? "text-danger" : warn ? "text-warning" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <span className="inline-flex flex-wrap gap-3 ml-2 normal-case font-normal text-muted">
      {items.map(it => (
        <span key={it.label} className="inline-flex items-center gap-1 text-[10px]">
          <span style={{ background: it.color, width: 8, height: 8, borderRadius: 2 }}/>
          {it.label}
        </span>
      ))}
    </span>
  );
}

// Per-volume 14-segment strip. Each segment colored:
//   green  = shard exists on exactly one node
//   amber  = shard exists on >1 node (RP violation)
//   red    = shard missing
function VolumeStrip({ v, onDecode }: { v: LogicalEC; onDecode?: (id: number) => void }) {
  const { t } = useT();
  const present = v.shardsByIdx.size;
  const missing = TOTAL_SHARDS - present;
  const unrecoverable = present < DATA_SHARDS;
  const statusBadge = unrecoverable
    ? <span className="badge border-danger/40 text-danger">{t("UNRECOVERABLE")}</span>
    : missing > 0
    ? <span className="badge border-warning/40 text-warning">{t("Degraded")} {present}/{TOTAL_SHARDS}</span>
    : <span className="badge border-success/40 text-success">{present}/{TOTAL_SHARDS}</span>;

  return (
    <li className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-bg/40">
      <a href={`/volumes/${v.id}`} className="font-mono text-xs text-accent hover:underline w-16 shrink-0">
        {v.id}
      </a>
      <div className="text-xs text-muted truncate w-32 shrink-0">{v.collection || "—"}</div>
      <div className="flex gap-0.5 shrink-0">
        {Array.from({ length: TOTAL_SHARDS }, (_, i) => {
          const owners = v.shardsByIdx.get(i) || [];
          const color = owners.length === 0
            ? "var(--color-border, rgba(255,255,255,0.08))"
            : owners.length > 1
            ? C.warning
            : C.success;
          const title = owners.length === 0
            ? `${t("Shard")} ${i}: ${t("missing")}`
            : `${t("Shard")} ${i}: ${owners.join(", ")}`;
          return (
            <span
              key={i}
              title={title}
              style={{
                background: color, width: 14, height: 14,
                borderRadius: 2, display: "inline-block",
              }}
            />
          );
        })}
      </div>
      <div className="flex-1"/>
      <div className="text-xs text-muted shrink-0">{bytes(v.totalBytes)}</div>
      {v.diskType && <span className="badge shrink-0">{v.diskType}</span>}
      {statusBadge}
      {onDecode && (
        <button
          className="btn inline-flex items-center gap-1 shrink-0"
          onClick={() => onDecode(v.id)}
          title={t("Decode this EC volume back to a normal volume")}>
          <Undo2 size={11}/> {t("Decode")}
        </button>
      )}
    </li>
  );
}

// ───────── client-side aggregation ─────────

function buildECView(rows: VolumeRow[]) {
  const volumes = new Map<string, LogicalEC>();
  const nodeCount = new Map<string, number>();          // node → shard count
  const nodeRack = new Map<string, string>();           // node → rack
  const nodeDC = new Map<string, string>();             // node → dc
  const rackCount = new Map<string, number>();          // "dc/rack" → shards
  const dcSet = new Set<string>();

  for (const r of rows) {
    if (!r.IsEC) continue;
    const key = `${r.cluster_id || ""}:${r.ID}`;
    let lv = volumes.get(key);
    if (!lv) {
      lv = {
        key, id: r.ID, collection: r.Collection || "",
        cluster_id: r.cluster_id, cluster_name: r.cluster_name,
        diskType: r.DiskType,
        shardsByIdx: new Map(),
        shardsByNode: new Map(),
        rackByNode: new Map(),
        dcByNode: new Map(),
        totalBytes: 0,
      };
      volumes.set(key, lv);
    }
    const shards = r.Shards || [];
    lv.shardsByNode.set(r.Server, shards);
    if (r.Rack) lv.rackByNode.set(r.Server, r.Rack);
    if (r.DataCenter) lv.dcByNode.set(r.Server, r.DataCenter);
    lv.totalBytes += Number(r.Size) || 0;

    for (const idx of shards) {
      const owners = lv.shardsByIdx.get(idx) || [];
      owners.push(r.Server);
      lv.shardsByIdx.set(idx, owners);
    }

    nodeCount.set(r.Server, (nodeCount.get(r.Server) || 0) + shards.length);
    if (r.Rack) {
      nodeRack.set(r.Server, r.Rack);
      const rk = `${r.DataCenter || "?"}/${r.Rack}`;
      rackCount.set(rk, (rackCount.get(rk) || 0) + shards.length);
    }
    if (r.DataCenter) {
      nodeDC.set(r.Server, r.DataCenter);
      dcSet.add(r.DataCenter);
    }
  }

  const nodes = [...nodeCount.entries()]
    .map(([node, count]) => ({
      node,
      count,
      rack: nodeRack.get(node) || "",
      dc: nodeDC.get(node) || "",
    }))
    .sort((a, b) => b.count - a.count);

  const racks = [...rackCount.entries()]
    .map(([k, count]) => {
      const [dc, rack] = k.split("/");
      return { dc, rack, count };
    })
    .sort((a, b) => a.dc.localeCompare(b.dc) || a.rack.localeCompare(b.rack));

  const dcs = [...dcSet].sort();

  return {
    volumes: [...volumes.values()].sort((a, b) => a.id - b.id),
    nodes,
    racks,
    dcs,
  };
}

// ───────── ECharts option builders ─────────

function buildHeatmap(
  volumes: LogicalEC[],
  nodes: { node: string; count: number }[],
) {
  const yLabels = volumes.map(v => `${v.id}`);
  const xLabels = nodes.map(n => shortenServer(n.node));
  // value tuple: [xIdx, yIdx, shardCount]
  const data: [number, number, number][] = [];
  let maxCount = 1;
  for (let y = 0; y < volumes.length; y++) {
    const v = volumes[y];
    for (let x = 0; x < nodes.length; x++) {
      const n = nodes[x];
      const shards = v.shardsByNode.get(n.node) || [];
      if (shards.length > 0) {
        data.push([x, y, shards.length]);
        if (shards.length > maxCount) maxCount = shards.length;
      }
    }
  }
  return {
    backgroundColor: "transparent",
    grid: { left: 50, right: 16, top: 24, bottom: 60, containLabel: true },
    tooltip: {
      ...tooltipStyle,
      formatter: (p: { value: [number, number, number] }) => {
        const [x, y, n] = p.value;
        const vol = volumes[y];
        const nd = nodes[x];
        const shards = vol.shardsByNode.get(nd.node) || [];
        return [
          `<b>${t0("Volume")} ${vol.id}</b> · ${vol.collection || "—"}`,
          `${t0("Node")}: <code>${nd.node}</code>`,
          `${t0("Shards")} (${n}): [${shards.join(" ")}]`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: xLabels,
      axisLabel: { ...axisStyle.label, rotate: 35, interval: 0, fontSize: 9 },
      axisLine: axisStyle.line,
      axisTick: axisStyle.tick,
      splitArea: { show: false },
    },
    yAxis: {
      type: "category",
      data: yLabels,
      axisLabel: { ...axisStyle.label, fontSize: 9 },
      axisLine: axisStyle.line,
      axisTick: axisStyle.tick,
      splitArea: { show: false },
    },
    visualMap: {
      min: 1,
      max: Math.max(2, maxCount),
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: C.textMuted, fontSize: 10 },
      inRange: { color: [C.success, C.warning, C.danger] },
      pieces: maxCount > 1 ? undefined : [{ min: 1, max: 1, color: C.success }],
      calculable: maxCount > 1,
    },
    series: [{
      type: "heatmap",
      data,
      itemStyle: { borderColor: "rgba(0,0,0,0.4)", borderWidth: 1 },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,0.5)" } },
    }],
  };
}

// buildNodeBars was removed — see NodeLoadList at the bottom of this
// file for the replacement (horizontal sortable bar list).

function buildRackStacks(
  racks: { dc: string; rack: string; count: number }[],
  dcs: string[],
) {
  // x-axis = rack label, one stacked series per DC so racks group naturally.
  const rackLabels = racks.map(r => r.rack || "—");
  const series = dcs.map((dc, i) => ({
    name: dc || "—",
    type: "bar" as const,
    stack: "ec",
    barMaxWidth: 18,
    itemStyle: { color: C.series[i % C.series.length] },
    data: racks.map(r => (r.dc === dc ? r.count : 0)),
  }));
  return {
    backgroundColor: "transparent",
    grid: { left: 16, right: 16, top: 30, bottom: 50, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { ...legendStyle, top: 0 },
    xAxis: {
      type: "category", data: rackLabels,
      axisLabel: { ...axisStyle.label, rotate: 30, interval: 0 },
      axisLine: axisStyle.line, axisTick: axisStyle.tick,
    },
    yAxis: {
      type: "value", axisLabel: axisStyle.label,
      axisLine: axisStyle.line, splitLine: axisStyle.split,
    },
    series,
  };
}

// Drop everything before the last `/` for a docker DNS like
// `seaweed-volume-2.svc/10.0.0.2:8080`. Falls through otherwise.
function shortenServer(s: string): string {
  const slash = s.lastIndexOf("/");
  const stripped = slash >= 0 ? s.slice(slash + 1) : s;
  return stripped.length > 18 ? stripped.slice(0, 16) + "…" : stripped;
}

// Tooltip formatters are called outside React, so they can't call useT().
// These two pre-rendered English strings stand in until we thread the
// translator down (see /volumes/balance for the same pattern).
function t0(s: string) { return s; }

// NodeLoadList replaces the original vertical bar chart with a sortable
// horizontal-bar list. Why: rotated x-axis labels stop being legible past
// ~12 nodes, and a clustered group of 18-px bars looks crowded. A
// vertical list scales — each node gets a full readable row, and the
// container scrolls when there are too many.
//
// Visual rules:
//  - Rows sorted by shard count (default desc); operator can flip to
//    asc or by name.
//  - Bar fill is proportional to maxCount, capped at 100% so a single
//    over-loaded node doesn't flatten everyone else.
//  - Color: red if >1.5×avg, amber if >1.2×avg, otherwise accent —
//    same thresholds the old chart used, but applied in CSS so they
//    auto-adapt to theme via Tailwind utility classes.
//  - Mean line is a thin vertical guide at avg/maxCount × 100% so the
//    operator can read "balanced vs skewed" at a glance.
function NodeLoadList({
  nodes,
}: {
  nodes: Array<{ node: string; count: number; rack: string; dc?: string }>;
}) {
  const { t } = useT();
  const [sortMode, setSortMode] = useState<"count-desc" | "count-asc" | "name">("count-desc");
  const ordered = useMemo(() => {
    const arr = nodes.slice();
    if (sortMode === "count-desc") arr.sort((a, b) => b.count - a.count);
    else if (sortMode === "count-asc") arr.sort((a, b) => a.count - b.count);
    else arr.sort((a, b) => a.node.localeCompare(b.node));
    return arr;
  }, [nodes, sortMode]);
  const counts = nodes.map(n => n.count);
  const max = counts.reduce((m, c) => Math.max(m, c), 0);
  const total = counts.reduce((s, c) => s + c, 0);
  const avg = nodes.length > 0 ? total / nodes.length : 0;
  const meanPct = max > 0 ? (avg / max) * 100 : 0;

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {t("Shards per node")}
          <span className="ml-2 normal-case tracking-normal text-muted/60">
            · {nodes.length} {t("nodes")} · {t("avg")} {avg.toFixed(1)}
          </span>
        </h2>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
          className="bg-panel2 border border-border rounded text-[11px] px-1.5 py-0.5 text-muted hover:text-text"
          aria-label={t("Sort by")}
        >
          <option value="count-desc">{t("Shards (high → low)")}</option>
          <option value="count-asc">{t("Shards (low → high)")}</option>
          <option value="name">{t("Node name")}</option>
        </select>
      </div>

      {nodes.length === 0 ? (
        <p className="text-xs text-muted text-center py-6">{t("No nodes match the current filter.")}</p>
      ) : (
        <div className="relative max-h-[280px] overflow-y-auto pr-1">
          {/* Mean guide line — absolute over the whole list so it reads
              as a single reference even when scrolling. Skipped when
              there's only one node (no meaningful average). */}
          {nodes.length > 1 && meanPct > 0 && (
            <div
              aria-hidden
              className="absolute top-0 bottom-0 w-px bg-muted/40 pointer-events-none z-10"
              // 6.5rem = label column (24 ch * 0.55em ≈ ~12rem actually; we use
              // a fixed grid below so the bar track starts at 11rem from the
              // left of THIS container — see layout below).
              style={{ left: `calc(11.5rem + ${meanPct}% * (100% - 11.5rem) / 100)` }}
              title={`${t("Average")}: ${avg.toFixed(1)}`}
            />
          )}
          <ul className="space-y-0.5">
            {ordered.map((n) => {
              const pct = max > 0 ? (n.count / max) * 100 : 0;
              const hot = avg > 0 && n.count > avg * 1.5;
              const warm = !hot && avg > 0 && n.count > avg * 1.2;
              const barClass = hot
                ? "bg-danger/80"
                : warm
                  ? "bg-warning/80"
                  : "bg-accent/80";
              return (
                <li
                  key={n.node}
                  className="grid items-center gap-2 text-[11px] py-1 hover:bg-panel2/60 rounded px-1.5 group"
                  style={{ gridTemplateColumns: "11rem 1fr 3rem" }}
                  title={`${n.node}${n.rack ? `\nrack: ${n.rack}` : ""}${n.dc ? `\ndc: ${n.dc}` : ""}`}
                >
                  <span className="font-mono truncate text-muted group-hover:text-text">
                    {shortenServer(n.node)}
                  </span>
                  <div className="relative h-2 bg-panel2 rounded overflow-hidden">
                    <div
                      className={`absolute inset-y-0 left-0 ${barClass} rounded transition-[width] duration-300`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`tabular-nums text-right font-mono ${hot ? "text-danger" : warm ? "text-warning" : "text-text"}`}>
                    {n.count}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
