"use client";
import { useSummary, useClusters, useTasks, useHealthGate, useSafetyStatus, useAlertEvents, useTrend } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { bytes } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  Activity, Database, Server, Flame, Snowflake, ShieldCheck, ShieldAlert, Lock, AlertTriangle, Sparkles, Bell,
} from "lucide-react";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface AlertEvent {
  id?: string;
  severity?: string;
  title?: string;
  source?: string;
  body?: string;
  fired_at?: string;
}

export default function WallPage() {
  const { data: s }       = useSummary();
  const { data: clusters }= useClusters();
  const { data: gate }    = useHealthGate();
  const { data: safety }  = useSafetyStatus();
  const { data: pending } = useTasks("pending");
  const { data: running } = useTasks("running");
  const { data: events }  = useAlertEvents();
  const { data: trend }   = useTrend("1d");

  // Rotate the alert ticker every 5s through recent events.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const recent: AlertEvent[] = (events?.items || []).slice(0, 8);
  const cur = recent.length > 0 ? recent[tick % recent.length] : null;

  const firedAt = (e: AlertEvent) => {
    const t = e.fired_at ? new Date(e.fired_at).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const alertsLast24h = recent.filter(e => Date.now() - firedAt(e) < 24 * 3600 * 1000).length;

  const overallOK = gate?.ok && safety?.overall_allowed;

  return (
    <div className="min-h-screen bg-bg p-6 text-text overflow-hidden">
      {/* Title bar */}
      <header className="flex items-center justify-between mb-6 border-b border-border pb-4">
        <div className="flex items-center gap-4">
          <div className="text-3xl font-semibold tracking-tight flex items-center gap-3">
            <Sparkles className="text-accent" size={28}/>
            SeaweedFS Tiering NOC
          </div>
          <div className="text-sm text-muted">{new Date().toLocaleString("zh-CN")}</div>
        </div>
        <BigGateBadge ok={!!overallOK}
          title={
            !gate?.ok ? `Gate CLOSED: ${gate?.reason}` :
            !safety?.overall_allowed ? `Safety: ${safety?.safety_code}` :
            "All clear"
          }/>
      </header>

      {/* Top KPI strip */}
      <section className="grid grid-cols-6 gap-4 mb-6">
        <BigStat icon={<Server size={32}/>}    label="Clusters"  value={clusters?.items?.length ?? "—"}/>
        <BigStat icon={<Database size={32}/>}  label="Volumes"   value={s?.volumes_total ?? "—"}/>
        <BigStat icon={<Activity size={32}/>}  label="Active"    value={running?.items?.length ?? 0}/>
        <BigStat icon={<Flame size={32}/>}     label="Pending"   value={pending?.items?.length ?? 0}/>
        <BigStat icon={<Snowflake size={32}/>} label="Saved"     value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)}/>
        <BigStat icon={<AlertTriangle size={32}/>} label="Alerts/day" value={alertsLast24h}/>
      </section>

      {/* Main grid: Sankey + Cluster lights + Trend + Alert ticker */}
      <section className="grid grid-cols-12 gap-4 mb-6">
        <div className="card p-5 col-span-7" style={{ height: 380 }}>
          <h2 className="text-lg font-medium mb-3">Migration Flow (last 24h)</h2>
          <SankeyFlow s={s}/>
        </div>
        <div className="card p-5 col-span-5" style={{ height: 380 }}>
          <h2 className="text-lg font-medium mb-3">Clusters</h2>
          <ClusterGrid clusters={clusters?.items || []}/>
        </div>
      </section>

      <section className="grid grid-cols-12 gap-4">
        <div className="card p-5 col-span-8" style={{ height: 280 }}>
          <h2 className="text-lg font-medium mb-3">Access Trend (24h)</h2>
          <TrendStrip points={trend?.points || []}/>
        </div>
        <div className="card p-5 col-span-4" style={{ height: 280, overflow: "hidden" }}>
          <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
            <AlertTriangle size={18}/> Recent alerts
          </h2>
          {cur ? (
            <div className="space-y-1">
              <div className={`text-xs ${sevColor(cur.severity)}`}>● {(cur.severity || "info").toUpperCase()}</div>
              <div className="text-xl font-medium">{cur.title || "(untitled alert)"}</div>
              <div className="text-sm text-muted">{cur.source || ""}</div>
              <div className="text-xs text-muted">
                {cur.fired_at ? new Date(cur.fired_at).toLocaleString("zh-CN") : ""}
              </div>
              <div className="text-sm mt-2 text-muted line-clamp-3">{cur.body || ""}</div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center"><EmptyState icon={Bell} size="sm" title="No active alerts"/></div>
          )}
          <div className="mt-3 text-xs text-muted">
            {recent.length > 0 ? `${(tick % recent.length) + 1}/${recent.length}` : ""}
          </div>
        </div>
      </section>
    </div>
  );
}

function BigStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: any }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-muted flex items-center gap-2">{icon}{label}</div>
      <div className="text-4xl font-semibold mt-2 tracking-tight">{value}</div>
    </div>
  );
}

function BigGateBadge({ ok, title }: { ok: boolean; title: string }) {
  return (
    <div className={`flex items-center gap-3 px-6 py-3 rounded-xl border-2 text-lg font-semibold
      ${ok ? "border-success/60 text-success bg-success/10" : "border-danger/60 text-danger bg-danger/10 animate-pulse"}`}>
      {ok ? <ShieldCheck size={28}/> : <ShieldAlert size={28}/>}
      <div>
        <div>{ok ? "OPERATIONAL" : "DEGRADED"}</div>
        <div className="text-xs font-normal text-muted mt-0.5">{title}</div>
      </div>
    </div>
  );
}

function SankeyFlow({ s }: { s: any }) {
  // Simulated flows for v1 — Sprint 3 wires real per-action byte counters.
  const hot  = s?.bytes_hot  || 0;
  const warm = s?.bytes_warm || 0;
  const cold = s?.bytes_cold || 0;
  const total = hot + warm + cold || 1;
  const flow1 = warm * 0.05; // hot→warm est this period
  const flow2 = cold * 0.03; // warm→cold est this period

  return (
    <ReactECharts style={{ height: 320 }} option={{
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p: any) =>
        p.dataType === "edge"
          ? `${p.data.source} → ${p.data.target}<br/>${bytes(p.data.value)}`
          : `${p.name}<br/>${bytes(p.value || 0)}` },
      series: [{
        type: "sankey", layout: "none",
        emphasis: { focus: "adjacency" },
        nodeAlign: "left",
        lineStyle: { color: "gradient", curveness: 0.5 },
        label: { color: C.text, fontSize: 13 },
        data: [
          { name: "Hot",     value: hot,  itemStyle: { color: "oklch(74% 0.18 30)" } },
          { name: "Warm/EC", value: warm, itemStyle: { color: "oklch(74% 0.18 230)" } },
          { name: "Cold",    value: cold, itemStyle: { color: "oklch(74% 0.10 270)" } },
          { name: "Archive", value: cold * 0.1, itemStyle: { color: "oklch(60% 0.05 280)" } },
        ],
        links: [
          { source: "Hot",  target: "Warm/EC", value: Math.max(flow1, total * 0.001) },
          { source: "Warm/EC", target: "Cold", value: Math.max(flow2, total * 0.001) },
          { source: "Cold", target: "Archive", value: Math.max(cold * 0.005, total * 0.0005) },
        ],
      }],
    }}/>
  );
}

function ClusterGrid({ clusters }: { clusters: any[] }) {
  if (clusters.length === 0) {
    return <div className="h-full flex items-center justify-center text-muted">No clusters registered.</div>;
  }
  // Simple grid of big lights per cluster.
  return (
    <div className="grid grid-cols-3 gap-3">
      {clusters.map((c: any) => (
        <div key={c.id} className={`p-4 rounded-lg border ${c.enabled ? "border-success/30 bg-success/5" : "border-muted/30 bg-bg"}`}>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-3 h-3 rounded-full ${c.enabled ? "bg-success animate-pulse" : "bg-muted"}`}/>
            <span className="font-semibold truncate">{c.name}</span>
          </div>
          <div className="text-xs text-muted font-mono truncate">{c.master_addr}</div>
          <div className="mt-1"><span className="badge">{c.business_domain}</span></div>
        </div>
      ))}
    </div>
  );
}

function TrendStrip({ points }: { points: any[] }) {
  const xs = points.map(p => new Date(p.bucket).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  const reads = points.map(p => p.reads);
  const writes = points.map(p => p.writes);
  return (
    <ReactECharts style={{ height: 220 }} option={{
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" },
      grid: { top: 20, left: 50, right: 30, bottom: 30 },
      xAxis: { type: "category", data: xs, axisLabel: { color: C.textMuted, fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { color: C.textMuted }, splitLine: { lineStyle: { color: "#222" } } },
      series: [
        { type: "line", smooth: true, data: reads, name: "reads",
          areaStyle: { opacity: 0.2, color: "oklch(74% 0.18 230)" },
          lineStyle: { color: "oklch(74% 0.18 230)", width: 2 },
          showSymbol: false },
        { type: "line", smooth: true, data: writes, name: "writes",
          lineStyle: { color: "oklch(74% 0.18 30)", width: 2 },
          showSymbol: false },
      ],
    }}/>
  );
}

function sevColor(s?: string) {
  if (s === "critical") return "text-danger";
  if (s === "warning")  return "text-warning";
  return "text-muted";
}
