"use client";
import { useParams } from "next/navigation";
import { useVolumePattern, useCohortBaselines } from "@/lib/api";
import dynamic from "next/dynamic";
import {
  Activity, Database, Sparkles, AlertTriangle, TrendingUp, TrendingDown,
} from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface PatternResp {
  volume_id: number;
  business_domain: string;
  acf_24h: number;
  acf_168h: number;
  cycle_kind: "daily" | "weekly" | "flat" | "spiky" | "unknown";
  reads_7d: number;
  reads_per_byte_7d: number;
  cohort_z_reads: number;
  sparkline_168h: number[];
  is_anomalous: boolean;
  thresholds: { anomaly_z: number };
}

interface BaselineRow {
  BusinessDomain: string;
  VolumeCount: number;
  MeanReadsPerByte: number;
  StddevReadsPerByte: number;
  P50Reads: number;
  P95Reads: number;
}

const CYCLE_LABEL: Record<PatternResp["cycle_kind"], { label: string; tone: string; help: string }> = {
  daily:   { label: "Daily",     tone: "text-accent",   help: "Hot during business hours, cold at night; strong daily ACF correlation" },
  weekly:  { label: "Weekly",     tone: "text-accent",   help: "Weekend/weekday pattern; strong weekly ACF correlation" },
  flat:    { label: "Flat",       tone: "text-muted",    help: "Steady access, no peaks" },
  spiky:   { label: "Spiky",       tone: "text-warning",  help: "Sporadic bursts, no pattern — unsafe to cold-tier" },
  unknown: { label: "Insufficient data",   tone: "text-muted",    help: "Less than 48h of samples" },
};

