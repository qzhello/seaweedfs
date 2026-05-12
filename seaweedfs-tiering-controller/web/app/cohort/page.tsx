"use client";
import { useState } from "react";
import {
  useCohortBaselines, useCohortAnomalies, useCohortBreakdown, api,
} from "@/lib/api";
import {
  AlertTriangle, RefreshCw, TrendingUp, TrendingDown, Layers,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Pagination, usePagination } from "@/components/pagination";

interface Baseline {
  BusinessDomain: string;
  VolumeCount: number;
  MeanReadsPerByte: number;
  StddevReadsPerByte: number;
  P50Reads: number;
  P95Reads: number;
}
interface Breakdown { business_domain: string; counts: Record<string, number>; }
interface Anomaly {
  volume_id: number;
  business_domain: string;
  cycle_kind: string;
  reads_7d: number;
  reads_per_byte_7d: number;
  cohort_z_reads: number;
}

const KIND_COLOR: Record<string, string> = {
  daily:   "bg-accent",
  weekly:  "bg-accent/70",
  flat:    "bg-muted",
  spiky:   "bg-warning",
  unknown: "bg-panel2",
};

export default function CohortPage() {
  const [filter, setFilter] = useState<string>("");
  const { data: baselineRes, mutate: refetchBase }   = useCohortBaselines();
  const { data: anomalyRes,  mutate: refetchAnom }   = useCohortAnomalies(filter);
  const { data: breakdownRes,mutate: refetchBreak }  = useCohortBreakdown();
  const [refreshing, setRefreshing] = useState(false);

  const baselines: Baseline[] = baselineRes?.items ?? [];
  const anomalies: Anomaly[] = anomalyRes?.items ?? [];
  const pg = usePagination(anomalies, 20);
  const breakdown: Breakdown[] = breakdownRes?.items ?? [];
  const breakdownMap = Object.fromEntries(breakdown.map(b => [b.business_domain, b.counts]));

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await api.refreshAnalytics();
      await Promise.all([refetchBase(), refetchAnom(), refetchBreak()]);
    } finally {
      setRefreshing(false);
    }
  };

  const totalVolumes = baselines.reduce((sum, b) => sum + b.VolumeCount, 0);
  const totalAnomalies = anomalies.length;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-3">
            <Layers size={24} className="text-accent"/> Cohort overview
          </h1>
          <p className="text-sm text-muted">
            Cross-business-domain comparison · {totalVolumes} volumes · {baselines.length} cohorts ·
            <span className={totalAnomalies > 0 ? "text-danger ml-1" : "ml-1"}>
              {totalAnomalies} anomalies
            </span>
          </p>
        </div>
        <button onClick={refreshNow} disabled={refreshing}
          className="px-3 py-1.5 rounded-md border border-border hover:bg-panel2 text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/>
          {refreshing ? "Running…" : "Refresh"}
        </button>
      </header>

      {/* Domain filter chips */}
      <div className="flex flex-wrap gap-2 text-sm">
        <button onClick={() => setFilter("")}
          className={`px-3 py-1 rounded-full border ${filter === "" ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-muted hover:text-text"}`}>
          All
        </button>
        {baselines.map(b => (
          <button key={b.BusinessDomain} onClick={() => setFilter(b.BusinessDomain)}
            className={`px-3 py-1 rounded-full border ${filter === b.BusinessDomain ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-muted hover:text-text"}`}>
            {b.BusinessDomain} <span className="text-xs opacity-60">·{b.VolumeCount}</span>
          </button>
        ))}
      </div>

      {baselines.length === 0 ? (
        <EmptyState icon={Layers}
          title="No cohort baselines yet"
          hint="Wait for the next analytics pass (~1h) or click Refresh above."/>
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {baselines
            .filter(b => !filter || b.BusinessDomain === filter)
            .map(b => (
              <CohortCard key={b.BusinessDomain}
                baseline={b}
                breakdown={breakdownMap[b.BusinessDomain] ?? {}}
                anomalies={anomalies.filter(a => a.business_domain === b.BusinessDomain)}/>
            ))}
        </section>
      )}

      {/* Global outlier table */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
          <AlertTriangle size={18} className="text-danger"/>
          Anomalous volumes (|z| ≥ {anomalyRes?.threshold ?? 3})
        </h2>
        {anomalies.length === 0 ? (
          <div className="text-sm text-muted">No volumes crossed the threshold.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th>Volume</th><th>Domain</th><th>Cycle</th><th>Z-score</th><th>7d reads</th><th>reads/byte</th></tr>
            </thead>
            <tbody>
              {pg.slice.map(a => (
                <tr key={a.volume_id}>
                  <td><a href={`/volumes/${a.volume_id}`} className="text-accent hover:underline font-mono">{a.volume_id}</a></td>
                  <td><span className="badge">{a.business_domain}</span></td>
                  <td><span className="text-xs">{a.cycle_kind}</span></td>
                  <td className={Math.abs(a.cohort_z_reads) >= 5 ? "text-danger font-semibold" : "text-warning"}>
                    {a.cohort_z_reads >= 0 ? <TrendingUp size={12} className="inline mr-1"/> : <TrendingDown size={12} className="inline mr-1"/>}
                    {a.cohort_z_reads.toFixed(2)}
                  </td>
                  <td className="font-mono">{a.reads_7d.toLocaleString()}</td>
                  <td className="font-mono text-xs text-muted">{a.reads_per_byte_7d.toExponential(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {anomalies.length > 0 && <Pagination {...pg}/>}
      </section>
    </div>
  );
}

function CohortCard({
  baseline, breakdown, anomalies,
}: {
  baseline: Baseline;
  breakdown: Record<string, number>;
  anomalies: Anomaly[];
}) {
  const total = Object.values(breakdown).reduce((s, n) => s + n, 0) || baseline.VolumeCount || 1;
  const order = ["daily", "weekly", "flat", "spiky", "unknown"];
  const tone =
    anomalies.length === 0 ? "border-border"
    : anomalies.length >= 3 ? "border-danger/50"
    : "border-warning/50";

  return (
    <div className={`card p-5 border ${tone}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-semibold capitalize">{baseline.BusinessDomain}</div>
          <div className="text-xs text-muted">{baseline.VolumeCount} vols</div>
        </div>
        {anomalies.length > 0 && (
          <span className="px-2 py-0.5 rounded-md border border-danger/40 bg-danger/10 text-danger text-xs">
            {anomalies.length} anomaly
          </span>
        )}
      </div>

      {/* Stacked composition bar */}
      <div className="h-2 rounded-full overflow-hidden bg-panel2 flex mb-1.5">
        {order.map(k => {
          const n = breakdown[k] ?? 0;
          if (!n) return null;
          return <div key={k} className={KIND_COLOR[k] ?? "bg-muted"} style={{ width: `${(n / total) * 100}%` }}/>;
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted mb-3">
        {order.map(k => breakdown[k] ? (
          <span key={k} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-sm ${KIND_COLOR[k] ?? "bg-muted"}`}/>
            {k} <span className="text-text">{breakdown[k]}</span>
          </span>
        ) : null)}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs border-t border-border pt-3">
        <Row label="μ reads/byte" value={baseline.MeanReadsPerByte.toExponential(2)}/>
        <Row label="σ"            value={baseline.StddevReadsPerByte.toExponential(2)}/>
        <Row label="P50 reads"    value={baseline.P50Reads.toLocaleString()}/>
        <Row label="P95 reads"    value={baseline.P95Reads.toLocaleString()}/>
      </div>

      {anomalies.length > 0 && (
        <div className="mt-3 border-t border-border pt-3 space-y-1">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">Top 3 outliers</div>
          {anomalies.slice(0, 3).map(a => (
            <a key={a.volume_id} href={`/volumes/${a.volume_id}`}
              className="flex items-center justify-between text-xs hover:bg-panel2 px-2 py-1 rounded -mx-2">
              <span className="font-mono text-accent">#{a.volume_id}</span>
              <span className={Math.abs(a.cohort_z_reads) >= 5 ? "text-danger" : "text-warning"}>
                z={a.cohort_z_reads.toFixed(2)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className="text-right font-mono">{value}</span>
    </>
  );
}
