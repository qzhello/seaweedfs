"use client";

// Fleet cost panel — cross-cluster aggregation + 3-month linear forecast.
//
// The chart is pure CSS bars (matching overview.tsx's style choice).
// Forecast points are visually distinct from observed points so the
// operator never confuses a projection with a real measurement.
//
// AI explainer is optional and clearly labelled as commentary — the
// numeric forecast is independent of it.

import { useState } from "react";
import { DollarSign, TrendingUp, TrendingDown, Minus, Sparkles } from "lucide-react";
import { useFleetCost, type FleetMonthPoint, type FleetClusterRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { bytes as fmtBytes } from "@/lib/utils";

export function FleetCostPanel() {
  const { t } = useT();
  return (
    <Can cap="cost.read" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const [months, setMonths]   = useState(12);
  const [explain, setExplain] = useState(false);
  const { data, error, isLoading, isValidating, mutate } = useFleetCost(months, explain);

  if (error)     return <ErrorPanel error={error}/>;
  if (isLoading) return <div className="card p-6 text-sm text-muted">{t("Loading…")}</div>;
  if (!data)     return null;

  const hasData = data.series.length > 0;

  return (
    <div className="space-y-5">
      <section className="card p-4">
        <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="inline-flex items-center gap-2 text-base font-semibold">
              <DollarSign size={16}/> {t("Fleet cost overview")}
            </h2>
            <p className="text-xs text-muted">
              {t("Aggregated monthly snapshots across all clusters, with a 3-month linear forecast.")}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs">
              <span className="block text-muted">{t("History window")}</span>
              <select className="input" value={months} onChange={e => setMonths(Number(e.target.value))}>
                <option value={6}>6 {t("months")}</option>
                <option value={12}>12 {t("months")}</option>
                <option value={18}>18 {t("months")}</option>
                <option value={24}>24 {t("months")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={explain} onChange={e => { setExplain(e.target.checked); mutate(); }}/>
              <Sparkles size={12}/> {t("AI explainer")}
            </label>
          </div>
        </header>

        {!hasData ? (
          <p className="rounded bg-panel2 p-3 text-xs text-muted">
            {t("No cost snapshots yet. Run \"Snapshot now\" on a per-cluster Overview tab to seed the timeline.")}
          </p>
        ) : (
          <>
            <ForecastChip trend={data.forecast_trend} slope={data.slope} currency={data.currency}/>
            <FleetChart series={data.series} currency={data.currency}/>
            {data.ai_explainer && (
              <div className="mt-3 rounded border border-accent/30 bg-accent/5 p-3 text-xs">
                <div className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                  <Sparkles size={11}/> {t("AI commentary")}
                  {data.ai_provider && <span className="ml-1 text-muted">· {data.ai_provider}</span>}
                </div>
                <p className="whitespace-pre-wrap text-muted">{data.ai_explainer}</p>
                <p className="mt-1 text-[10px] text-muted">{t("Commentary is informational; the forecast numbers above are computed from regression, not AI.")}</p>
              </div>
            )}
          </>
        )}
        {isValidating && hasData && (
          <p className="mt-2 text-[10px] text-muted">{t("Refreshing…")}</p>
        )}
      </section>

      {data.clusters.length > 0 && (
        <ClusterTable rows={data.clusters} currency={data.currency}/>
      )}
    </div>
  );
}

// ---- Forecast trend chip ----

function ForecastChip({ trend, slope, currency }: { trend: string; slope: number; currency: string }) {
  const { t } = useT();
  const cfg = {
    rising:             { icon: TrendingUp,   cls: "text-warning border-warning/40 bg-warning/10", label: t("Rising") },
    falling:            { icon: TrendingDown, cls: "text-success border-success/40 bg-success/10", label: t("Falling") },
    flat:               { icon: Minus,        cls: "text-muted   border-divider     bg-panel2",    label: t("Flat") },
    insufficient_data:  { icon: Minus,        cls: "text-muted   border-divider     bg-panel2",    label: t("Insufficient data") },
  }[trend] ?? { icon: Minus, cls: "text-muted border-divider bg-panel2", label: t("Unknown") };
  const Icon = cfg.icon;
  return (
    <div className={`mb-3 inline-flex items-center gap-2 rounded border px-2 py-1 text-xs font-medium ${cfg.cls}`}>
      <Icon size={12}/> {cfg.label}
      {trend !== "insufficient_data" && (
        <span className="font-mono text-[11px] text-muted">
          {slope >= 0 ? "+" : ""}{slope.toFixed(2)} {currency}/{t("month")}
        </span>
      )}
    </div>
  );
}

// ---- Chart ----

function FleetChart({ series, currency }: { series: FleetMonthPoint[]; currency: string }) {
  const { t } = useT();
  const max = Math.max(1, ...series.map(p => Math.max(p.cost_estimate, p.counterfactual_cost || 0)));
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold">{t("Fleet monthly cost")}</header>
      <div className="overflow-x-auto p-3">
        <div className="flex min-w-max h-40 items-end gap-1.5">
          {series.map(p => {
            const h = (p.cost_estimate / max) * 100;
            const cfH = ((p.counterfactual_cost || 0) / max) * 100;
            return (
              <div key={p.year_month} className="flex w-14 flex-col items-center gap-0.5">
                <div className="flex w-full flex-1 items-end gap-0.5">
                  {!p.forecast && p.counterfactual_cost > 0 && (
                    <div className="w-1/2 rounded-t bg-danger/30" title={t("counterfactual")} style={{ height: `${cfH}%` }}/>
                  )}
                  <div
                    className={`w-1/2 rounded-t ${p.forecast ? "bg-accent/40 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.08)_4px,rgba(0,0,0,0.08)_5px)]" : "bg-accent"}`}
                    title={p.forecast ? t("forecast") : t("actual")}
                    style={{ height: `${h}%` }}
                  />
                </div>
                <div className={`font-mono text-[9px] ${p.forecast ? "text-accent" : "text-muted"}`}>
                  {p.year_month.slice(2)}
                </div>
                <div className="text-[10px] tabular-nums">
                  {currency} {p.cost_estimate.toFixed(0)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-accent"/> {t("Observed")}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-accent/40 [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(0,0,0,0.08)_3px,rgba(0,0,0,0.08)_4px)]"/> {t("Forecast")}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-danger/30"/> {t("Counterfactual (all-hot)")}</span>
        </div>
      </div>
    </section>
  );
}

// ---- Per-cluster table ----

function ClusterTable({ rows, currency }: { rows: FleetClusterRow[]; currency: string }) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold">{t("Clusters this month (ranked)")}</header>
      <table className="grid w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">{t("Cluster")}</th>
            <th className="text-right">{t("Cost")}</th>
            <th className="text-right">{t("Physical bytes")}</th>
            <th className="text-right">{t("MoM Δ")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.cluster_id}>
              <td className="font-mono">{r.name}</td>
              <td className="text-right tabular-nums">{currency} {r.cost_estimate.toFixed(2)}</td>
              <td className="text-right tabular-nums">{fmtBytes(r.physical_bytes)}</td>
              <td className="text-right">
                {r.has_mom_base ? (
                  <span className={`tabular-nums ${r.mom_delta > 5 ? "text-warning" : r.mom_delta < -5 ? "text-success" : "text-muted"}`}>
                    {r.mom_delta >= 0 ? "+" : ""}{r.mom_delta.toFixed(1)}%
                  </span>
                ) : <span className="text-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
