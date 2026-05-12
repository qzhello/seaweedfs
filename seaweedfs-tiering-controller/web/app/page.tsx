"use client";
import { useSummary, useTasks, useTrend, useTrendByDomain, useClusters, useHolidays, useHealthGate, useSafetyStatus, useClusterPressure, useVolumes, useClusterDisk, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import { Activity, Database, Flame, Snowflake, Zap, RefreshCw, ShieldAlert, ShieldCheck, Server, Lock, HardDrive, X, Layout } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { TrendChart } from "@/components/trend-chart";
import { SortableRow, type SortableItem } from "@/components/sortable-row";
import { resetAllOrders } from "@/lib/dashboard-layout";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export default function Dashboard() {
  const { t } = useT();
  const { data: s, mutate } = useSummary();
  const { data: pending } = useTasks("pending");
  const { data: clusters } = useClusters();
  const { data: holidays } = useHolidays();
  const { data: gate }     = useHealthGate();
  const { data: safety }   = useSafetyStatus();
  const { data: pressure } = useClusterPressure();
  const [range, setRange] = useState<"1d"|"7d"|"30d">("7d");
  const { data: trend } = useTrend(range);
  const { data: trendDomain } = useTrendByDomain(range);
  const [running, setRunning] = useState(false);
  const [scoreToast, setScoreToast] = useState<string | null>(null);
  // "" = all clusters; otherwise cluster.id. Persisted in localStorage so
  // the operator's pick survives reloads without server state.
  //
  // SSR note: we MUST start as "" on both server and first client render to
  // avoid React hydration mismatch — the Run-scoring button label, the
  // <select> value, and several other strings depend on this state. Once
  // hydration finishes, useEffect reads the persisted value.
  const [scopeCluster, setScopeCluster] = useState<string>("");
  useEffect(() => {
    const v = localStorage.getItem("tier.scoring.cluster");
    if (v) setScopeCluster(v);
  }, []);
  const onScopeChange = (v: string) => {
    setScopeCluster(v);
    if (v) localStorage.setItem("tier.scoring.cluster", v);
    else localStorage.removeItem("tier.scoring.cluster");
  };

  const total = s?.bytes_total || 0;
  const tiers = [
    { name: t("Hot (SSD/NVMe)"),  value: s?.bytes_hot  || 0, color: "oklch(74% 0.18 30)"  },
    { name: t("Warm (HDD/EC)"),   value: s?.bytes_warm || 0, color: "oklch(74% 0.18 230)" },
    { name: t("Cold (Cloud)"),    value: s?.bytes_cold || 0, color: "oklch(74% 0.10 270)" },
  ];

  // Per-node distribution. Sourced from the same /volumes payload (which also
  // carries node disk stats); scoped to the cluster picker so the chart
  // matches whatever is being scored.
  const { data: volumesData } = useVolumes(scopeCluster || undefined);
  // Real physical disk usage (only when a single cluster is picked — the
  // /disk endpoint is per-cluster). Falls back to slot-based estimate
  // in the gauge when not available.
  const { data: diskUsage } = useClusterDisk(scopeCluster || undefined);
  const [distMode, setDistMode] = useState<"node" | "rack">("node");
  const [distMetric, setDistMetric] = useState<"count" | "size" | "usage">("count");
  const nodes = useMemo(
    () => buildNodeDist(volumesData?.items || [], distMode),
    [volumesData, distMode],
  );
  const nodeStats = useMemo(
    () => buildNodeStats(volumesData?.nodes || [], distMode),
    [volumesData, distMode],
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight">{t("Storage Tiering Overview")}</h1>
          <p className="text-sm text-muted">
            {t("AI provider:")} <span className="text-accent">{s?.ai_provider ?? "—"}</span>
            {" · "}{clusters?.items?.length ?? 0} {t("clusters_lc")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {safety?.safety_code === "emergency_stop" && (
            <Link href="/safety" className="badge border-danger/40 text-danger animate-pulse">
              <Lock size={12}/> {t("EMERGENCY STOP")}
            </Link>
          )}
          {gate && !gate.ok && (
            <Link href="/health" className="badge border-danger/40 text-danger" title={gate.reason}>
              <ShieldAlert size={12}/> {t("Gate CLOSED")}
            </Link>
          )}
          {gate?.ok && safety?.overall_allowed && (
            <span className="badge border-success/40 text-success">
              <ShieldCheck size={12}/> {t("all-clear")}
            </span>
          )}
          {(pressure?.items?.length ?? 0) > 0 && (
            <PressurePill data={pressure}/>
          )}
          {holidays?.freeze_active && (
            <div className="badge border-warning/40 text-warning">
              <ShieldAlert size={12}/> {t("Freeze:")} {holidays.freeze_holiday}
            </div>
          )}
          <div className="flex gap-1">
            {(["1d","7d","30d"] as const).map(r => (
              <button key={r} className={`btn ${range===r?"btn-primary":""}`} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
          {scoreToast && (
            <div className="absolute right-8 top-20 z-30 max-w-md card p-4 border-accent/40 bg-panel shadow-soft">
              <div className="flex items-start gap-2">
                <RefreshCw size={14} className="text-accent mt-0.5"/>
                <div className="flex-1 text-sm whitespace-pre-line">{scoreToast}</div>
                <button aria-label="Dismiss" className="text-muted hover:text-text" onClick={() => setScoreToast(null)}><X size={14}/></button>
              </div>
            </div>
          )}
          <select
            value={scopeCluster}
            onChange={(e) => onScopeChange(e.target.value)}
            className="select w-auto px-2 py-1.5 text-xs"
            title="Pick a cluster to scope scoring; defaults to all">
            <option value="">{t("All clusters")}</option>
            {(clusters?.items ?? []).map((c: { id: string; name: string; business_domain?: string; enabled?: boolean }) => (
              <option key={c.id} value={c.id} disabled={c.enabled === false}>
                {c.name}{c.business_domain ? ` · ${c.business_domain}` : ""}{c.enabled === false ? " (disabled)" : ""}
              </option>
            ))}
          </select>
          <button
            className="btn inline-flex items-center gap-1 text-muted hover:text-text"
            title={t("Reset layout")}
            onClick={() => {
              resetAllOrders();
              // Quick way to re-mount the rows so they pick up the cleared
              // localStorage — bump the dashboard layout version.
              window.location.reload();
            }}>
            <Layout size={13}/>
          </button>
          <button className="btn btn-primary" disabled={running}
            onClick={async () => {
              setRunning(true); setScoreToast(null);
              try {
                const res = await api.scoreNow(scopeCluster || undefined) as { ok?: boolean; report?: ScoreReport; error?: string };
                await mutate();
                setScoreToast(formatScoreReport(res, t));
              } catch (e) {
                setScoreToast(`Error: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setRunning(false);
              }
            }}>
            <RefreshCw size={14} className={running ? "animate-spin" : ""} />
            {scopeCluster ? t("Scan selected cluster") : t("Run scoring")}
          </button>
        </div>
      </header>

      {/* KPI cards — each item carries a stable id so the operator's
          drag-and-drop order survives reloads. `visible` toggles a card
          off without touching the saved order, so the layout returns
          intact when the condition flips back. */}
      <SortableRow
        rowKey="kpis"
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
        items={(() => {
          const kpiItems: SortableItem[] = [
            {
              id: "clusters",
              visible: !scopeCluster,
              node: <Stat href="/clusters" icon={<Server size={18}/>} label={t("Clusters")} value={clusters?.items?.length ?? 0}/>,
            },
            {
              id: "volumes",
              node: nodeStats.maxSlots > 0 ? (
                <StatGauge
                  href="/volumes"
                  icon={<Database size={18} />}
                  label={t("Volumes")}
                  value={s?.volumes_total ?? nodeStats.usedSlots}
                  used={Number(s?.volumes_total ?? nodeStats.usedSlots) || 0}
                  max={nodeStats.maxSlots}
                  subLabel={t("slots")}
                />
              ) : (
                <Stat href="/volumes" icon={<Database size={18} />} label={t("Volumes")} value={s?.volumes_total ?? "—"} />
              ),
            },
            {
              id: "total_size",
              node: diskUsage && Number(diskUsage.total_bytes) > 0 ? (
                <StatGauge
                  href="/volumes"
                  icon={<Activity size={18} />}
                  label={t("Total Size")}
                  value={bytes(Number(diskUsage.used_bytes) || 0)}
                  used={Number(diskUsage.used_bytes) || 0}
                  max={Number(diskUsage.total_bytes) || 0}
                  subLabel=""
                  formatUnit={bytes}
                />
              ) : (
                <StatGauge
                  href="/volumes"
                  icon={<Activity size={18} />}
                  label={t("Total Size")}
                  value={bytes(total)}
                  used={nodeStats.usedSlots}
                  max={nodeStats.maxSlots}
                  subLabel={t("slots")}
                />
              ),
            },
            {
              id: "free_headroom",
              visible: !!(diskUsage && Number(diskUsage.total_bytes) > 0),
              node: (
                <Stat
                  href="/clusters"
                  icon={<HardDrive size={18}/>}
                  label={t("Free headroom")}
                  value={bytes(Number(diskUsage?.free_bytes) || 0)}
                  sub={`${((Number(diskUsage?.free_bytes ?? 0) / Math.max(1, Number(diskUsage?.total_bytes ?? 1))) * 100).toFixed(1)}% ${t("free")}`}
                />
              ),
            },
            {
              id: "readonly",
              visible: nodes.readOnly > 0,
              node: (
                <Stat
                  href="/volumes?readonly=1"
                  icon={<Lock size={18}/>}
                  label={t("Read-only")}
                  value={nodes.readOnly}
                  sub={`${nodes.totalVolumes ? ((nodes.readOnly / nodes.totalVolumes) * 100).toFixed(1) : 0}% ${t("of fleet")}`}
                />
              ),
            },
            {
              id: "pending",
              node: (
                <Stat href="/tasks" icon={<Flame size={18} />} label={t("Pending")}
                      value={pending?.items?.length ?? 0}
                      sub={`${pending?.items?.filter((p:any)=>p.score>=0.75).length ?? 0} ${t("hot recs")}`}/>
              ),
            },
            {
              id: "saving",
              node: (
                <Stat href="/executions" icon={<Snowflake size={18}/>} label={t("Saving est.")}
                      value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)} sub={t("vs. 3-replica baseline")} />
              ),
            },
          ];
          return kpiItems;
        })()}
      />

      {/* Compact 4-column chart row — same drag-and-drop machinery as the
          KPI row above. Items follow the same `id / visible / node`
          shape so reordering and persistence are uniform. */}
      <SortableRow
        rowKey="charts"
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3"
        items={(() => {
          const chartItems: SortableItem[] = [
            {
              id: "tier_distribution",
              node: (
                <div className="card p-3">
                  <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-1">
                    {t("Tier Distribution")}
                  </h2>
                  <ReactECharts style={{ height: 170 }} option={{
                    backgroundColor: "transparent",
                    tooltip: { trigger: "item", formatter: (p: any) => `${p.name}<br/>${bytes(p.value)} (${p.percent}%)` },
                    legend: {
                      orient: "vertical", left: 4, top: "center",
                      textStyle: { color: C.textMuted, fontSize: 9 },
                      icon: "roundRect", itemWidth: 6, itemHeight: 6, itemGap: 4,
                    },
                    series: [{
                      type: "pie", radius: ["48%", "72%"], center: ["66%", "50%"],
                      padAngle: 2, itemStyle: { borderRadius: 4 },
                      label: { color: C.text, fontSize: 9, formatter: (p: any) => p.percent >= 8 ? `${p.percent}%` : "" },
                      labelLine: { show: false },
                      data: tiers.map(t => ({ name: t.name, value: t.value, itemStyle: { color: t.color } })),
                    }],
                  }}/>
                </div>
              ),
            },
            {
              id: "top_recommendations",
              node: (
                <div className="card p-3 flex flex-col">
                  <header className="flex items-center justify-between mb-1">
                    <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted inline-flex items-center gap-1">
                      <Zap size={10}/> {t("Top recommendations")}
                    </h2>
                    {pending?.items?.length ? (
                      <a href="/tasks" className="text-[10px] text-muted hover:text-accent">{t("Details")}</a>
                    ) : null}
                  </header>
                  {/* Fixed-height body so this panel lines up with the
                      sibling chart cards (all 170px tall). Scrolls when
                      there are more recs than fit; centers the empty-state
                      message so the card never collapses. */}
                  <div className="overflow-y-auto" style={{ height: 170 }}>
                    {pending?.items?.length ? (
                      <div className="space-y-0.5">
                        {pending.items.slice(0, 6).map((rec: any) => (
                          <a key={rec.id} href="/tasks"
                            className="flex items-center gap-2 px-1.5 py-1 rounded text-[11px] hover:bg-panel2 transition-colors"
                            title={rec.explanation}>
                            <span className="font-mono text-text shrink-0">v{rec.volume_id}</span>
                            <span className="badge text-[9px] shrink-0">{rec.action}</span>
                            <span className="flex-1 min-w-0">
                              <ScoreBar v={rec.score}/>
                            </span>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-[11px] text-muted">
                        {t("No pending recommendations.")}
                      </div>
                    )}
                  </div>
                </div>
              ),
            },
            {
              id: "access_trend",
              node: (
                <div className="card p-3 flex flex-col">
                  <header className="flex items-center justify-between mb-1">
                    <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      {t("Access Trend (with holiday windows)")}
                    </h2>
                    <span className="text-[10px] text-muted">{range}</span>
                  </header>
                  <TrendChart points={trend?.points || []} height={170} title=""/>
                </div>
              ),
            },
            {
              id: "cluster_pressure",
              visible: (pressure?.items?.length ?? 0) > 0,
              node: pressure ? (
                <div className="card p-3 flex flex-col">
                  <header className="flex items-center justify-between mb-1">
                    <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      {t("Cluster pressure")}
                    </h2>
                    <span className="text-[10px] text-muted">
                      {t("threshold")} {pressure.threshold.toFixed(2)}
                    </span>
                  </header>
                  <ReactECharts style={{ height: 170 }} option={buildPressureBar(pressure, (clusters?.items as Array<{ id: string; name: string }>) ?? [])}/>
                </div>
              ) : null,
            },
          ];
          return chartItems;
        })()}
      />

      {/* Node / rack distribution gets its own full row — long server
          hostnames need horizontal room in the legend. Same controls
          (count / size / usage + node / rack) as before. */}
      <section className="card p-4">
        <header className="flex items-start justify-between gap-2 mb-2 flex-wrap">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
            <HardDrive size={12}/>
            <span className="text-text normal-case tracking-normal font-normal">
              {distMetric === "count" ? t("Volume count") : distMetric === "size" ? t("Storage size") : t("Slot usage")}
              {" "}{distMode === "node" ? t("by_node") : t("by_rack")}
            </span>
          </h2>
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(["count", "size", "usage"] as const).map((m) => (
                <button key={m}
                  onClick={() => setDistMetric(m)}
                  className={`px-2 py-0.5 text-[11px] transition-colors ${
                    distMetric === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                  }`}>
                  {m === "count" ? t("Count") : m === "size" ? t("Size") : t("Usage")}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(["node", "rack"] as const).map((m) => (
                <button key={m}
                  onClick={() => setDistMode(m)}
                  className={`px-2 py-0.5 text-[11px] transition-colors ${
                    distMode === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                  }`}>
                  {m === "node" ? t("N") : t("R")}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="text-[11px] text-muted mb-1">
          {distMetric === "usage"
            ? `${nodeStats.totalGroups} ${distMode === "node" ? t("nodes_lc") : t("racks_lc")} · ${nodeStats.usedSlots}/${nodeStats.maxSlots} ${t("slots")}`
            : <>{nodes.totalNodes} {distMode === "node" ? t("nodes_lc") : t("racks_lc")} · {nodes.totalVolumes} {t("volumes_lc")}
                {nodes.readOnly > 0 && <> · <span className="text-warning">{nodes.readOnly} {t("R/O")}</span></>}
              </>
          }
        </div>
        {(distMetric === "usage" ? nodeStats.entries.length : nodes.bars.length) === 0 ? (
          <div className="text-xs text-muted py-6 text-center">{t("No data returned.")}</div>
        ) : (
          <ReactECharts style={{ height: 260 }} option={
            distMetric === "count" ? buildNodePie(nodes, "count")
              : distMetric === "size" ? buildNodePie(nodes, "size")
              : buildUsageBar(nodeStats)
          }/>
        )}
      </section>

      {(trendDomain?.series?.length ?? 0) > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{t("By business domain")}</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {trendDomain.series.map((s: any) => (
              <div key={s.domain} className="card p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="badge">{s.domain}</span>
                  <span className="text-xs text-muted">{s.points.length} {t("buckets")}</span>
                </div>
                <TrendChart points={s.points} title={`${s.domain} access`}/>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface PressureItem { cluster_id: string; score: number; is_busy: boolean }
interface PressureResp { items: PressureItem[]; threshold: number }

function PressurePill({ data }: { data: PressureResp }) {
  const { t } = useT();
  const max = Math.max(...(data.items?.map(i => i.score) ?? [0]));
  const busy = (data.items ?? []).filter(i => i.is_busy).length;
  const tone = busy > 0 ? "border-warning/40 text-warning" : "border-muted/40 text-muted";
  return (
    <Link href="/clusters" className={`badge ${tone}`}
      title={`${t("Pressure threshold")} ${data.threshold.toFixed(2)} · ${busy} ${t("busy")} ${t("clusters_lc")}`}>
      {t("Pressure max")} {max.toFixed(2)}/{data.threshold.toFixed(2)} ({busy} {t("busy")})
    </Link>
  );
}

function Stat({ icon, label, value, sub, href }: { icon: React.ReactNode; label: string; value: any; sub?: any; href?: string }) {
  // `h-full` makes the card fill its grid cell (CSS Grid stretches rows
  // to the tallest item); `flex-col` + `mt-auto` on the sub-line glues
  // it to the bottom so plain Stat and StatGauge align row-by-row.
  const body = (
    <>
      <div className="text-xs text-muted flex items-center gap-2">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      <div className="text-xs text-muted mt-auto pt-2">{sub ?? " "}</div>
    </>
  );
  const cls = "card p-4 h-full flex flex-col min-h-[110px] hover:border-accent/50 hover:bg-panel2/40 transition-colors";
  if (href) return <Link href={href} className={cls}>{body}</Link>;
  return <div className={cls}>{body}</div>;
}

// Stat card variant with a horizontal "fuel gauge" below the value. Used
// for Total Size so the operator can see capacity headroom at a glance —
// SeaweedFS reports per-disk slot counts (not raw byte capacity) via the
// master topology, so we render slot utilization here as the fullness
// proxy: it's the same number the cluster actually allocates against.
function StatGauge({
  icon, label, value, used, max, subLabel, href, formatUnit,
}: {
  icon: React.ReactNode;
  label: string;
  value: any;
  used: number;
  max: number;
  subLabel: string;
  href?: string;
  // Optional byte formatter — when set we render `bytes(used) / bytes(max)`
  // instead of the raw number pair (used for the real-disk variant).
  formatUnit?: (n: number) => string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  // Red ≥85%, amber ≥70%, accent blue otherwise — matches the per-node
  // usage bar so the visual language stays consistent.
  const tone =
    pct >= 85 ? "bg-danger"
    : pct >= 70 ? "bg-warning"
    : "bg-accent";
  const toneText =
    pct >= 85 ? "text-danger"
    : pct >= 70 ? "text-warning"
    : "text-muted";
  const body = (
    <>
      <div className="text-xs text-muted flex items-center gap-2">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {max > 0 ? (
        <div className="mt-auto pt-2 space-y-1">
          <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
            <div className={`h-full ${tone} transition-[width] duration-300`} style={{ width: `${pct}%` }} />
          </div>
          <div className={`text-[11px] flex items-center justify-between ${toneText}`}>
            <span>
              {formatUnit ? `${formatUnit(used)} / ${formatUnit(max)}` : `${used}/${max} ${subLabel}`}
            </span>
            <span className="font-mono">{pct}%</span>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted mt-auto pt-2">—</div>
      )}
    </>
  );
  const cls = "card p-4 h-full flex flex-col min-h-[110px] hover:border-accent/50 hover:bg-panel2/40 transition-colors";
  if (href) return <Link href={href} className={cls}>{body}</Link>;
  return <div className={cls}>{body}</div>;
}

function ScoreBar({ v }: { v: number }) {
  const pct = Math.round(v * 100);
  const color = v >= 0.9 ? "bg-danger" : v >= 0.75 ? "bg-warning" : v >= 0.55 ? "bg-accent" : "bg-muted";
  return (
    <div className="flex items-center gap-2 w-32">
      <div className="h-1.5 flex-1 rounded-full bg-panel2 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }}/>
      </div>
      <span className="font-mono text-xs">{v.toFixed(2)}</span>
    </div>
  );
}

// Aggregates volume list by storage server or rack. Result is sorted by total
// volume count descending so the busiest nodes/racks appear at the top.
function buildNodeDist(items: any[], mode: "node" | "rack" = "node") {
  type Agg = { server: string; writable: number; readonly: number; bytes: number; clusters: Set<string> };
  const by = new Map<string, Agg>();
  let totalVolumes = 0;
  let readOnly = 0;
  for (const v of items) {
    const key = mode === "rack"
      ? ((v.Rack as string) || "(no-rack)")
      : ((v.Server as string) || "(unknown)");
    let a = by.get(key);
    if (!a) {
      a = { server: key, writable: 0, readonly: 0, bytes: 0, clusters: new Set<string>() };
      by.set(key, a);
    }
    if (v.ReadOnly) { a.readonly++; readOnly++; } else { a.writable++; }
    a.bytes += Number(v.Size) || 0;
    if (v.cluster_name) a.clusters.add(v.cluster_name as string);
    totalVolumes++;
  }
  const bars = [...by.values()]
    .map(a => ({ ...a, clusters: [...a.clusters] }))
    .sort((a, b) => (b.writable + b.readonly) - (a.writable + a.readonly));
  // The pie chart collapses long-tail nodes into one "N others" slice, so we
  // can hand it the full list without screen-melting consequences.
  const byServer = new Map(bars.map(b => [b.server, b]));
  return {
    bars,
    byServer,
    totalNodes: bars.length,
    totalVolumes,
    readOnly,
    truncated: false,
  };
}

// Donut chart of volumes per node/rack. `metric` switches between volume
// count and total bytes. Tooltip always surfaces both plus writable/readonly
// split. Long-tail nodes (>8) collapse into one slice for legibility.
// Per-node/rack slot utilization, sourced from master DiskInfo. One row per
// node/rack; bar fills proportional to volume_count / max_volume_count.
function buildNodeStats(nodesRaw: any[], mode: "node" | "rack" = "node") {
  type Agg = { key: string; used: number; max: number; free: number; bytes: number; clusters: Set<string> };
  const by = new Map<string, Agg>();
  for (const n of nodesRaw) {
    const key = mode === "rack" ? (n.rack || "(no-rack)") : (n.server || "(unknown)");
    let a = by.get(key);
    if (!a) { a = { key, used: 0, max: 0, free: 0, bytes: 0, clusters: new Set() }; by.set(key, a); }
    a.used += Number(n.volume_count) || 0;
    a.max  += Number(n.max_volume_count) || 0;
    a.free += Number(n.free_volume_count) || 0;
    a.bytes += Number(n.used_bytes) || 0;
    if (n.cluster_name) a.clusters.add(n.cluster_name);
  }
  // Sort by utilization desc so the fullest nodes top the chart.
  const entries = [...by.values()]
    .map(a => ({ ...a, clusters: [...a.clusters], util: a.max > 0 ? a.used / a.max : 0 }))
    .sort((a, b) => b.util - a.util);
  let usedSlots = 0, maxSlots = 0;
  for (const e of entries) { usedSlots += e.used; maxSlots += e.max; }
  return { entries, totalGroups: entries.length, usedSlots, maxSlots };
}

// Horizontal "fuel gauge" — used vs free slots per node/rack. Red if >85%,
// amber if >70%, otherwise accent blue.
function buildUsageBar(stats: ReturnType<typeof buildNodeStats>) {
  const entries = stats.entries.slice(0, 12); // cap height so it never overflows
  const colorFor = (util: number) => util >= 0.85
    ? "oklch(70% 0.19 30)"
    : util >= 0.70 ? "oklch(74% 0.18 60)"
    : "oklch(74% 0.18 230)";
  const usedSeries = entries.map(e => ({
    value: e.used,
    itemStyle: { color: colorFor(e.util), borderRadius: [3, 0, 0, 3] },
  }));
  return {
    backgroundColor: "transparent",
    grid: { left: 130, right: 56, top: 6, bottom: 4 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, textStyle: { color: C.text, fontSize: 12 },
      formatter: (params: any) => {
        const idx = params[0].dataIndex;
        const e = entries[idx];
        const pct = (e.util * 100).toFixed(1);
        const cl = e.clusters?.length
          ? `<br/><span style="color:#999">cluster: ${e.clusters.join(", ")}</span>` : "";
        return `<b>${e.key}</b><br/>` +
          `slots: <b>${e.used}</b> / ${e.max} · <b>${pct}%</b><br/>` +
          `<span style="color:#999">free: ${e.free} · stored: ${bytes(e.bytes)}</span>${cl}`;
      },
    },
    xAxis: {
      type: "value",
      max: Math.max(1, ...entries.map(e => e.max)),
      axisLabel: { color: C.textMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: C.grid } },
    },
    yAxis: {
      type: "category", inverse: true,
      data: entries.map(e => e.key),
      axisLabel: {
        color: C.textMuted, fontSize: 10,
        formatter: (v: string) => v.length > 22 ? "…" + v.slice(-21) : v,
      },
      axisLine: { lineStyle: { color: C.axisLine } },
      axisTick: { show: false },
    },
    series: [
      {
        name: "Used", type: "bar", stack: "u", barMaxWidth: 16,
        data: usedSeries,
        emphasis: { focus: "series" },
        label: {
          show: true, position: "insideLeft", color: "#0e1320",
          fontSize: 11, fontWeight: 700,
          formatter: (p: any) => p.value > 0 ? p.value : "",
        },
      },
      {
        name: "Free", type: "bar", stack: "u", barMaxWidth: 16,
        itemStyle: { color: "rgba(255,255,255,0.06)", borderRadius: [0, 3, 3, 0] },
        data: entries.map(e => Math.max(0, e.max - e.used)),
        emphasis: { focus: "series" },
        label: {
          show: true, position: "right", color: C.textMuted,
          fontSize: 11, fontWeight: 600,
          formatter: (p: any) => {
            const e = entries[p.dataIndex];
            return e.max > 0 ? `${(e.util * 100).toFixed(0)}%` : "—";
          },
        },
      },
    ],
  };
}

// Horizontal bar of per-cluster pressure scores vs. the configured
// threshold. Tiny chart sized to fit the 4-col dashboard row.
function buildPressureBar(p: PressureResp, clustersIdx: Array<{ id: string; name: string }>) {
  const nameOf = (cid: string) => clustersIdx.find(c => c.id === cid)?.name || cid;
  const items = [...p.items].sort((a, b) => b.score - a.score).slice(0, 8);
  const data = items.map(it => ({
    value: it.score,
    itemStyle: {
      color: it.is_busy ? "oklch(70% 0.19 30)" : it.score >= p.threshold * 0.7 ? "oklch(74% 0.18 60)" : "oklch(74% 0.18 230)",
      borderRadius: [3, 3, 3, 3],
    },
  }));
  return {
    backgroundColor: "transparent",
    grid: { left: 88, right: 36, top: 4, bottom: 4 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      textStyle: { color: C.text, fontSize: 11 },
      formatter: (params: any) => {
        const it = items[params[0].dataIndex];
        return `<b>${nameOf(it.cluster_id)}</b><br/>` +
          `score ${it.score.toFixed(2)} / threshold ${p.threshold.toFixed(2)}` +
          (it.is_busy ? `<br/><span style="color:#f5b06b">busy</span>` : "");
      },
    },
    xAxis: {
      type: "value", min: 0, max: Math.max(p.threshold, ...items.map(i => i.score), 1),
      axisLabel: { color: C.textMuted, fontSize: 9 },
      splitLine: { lineStyle: { color: C.grid } },
    },
    yAxis: {
      type: "category", inverse: true,
      data: items.map(it => nameOf(it.cluster_id)),
      axisLabel: {
        color: C.textMuted, fontSize: 10,
        formatter: (v: string) => v.length > 14 ? "…" + v.slice(-13) : v,
      },
      axisLine: { lineStyle: { color: C.axisLine } },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar", barMaxWidth: 14, data,
        label: {
          show: true, position: "right", color: C.textMuted, fontSize: 10,
          formatter: (p: any) => p.value.toFixed(2),
        },
        markLine: {
          symbol: "none",
          lineStyle: { color: "rgba(245,176,107,0.6)", type: "dashed", width: 1 },
          data: [{ xAxis: p.threshold }],
          label: { show: false },
        },
      },
    ],
  };
}

function buildNodePie(nodes: ReturnType<typeof buildNodeDist>, metric: "count" | "size" = "count") {
  const palette = [
    "oklch(74% 0.18 230)", "oklch(70% 0.18 30)",  "oklch(74% 0.10 270)",
    "oklch(70% 0.15 150)", "oklch(70% 0.15 60)",  "oklch(68% 0.16 320)",
    "oklch(72% 0.14 200)", "oklch(70% 0.16 100)",
  ];
  const MAX_SLICES = 8;
  const valueOf = (b: any) => metric === "size" ? b.bytes : (b.writable + b.readonly);
  // Re-sort by the active metric so the largest contributor leads.
  const sorted = [...nodes.bars].sort((a, b) => valueOf(b) - valueOf(a));
  const visible = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const data = visible.map((b: any, i: number) => ({
    name: b.server,
    value: valueOf(b),
    writable: b.writable,
    readonly: b.readonly,
    bytes: b.bytes,
    count: b.writable + b.readonly,
    clusters: b.clusters,
    itemStyle: { color: palette[i % palette.length] },
  }));
  if (tail.length > 0) {
    const w = tail.reduce((s: number, b: any) => s + b.writable, 0);
    const r = tail.reduce((s: number, b: any) => s + b.readonly, 0);
    const bts = tail.reduce((s: number, b: any) => s + b.bytes, 0);
    data.push({
      name: `${tail.length} other${tail.length === 1 ? "" : "s"}`,
      value: metric === "size" ? bts : (w + r),
      writable: w, readonly: r, bytes: bts, count: w + r, clusters: [],
      itemStyle: { color: "oklch(48% 0.02 255)" },
    });
  }
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      textStyle: { color: C.text, fontSize: 12 },
      formatter: (p: any) => {
        const d = p.data;
        const ro = d.readonly > 0
          ? `<span style="color:#f5b06b">●</span> read-only: <b>${d.readonly}</b><br/>` : "";
        const cl = d.clusters?.length
          ? `<span style="color:#999">cluster: ${d.clusters.join(", ")}</span><br/>` : "";
        return `<b>${p.name}</b> · ${p.percent}%<br/>` +
          `<span style="color:#74a4ff">●</span> writable: <b>${d.writable}</b><br/>${ro}` +
          `<span style="color:#999">count: ${d.count} · size: ${bytes(d.bytes)}</span><br/>${cl}`;
      },
    },
    legend: {
      type: "scroll", orient: "vertical", right: 8, top: "center",
      textStyle: { color: C.textMuted, fontSize: 10 },
      icon: "roundRect", itemWidth: 8, itemHeight: 8, itemGap: 6,
      pageIconColor: "#888", pageTextStyle: { color: C.textMuted, fontSize: 10 },
      formatter: (name: string) => name.length > 20 ? "…" + name.slice(-19) : name,
    },
    series: [{
      type: "pie",
      radius: ["48%", "72%"],
      center: ["38%", "50%"],
      padAngle: 2,
      itemStyle: { borderRadius: 4, borderColor: "transparent", borderWidth: 0 },
      label: {
        show: true, color: C.text, fontSize: 10,
        formatter: (p: any) => p.percent >= 6 ? `${p.percent}%` : "",
      },
      labelLine: { show: false },
      emphasis: { scale: true, scaleSize: 4 },
      data,
    }],
  };
}

interface ScoreReport {
  clusters: number;
  clusters_ok: number;
  volumes_scanned: number;
  volumes_noop: number;
  recs_by_action?: Record<string, number>;
  under_replicated: number;
  missing_volumes?: number[];
  tasks_inserted: number;
  tasks_duplicate: number;
  tasks_failed: number;
  errors?: string[];
  per_cluster?: ClusterScanReport[];
}

interface ClusterScanReport {
  name: string;
  master_addr?: string;
  business_domain?: string;
  volumes: number;
  recs: number;
  under_replicated: number;
  missing_volumes?: number[];
  inserted: number;
  duplicate: number;
  failed: number;
  error?: string;
}

function formatScoreReport(
  res: { ok?: boolean; report?: ScoreReport; error?: string },
  t: (k: string) => string,
): string {
  if (res?.error) return `${t("Error:")} ${res.error}`;
  const r = res?.report;
  if (!r) return t("Scoring complete.");
  const lines: string[] = [];

  // Step 1 — connectivity & inventory
  lines.push(`① ${t("Clusters:")} ${r.clusters_ok}/${r.clusters} ${t("online")}`);
  lines.push(`② ${t("Volumes scanned:")} ${r.volumes_scanned}`);

  // Step 2 — coldness scoring breakdown
  const recs = r.recs_by_action ?? {};
  const recCount = Object.entries(recs)
    .filter(([k]) => k !== "fix_replication")
    .reduce((s, [, n]) => s + n, 0);
  if (r.volumes_noop === r.volumes_scanned && recCount === 0) {
    lines.push(`③ ${t("Cold-score:")} ${t("all noop (too hot / too small / cooling window unmet)")}`);
  } else {
    const detail = Object.entries(recs)
      .filter(([k]) => k !== "fix_replication")
      .map(([k, n]) => `${k}=${n}`).join(", ");
    lines.push(`③ ${t("Cold-score:")} ${recCount} ${t("recs")}${detail ? ` (${detail})` : ""}, ${r.volumes_noop} ${t("noop")}`);
  }

  // Step 3 — under-replication
  if (r.under_replicated > 0) {
    const sample = (r.missing_volumes ?? []).slice(0, 5).join(", ");
    const more = (r.missing_volumes ?? []).length > 5 ? "…" : "";
    lines.push(`④ ${t("Replication:")} ${r.under_replicated} ${t("under-replicated")} (${t("vol")} ${sample}${more})`);
  } else {
    lines.push(`④ ${t("Replication:")} ${t("all replicas present")}`);
  }

  // Step 4 — final
  if (r.tasks_inserted > 0) {
    lines.push(`⑤ ${t("Inserted")} ${r.tasks_inserted} ${t("new task(s) — see /tasks")}`);
  } else if (r.tasks_failed > 0) {
    lines.push(`⑤ ${r.tasks_failed} ${t("task insert(s) failed (see errors below)")}`);
  } else {
    lines.push(`⑤ ${t("No new tasks")}${r.tasks_duplicate > 0 ? ` (${r.tasks_duplicate} ${t("deduped on idempotency key")})` : ""}`);
  }
  if (r.errors?.length) lines.push(`${t("Errors:")}\n  - ` + r.errors.join("\n  - "));

  // Per-cluster breakdown — surfaces WHICH cluster did what so the operator
  // can locate findings in multi-cluster setups.
  if ((r.per_cluster?.length ?? 0) > 0) {
    lines.push("");
    lines.push(t("Per cluster:"));
    for (const c of r.per_cluster!) {
      const tag = c.business_domain ? ` [${c.business_domain}]` : "";
      const addr = c.master_addr ? ` ${c.master_addr}` : "";
      if (c.error) {
        lines.push(`  • ${c.name}${tag}${addr} — ❌ ${c.error}`);
        continue;
      }
      const parts: string[] = [`${t("vols")}=${c.volumes}`];
      if (c.recs > 0) parts.push(`${t("recs")}=${c.recs}`);
      if (c.under_replicated > 0) {
        const sample = (c.missing_volumes ?? []).slice(0, 5).join(",");
        parts.push(`${t("under-replicated")}=${c.under_replicated} (${t("vol")} ${sample})`);
      }
      if (c.inserted > 0) parts.push(`${t("new")}=${c.inserted}`);
      if (c.duplicate > 0) parts.push(`${t("dup")}=${c.duplicate}`);
      if (c.failed > 0) parts.push(`${t("failed")}=${c.failed}`);
      lines.push(`  • ${c.name}${tag}${addr} — ${parts.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