export default function VolumeProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error } = useVolumePattern(id);
  const { data: baselines } = useCohortBaselines();
  const pat = p as PatternResp | undefined;

  const myBaseline: BaselineRow | undefined = (baselines?.items ?? [])
    .find((b: BaselineRow) => b.BusinessDomain === pat?.business_domain);

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Volumes", href: "/volumes" }, { label: `#${id}` }]}/>
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-3">
            <Database size={24} className="text-accent"/> Volume #{id}
          </h1>
          <p className="text-sm text-muted">Access pattern · cohort comparison · 7-day sparkline</p>
        </div>
        {pat?.is_anomalous && (
          <div className="px-4 py-2 rounded-md border border-danger/40 bg-danger/10 text-danger flex items-center gap-2 animate-pulse">
            <AlertTriangle size={18}/>
            <span className="font-medium">Anomaly: |z|={Math.abs(pat.cohort_z_reads).toFixed(1)} ≥ {pat.thresholds.anomaly_z}</span>
          </div>
        )}
      </header>

      {error && <div className="card p-4 text-danger">No pattern snapshot yet — wait for the next analytics pass (~1h).</div>}
      {!pat && !error && <div className="card p-6 text-muted">Loading…</div>}

      {pat && (
        <>
          {/* KPI strip */}
          <section className="grid grid-cols-5 gap-4">
            <KPI icon={<Sparkles size={18}/>} label="Cycle type"
              value={<span className={CYCLE_LABEL[pat.cycle_kind].tone}>{CYCLE_LABEL[pat.cycle_kind].label}</span>}
              help={CYCLE_LABEL[pat.cycle_kind].help}/>
            <KPI icon={<Activity size={18}/>} label="ACF 24h"  value={pat.acf_24h.toFixed(2)}  help="Daily ACF ≥0.5 → daily cycle"/>
            <KPI icon={<Activity size={18}/>} label="ACF 168h" value={pat.acf_168h.toFixed(2)} help="Weekly ACF ≥0.5 → weekly cycle"/>
            <KPI icon={<TrendingUp size={18}/>} label="7d reads" value={pat.reads_7d.toLocaleString()}/>
            <KPI icon={pat.cohort_z_reads >= 0 ? <TrendingUp size={18}/> : <TrendingDown size={18}/>}
                 label={`Cohort Z (${pat.business_domain})`}
                 value={<span className={Math.abs(pat.cohort_z_reads) >= 3 ? "text-danger" : ""}>{pat.cohort_z_reads.toFixed(2)}</span>}
                 help="Z-score within the business domain; |z|≥3 is anomalous"/>
          </section>

          {/* Sparkline */}
          <section className="card p-5">
            <h2 className="text-lg font-medium mb-3">7-day access trace (hourly reads)</h2>
            <Sparkline series={pat.sparkline_168h ?? []}/>
          </section>

          {/* Cohort comparison */}
          <section className="grid grid-cols-2 gap-4">
            <div className="card p-5">
              <h2 className="text-lg font-medium mb-3">Cohort baseline ({pat.business_domain})</h2>
              {myBaseline ? (
                <BaselineTable b={myBaseline} myReadsPerByte={pat.reads_per_byte_7d}/>
              ) : (
                <div className="text-sm text-muted">No baseline for domain "{pat.business_domain}" yet.</div>
              )}
            </div>
            <div className="card p-5">
              <h2 className="text-lg font-medium mb-3">Reads-per-byte distribution</h2>
              {myBaseline && (
                <DistributionGauge me={pat.reads_per_byte_7d} mean={myBaseline.MeanReadsPerByte} stddev={myBaseline.StddevReadsPerByte}/>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function KPI({ icon, label, value, help }: { icon: React.ReactNode; label: string; value: React.ReactNode; help?: string }) {
  return (
    <div className="card p-4" title={help}>
      <div className="text-xs text-muted flex items-center gap-1.5">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1.5 tabular-nums">{value}</div>
    </div>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (!series.length) return <div className="text-sm text-muted">No data.</div>;
  // Build hour labels relative to now (rightmost = now).
  const now = new Date();
  const labels = series.map((_, i) => {
    const t = new Date(now.getTime() - (series.length - 1 - i) * 3600 * 1000);
    return t.getHours() === 0 ? `${t.getMonth() + 1}/${t.getDate()}` : "";
  });
  return (
    <ReactECharts style={{ height: 200 }} option={{
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" },
      grid: { top: 10, left: 50, right: 20, bottom: 30 },
      xAxis: { type: "category", data: labels, axisLabel: { color: "#888", interval: 23 } },
      yAxis: { type: "value", axisLabel: { color: "#888" }, splitLine: { lineStyle: { color: "#222" } } },
      series: [{
        type: "line", smooth: true, showSymbol: false,
        data: series,
        areaStyle: { opacity: 0.2, color: "oklch(74% 0.18 230)" },
        lineStyle: { color: "oklch(74% 0.18 230)", width: 2 },
      }],
    }}/>
  );
}

function BaselineTable({ b, myReadsPerByte }: { b: BaselineRow; myReadsPerByte: number }) {
  const rows: [string, string][] = [
    ["Volumes in cohort", b.VolumeCount.toString()],
    ["Mean reads/byte",   b.MeanReadsPerByte.toExponential(2)],
    ["Stddev",            b.StddevReadsPerByte.toExponential(2)],
    ["This volume",       myReadsPerByte.toExponential(2)],
    ["P50 reads (7d)",    b.P50Reads.toLocaleString()],
    ["P95 reads (7d)",    b.P95Reads.toLocaleString()],
  ];
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-border last:border-0">
            <td className="py-1.5 text-muted">{k}</td>
            <td className="py-1.5 text-right font-mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DistributionGauge({ me, mean, stddev }: { me: number; mean: number; stddev: number }) {
  // Visualize as a horizontal bar: μ-3σ … μ-σ … μ … μ+σ … μ+3σ ; pin "me".
  const max = mean + 3 * stddev;
  const min = Math.max(0, mean - 3 * stddev);
  const span = Math.max(max - min, 1e-12);
  const pct = Math.min(100, Math.max(0, ((me - min) / span) * 100));
  const meanPct = ((mean - min) / span) * 100;
  return (
    <div className="space-y-3">
      <div className="relative h-12 rounded-md bg-gradient-to-r from-success/15 via-success/10 to-danger/20 border border-border">
        <div className="absolute top-0 bottom-0 w-px bg-muted/60" style={{ left: `${meanPct}%` }}/>
        <div className="absolute -top-1 -bottom-1 w-1 rounded bg-accent shadow-lg shadow-accent/50"
             style={{ left: `calc(${pct}% - 2px)` }}/>
      </div>
      <div className="grid grid-cols-3 text-xs text-muted">
        <span>μ-3σ {min.toExponential(1)}</span>
        <span className="text-center">μ {mean.toExponential(1)}</span>
        <span className="text-right">μ+3σ {max.toExponential(1)}</span>
      </div>
      <div className="text-xs text-accent">▲ this volume = {me.toExponential(2)}</div>
    </div>
  );
}
