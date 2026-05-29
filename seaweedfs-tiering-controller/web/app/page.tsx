"use client";
import { useSummary, useTasks, useTrend, useTrendByDomain, useClusters, useHolidays, useHealthGate, useSafetyStatus, useClusterPressure, useVolumes, useClusterDisk, useCollectionTemperatures, useCurrentCosts, useClusterMasters, useReplicationHealth, useCapacityForecast } from "@/lib/api";
import { HealthOverview } from "@/app/raft/_health-overview";
import { useT } from "@/lib/i18n";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import { Activity, Database, Flame, Snowflake, Zap, RefreshCw, ShieldAlert, ShieldCheck, Lock, HardDrive, ThermometerSnowflake, DollarSign, ArrowUpRight, ListChecks } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { TrendChart } from "@/components/trend-chart";
import { SortableRow, type SortableItem } from "@/components/sortable-row";
import { DeepCheckModal } from "@/components/deep-check-modal";
import { TodaysAttention } from "@/components/dashboard/todays-attention";
import { CapacityIncidentsBanner } from "@/components/capacity-incidents";
import { CapacityForecastPanel } from "@/components/capacity-forecast";
import { PageHeader } from "@/components/page-header";
import { useCluster } from "@/lib/cluster-context";

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
  const [deepCheckOpen, setDeepCheckOpen] = useState(false);
  // "" = all clusters; otherwise cluster.id. Driven by the global topbar
  // ClusterSwitcher (ClusterProvider) so the dashboard scope follows the
  // same source of truth as every resource page — no second, page-local
  // cluster picker. Empty string means "all clusters".
  const { clusterID: scopeCluster } = useCluster();

  const total = s?.bytes_total || 0;
  const tiers = [
    { name: t("Hot (SSD/NVMe)"),  value: s?.bytes_hot  || 0, color: "#f97316"  },
    { name: t("Warm (HDD/EC)"),   value: s?.bytes_warm || 0, color: "#3b9eff" },
    { name: t("Cold (Cloud)"),    value: s?.bytes_cold || 0, color: "#a78bfa" },
  ];

  // Per-node distribution. Sourced from the same /volumes payload (which also
  // carries node disk stats); scoped to the cluster picker so the chart
  // matches whatever is being scored.
  const { data: volumesData } = useVolumes(scopeCluster || undefined);
  // Real physical disk usage (only when a single cluster is picked — the
  // /disk endpoint is per-cluster). Falls back to slot-based estimate
  // in the gauge when not available.
  const { data: diskUsage } = useClusterDisk(scopeCluster || undefined);
  // Temperature pulse + real cost numbers — only rendered when the
  // backing data is available. Both default to "show nothing" so an
  // empty cluster doesn't paint zeros on the dashboard.
  const { data: tempData } = useCollectionTemperatures();
  const { data: costsNow } = useCurrentCosts(scopeCluster || undefined);
  // Durability rollup — masters raft + replication health → 0-100 score.
  // Lives on the dashboard so the operator sees control/data-plane risk
  // in the same view as the rest of the overview. /raft remains the
  // deep-dive page (per-master + per-volume tables).
  const { data: durMasters } = useClusterMasters(scopeCluster || undefined);
  const { data: durRepl }    = useReplicationHealth(scopeCluster || undefined);
  // CapacityForecastPanel runs the same hook internally; SWR dedupes,
  // so reading it here is free. We need it to decide whether to add the
  // forecast card to the chart row at all — a row with a hidden card
  // would leave a gap.
  const { data: capForecast } = useCapacityForecast();
  const hasForecast = (capForecast?.items ?? []).some((i) => i.status !== "no_data");
  const coldCollections = useMemo(
    () => (tempData?.items ?? [])
      .filter((c: any) => (c.cold_n ?? 0) + (c.frozen_n ?? 0) > 0)
      .sort((a: any, b: any) => (b.cold_size + b.frozen_size) - (a.cold_size + a.frozen_size))
      .slice(0, 5),
    [tempData],
  );
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

  // Status pills (safety / gate / pressure / holiday freeze) live inside
  // the durability hero card (top row), not the topbar. hasStatus gates
  // the slot: when there's no signal at all (no gate data, not all-clear,
  // no pressure, no freeze) the row is omitted rather than rendered empty.
  // An all-clear cluster still shows the single green badge, as before.
  const hasStatus = Boolean(
    safety?.safety_code === "emergency_stop" ||
    (gate && !gate.ok) ||
    (gate?.ok && safety?.overall_allowed) ||
    (pressure?.items?.length ?? 0) > 0 ||
    holidays?.freeze_active,
  );
  const statusPills = (
    <>
      {safety?.safety_code === "emergency_stop" && (
        <Link href="/reliability?tab=safety" className="badge border-danger/40 text-danger animate-pulse">
          <Lock size={12}/> {t("EMERGENCY STOP")}
        </Link>
      )}
      {gate && !gate.ok && (
        <Link href="/reliability?tab=health" className="badge border-danger/40 text-danger" title={gate.reason}>
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
    </>
  );

  const headerActions = (
    <>
      <div className="flex gap-1">
        {(["1d","7d","30d"] as const).map(r => (
          <button key={r} className={`btn ${range===r?"btn-primary":""}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("Storage Tiering Overview")} actions={headerActions}/>

      {/* Capacity incidents — auto-paused clusters. Sits above everything
          else: a held cluster is the most urgent thing on the page. */}
      <CapacityIncidentsBanner/>

      {/* First row — durability hero (left half) + 6 core KPIs (right
          half). The old full-width hero and the separate KPI row below
          were merged here so the operator sees vitals without scrolling.
          KPIs are a fixed, curated set: scale → capacity → space →
          read-only → backlog → savings. Bento: capacity bar + volume/read-only rings + number cards. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: durability hero (with Check + open buttons) and
            today's attention filling the space below as a scrollable list. */}
        <div className="flex flex-col gap-6">
          <div className="relative">
            <HealthOverview masters={durMasters} repl={durRepl} statusSlot={hasStatus ? statusPills : undefined}/>
            <button
              type="button"
              onClick={() => setDeepCheckOpen(true)}
              title={t("Check")}
              className="absolute top-2 right-9 z-10 inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:brightness-110 transition"
            >
              <RefreshCw size={13}/>
              {t("Check")}
            </button>
            <EnterButton
              href={`/raft${scopeCluster ? `?cluster=${scopeCluster}` : ""}`}
              label={t("Cluster durability")}
            />
          </div>
          <TodaysAttention className="flex-1 min-h-0"/>
        </div>

        <div className="flex flex-col gap-3">
          {/* Capacity — total + free merged into one progress bar. Uses
              real disk bytes when available, else slot-based fallback. */}
          {(() => {
            const hasDisk = !!(diskUsage && Number(diskUsage.total_bytes) > 0);
            const used = hasDisk ? (Number(diskUsage?.used_bytes) || 0) : nodeStats.usedSlots;
            const tot  = hasDisk ? (Number(diskUsage?.total_bytes) || 0) : nodeStats.maxSlots;
            const free = hasDisk ? (Number(diskUsage?.free_bytes) || 0) : Math.max(0, nodeStats.maxSlots - nodeStats.usedSlots);
            const pct  = tot > 0 ? used / tot : 0;
            return (
              <BarStat
                href="/volumes"
                icon={<Activity size={18}/>}
                label={t("Capacity")}
                headline={hasDisk ? bytes(used) : `${used} / ${tot}`}
                headlineSub={hasDisk ? t("used") : t("slots")}
                pct={pct}
                leftLabel={`${(pct * 100).toFixed(0)}% ${t("used")}`}
                rightLabel={hasDisk
                  ? `${bytes(free)} ${t("free")} · ${bytes(tot)}`
                  : `${free} ${t("free")} · ${tot} ${t("slots")}`}
              />
            );
          })()}

          {/* Volumes (used vs max slots) + Read-only (read-only vs total) */}
          <div className="grid grid-cols-2 gap-3">
            <RingStat
              href="/volumes"
              icon={<Database size={18}/>}
              label={t("Volumes")}
              center={s?.volumes_total ?? nodes.totalVolumes}
              value={nodeStats.usedSlots}
              max={nodeStats.maxSlots}
              sub={nodeStats.maxSlots > 0
                ? `${((nodeStats.usedSlots / nodeStats.maxSlots) * 100).toFixed(0)}% · ${nodeStats.maxSlots} ${t("slots")}`
                : t("slots")}
            />
            <RingStat
              href="/volumes?readonly=1"
              icon={<Lock size={18}/>}
              label={t("Read-only")}
              tone="warning"
              center={nodes.readOnly}
              value={nodes.readOnly}
              max={nodes.totalVolumes}
              sub={`${nodes.totalVolumes ? ((nodes.readOnly / nodes.totalVolumes) * 100).toFixed(1) : 0}% ${t("of fleet")}`}
            />
          </div>

          {/* Pending / Monthly savings — plain number Stat cards */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              href="/activity?tab=tasks"
              icon={<Flame size={18}/>}
              label={t("Pending")}
              value={pending?.items?.length ?? 0}
              sub={`${pending?.items?.filter((p:any)=>p.score>=0.75).length ?? 0} ${t("hot recs")}`}
            />
            {costsNow && costsNow.monthly_saving > 0 ? (
              <Stat
                href="/costs"
                icon={<DollarSign size={18}/>}
                label={t("Monthly savings")}
                value={`${costsNow.currency} ${costsNow.monthly_saving.toFixed(0)}`}
                sub={t("vs. all-hot baseline")}
              />
            ) : (
              <Stat
                href="/activity?tab=executions"
                icon={<Snowflake size={18}/>}
                label={t("Saving est.")}
                value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)}
                sub={t("vs. 3-replica baseline")}
              />
            )}
          </div>
        </div>
      </div>


      {/* Charts and lists are split into two rows so visual chart cards
          (donuts, sparklines, bars) and textual list cards (forecast,
          coldest, recommendations) don't fight each other side-by-side.
          Mixing them on one row made the visual language inconsistent. */}

      {/* ── Monitoring charts — all visual (ECharts / TrendChart) ── */}
      <SectionLabel icon={<Activity size={12}/>} text={t("Monitoring charts")}/>
      <SortableRow
        rowKey="charts_visual"
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
        items={(() => {
          const visualItems: SortableItem[] = [
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
              id: "access_trend",
              // Hide when the trend chart has nothing meaningful to plot.
              // A flat-zero line next to real data reads as broken telemetry,
              // not "quiet system".
              visible: (trend?.points?.length ?? 0) > 0,
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
          return visualItems;
        })()}
      />

      {/* ── Data lists — all textual rows (forecast / coldest / recs) ── */}
      <SectionLabel icon={<ListChecks size={12}/>} text={t("Data lists")}/>
      <SortableRow
        rowKey="lists"
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
        items={(() => {
          const listItems: SortableItem[] = [
            {
              id: "capacity_forecast",
              visible: hasForecast,
              node: (
                <div className="h-full [&>section]:h-full [&>section]:flex [&>section]:flex-col">
                  <CapacityForecastPanel/>
                </div>
              ),
            },
            {
              id: "coldest_collections",
              visible: coldCollections.length > 0,
              node: (
                <div className="card p-3 flex flex-col">
                  <header className="flex items-center justify-between mb-1">
                    <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted inline-flex items-center gap-1">
                      <ThermometerSnowflake size={10}/> {t("Coldest collections")}
                    </h2>
                    <a href="/temperature" className="text-[10px] text-muted hover:text-accent">{t("Details")}</a>
                  </header>
                  <div className="overflow-y-auto" style={{ height: 170 }}>
                    <ul className="space-y-0.5">
                      {coldCollections.map((c: any) => {
                        const coldBytes = (c.cold_size || 0) + (c.frozen_size || 0);
                        const coldVols = (c.cold_n || 0) + (c.frozen_n || 0);
                        return (
                          <li key={c.collection || "__default__"}
                            className="flex items-center gap-2 px-1.5 py-1 rounded text-[11px] hover:bg-panel2 transition-colors">
                            <span className="font-mono text-text truncate flex-1 min-w-0" title={c.collection || "(default)"}>
                              {c.collection || "(default)"}
                            </span>
                            <span className="text-muted tabular-nums shrink-0">{coldVols} {t("vols_lc")}</span>
                            <span className="font-mono text-accent tabular-nums shrink-0 w-16 text-right">{bytes(coldBytes)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              ),
            },
            {
              id: "top_recommendations",
              visible: (pending?.items?.length ?? 0) > 0,
              node: (
                <div className="card p-3 flex flex-col">
                  <header className="flex items-center justify-between mb-1">
                    <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted inline-flex items-center gap-1">
                      <Zap size={10}/> {t("Top recommendations")}
                    </h2>
                    <a href="/activity?tab=tasks" className="text-[10px] text-muted hover:text-accent">{t("Details")}</a>
                  </header>
                  <div className="overflow-y-auto" style={{ height: 170 }}>
                    <div className="space-y-0.5">
                      {(pending?.items ?? []).slice(0, 6).map((rec: any) => (
                        <a key={rec.id} href="/activity?tab=tasks"
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
                  </div>
                </div>
              ),
            },
          ];
          return listItems;
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
          <NodeDistBars
            metric={distMetric}
            bars={distMetric === "usage" ? [] : nodes.bars}
            usage={distMetric === "usage" ? nodeStats.entries : []}
          />
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

      <DeepCheckModal
        open={deepCheckOpen}
        scopeCluster={scopeCluster}
        onClose={() => setDeepCheckOpen(false)}
        onCompleted={() => mutate()}
      />
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
      <div className="text-xs text-muted flex items-center gap-2 pr-6">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      <div className="text-xs text-muted mt-auto pt-2">{sub ?? " "}</div>
    </>
  );
  const cls = "card p-4 h-full flex flex-col min-h-[110px] relative";
  return (
    <div className={cls}>
      {body}
      {href && <EnterButton href={href} label={label}/>}
    </div>
  );
}

// Capacity-style KPI: headline value + horizontal progress bar + a
// left/right caption row. Used for the merged total+free capacity card.
// Text is pre-translated by the caller so this stays presentational.
function BarStat({
  icon, label, headline, headlineSub, pct, leftLabel, rightLabel, href,
}: {
  icon: React.ReactNode; label: string; headline: React.ReactNode; headlineSub?: string;
  pct: number; leftLabel: string; rightLabel: string; href?: string;
}) {
  const w = Math.min(100, Math.max(0, pct * 100));
  return (
    <div className="card p-4 relative">
      <div className="text-xs text-muted flex items-center gap-2 pr-6">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">
        {headline}{headlineSub && <span className="text-xs text-muted font-normal"> {headlineSub}</span>}
      </div>
      <div className="mt-2 h-2.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${w}%` }}/>
      </div>
      <div className="flex justify-between text-xs text-muted mt-1.5">
        <span>{leftLabel}</span><span>{rightLabel}</span>
      </div>
      {href && <EnterButton href={href} label={label}/>}
    </div>
  );
}

// Ring KPI: an SVG donut showing value/max, a headline number in the
// center, and value/max + sub beside it. Used for volumes (used vs max
// slots) and read-only (read-only vs total). tone picks the arc color.
function RingStat({
  icon, label, center, value, max, sub, tone = "accent", href,
}: {
  icon: React.ReactNode; label: string; center: React.ReactNode;
  value: number; max: number; sub: string; tone?: "accent" | "warning"; href?: string;
}) {
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = 26, circ = 2 * Math.PI * r;
  const toneCls = tone === "warning" ? "text-warning" : "text-accent";
  return (
    <div className="card p-4 h-full flex flex-col min-h-[110px] relative">
      <div className="text-xs text-muted flex items-center gap-2 pr-6">{icon}{label}</div>
      <div className="flex items-center gap-3 mt-2">
        <div className="relative w-[58px] h-[58px] shrink-0">
          <svg viewBox="0 0 64 64" className="w-[58px] h-[58px] -rotate-90">
            <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-border"/>
            <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
              stroke="currentColor"
              className={`${toneCls} transition-[stroke-dashoffset] duration-700`}
              strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}/>
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-base font-semibold tabular-nums">{center}</div>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tabular-nums">
            {value}{max > 0 && <span className="text-muted font-normal"> / {max}</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">{sub}</div>
        </div>
      </div>
      {href && <EnterButton href={href} label={label}/>}
    </div>
  );
}

// Small corner navigation button used by all dashboard cards. The card
// itself is no longer a giant click target — the user asked for an
// explicit "open detail" button up in the corner, so reading or
// drag-reordering a card never bounces to the detail page.
function EnterButton({ href, label }: { href: string; label?: string }) {
  return (
    <Link
      href={href}
      aria-label={label ?? "Open"}
      title={label}
      className="absolute top-2 right-2 p-1 rounded-md text-muted hover:text-accent hover:bg-panel2/60 transition-colors z-10"
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpRight size={14}/>
    </Link>
  );
}

// Subtle section header used to visually separate the dashboard's chart
// row from its list row — without a label they read as "two unrelated
// rows of cards", which was the friction the user flagged. Tiny
// uppercase text + a thin underline keeps it from competing with the
// data cards beneath.
function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted/80 pt-2 -mb-1">
      <span className="text-muted/60">{icon}</span>
      <span>{text}</span>
      <span className="flex-1 h-px bg-border/40 ml-1"/>
    </div>
  );
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


// Horizontal bar of per-cluster pressure scores vs. the configured
// threshold. Tiny chart sized to fit the 4-col dashboard row.
function buildPressureBar(p: PressureResp, clustersIdx: Array<{ id: string; name: string }>) {
  const nameOf = (cid: string) => clustersIdx.find(c => c.id === cid)?.name || cid;
  const items = [...p.items].sort((a, b) => b.score - a.score).slice(0, 8);
  const data = items.map(it => ({
    value: it.score,
    itemStyle: {
      color: it.is_busy ? "#ef4444" : it.score >= p.threshold * 0.7 ? "#f59e0b" : "#3b9eff",
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




// NodeDistBars replaces the dashboard's per-node pie chart + usage bar
// with one consistent horizontal-list view. Why:
//   - Pie with >8 slices collapses small nodes into "N others" and
//     hides the actual distribution.
//   - The old ECharts horizontal bar truncated to 12 rows.
//   - Both used different visual languages, which made the metric
//     switcher feel disjoint.
// One sortable scrollable list covers all three metrics with the same
// visual rhythm.
function NodeDistBars({
  metric, bars, usage,
}: {
  metric: "count" | "size" | "usage";
  bars: Array<{ server: string; writable: number; readonly: number; bytes: number; clusters: string[] }>;
  usage: Array<{ key: string; used: number; max: number; free: number; bytes: number; util: number; clusters: string[] }>;
}) {
  const { t } = useT();
  if (metric === "usage") {
    const max = usage.reduce((m, e) => Math.max(m, e.max), 0);
    return (
      <ul className="max-h-[240px] overflow-y-auto pr-1 space-y-0.5">
        {usage.map((e) => {
          const usedPct = max > 0 ? (e.used / max) * 100 : 0;
          const maxPct  = max > 0 ? (e.max  / max) * 100 : 0;
          const utilTxt = `${(e.util * 100).toFixed(0)}%`;
          const fillClass = e.util >= 0.85
            ? "bg-danger/80"
            : e.util >= 0.70
              ? "bg-warning/80"
              : "bg-accent/80";
          const utilColor = e.util >= 0.85
            ? "text-danger"
            : e.util >= 0.70
              ? "text-warning"
              : "text-text";
          return (
            <li
              key={e.key}
              className="grid items-center gap-2 px-1.5 py-1 text-[11px] hover:bg-panel2/60 rounded"
              style={{ gridTemplateColumns: "minmax(0, 14rem) 1fr 7rem" }}
              title={`${e.key}\nslots: ${e.used} / ${e.max} (${utilTxt})\nfree: ${e.free}\nstored: ${bytes(e.bytes)}${e.clusters.length ? `\ncluster: ${e.clusters.join(", ")}` : ""}`}
            >
              <span className="font-mono truncate text-muted">{e.key}</span>
              <div className="relative h-2 bg-panel2 rounded overflow-hidden">
                {/* Capacity track shows max%, used fill on top so the
                    operator sees both headroom and current load. */}
                <div className="absolute inset-y-0 left-0 bg-muted/15 rounded" style={{ width: `${maxPct}%` }}/>
                <div className={`absolute inset-y-0 left-0 ${fillClass} rounded`} style={{ width: `${usedPct}%` }}/>
              </div>
              <span className={`tabular-nums font-mono text-right ${utilColor}`}>
                {e.used}/{e.max} · {utilTxt}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  // count / size mode — single value per row, optional read-only stripe
  // for count mode.
  const valueOf = (b: typeof bars[number]) =>
    metric === "size" ? b.bytes : (b.writable + b.readonly);
  const sorted = [...bars].sort((a, b) => valueOf(b) - valueOf(a));
  const max = sorted.reduce((m, b) => Math.max(m, valueOf(b)), 0);
  return (
    <ul className="max-h-[240px] overflow-y-auto pr-1 space-y-0.5">
      {sorted.map((b) => {
        const total = b.writable + b.readonly;
        const value = valueOf(b);
        const valuePct = max > 0 ? (value / max) * 100 : 0;
        const wRatio = total > 0 ? b.writable / total : 1;
        const wPct = valuePct * wRatio;
        const rPct = valuePct - wPct;
        const valueLabel = metric === "size"
          ? bytes(b.bytes)
          : String(total) + (b.readonly > 0 ? ` (${b.readonly} R/O)` : "");
        return (
          <li
            key={b.server}
            className="grid items-center gap-2 px-1.5 py-1 text-[11px] hover:bg-panel2/60 rounded"
            style={{ gridTemplateColumns: "minmax(0, 14rem) 1fr 7rem" }}
            title={`${b.server}\nwritable: ${b.writable}, read-only: ${b.readonly}\nsize: ${bytes(b.bytes)}${b.clusters.length ? `\ncluster: ${b.clusters.join(", ")}` : ""}`}
          >
            <span className="font-mono truncate text-muted">{b.server}</span>
            <div className="relative h-2 bg-panel2 rounded overflow-hidden flex">
              {wPct > 0 && (
                <div className="h-full bg-accent/80" style={{ width: `${wPct}%` }}/>
              )}
              {rPct > 0 && (
                <div className="h-full bg-warning/80" style={{ width: `${rPct}%` }}/>
              )}
            </div>
            <span className="tabular-nums font-mono text-right text-text">{valueLabel}</span>
          </li>
        );
      })}
      {sorted.length === 0 && (
        <li className="text-center text-muted text-xs py-4">{t("No data.")}</li>
      )}
    </ul>
  );
}
