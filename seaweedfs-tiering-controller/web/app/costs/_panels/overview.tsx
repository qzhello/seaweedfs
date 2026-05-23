"use client";

// Costs dashboard — Overview tab. Three layers:
//   1. Headline tiles — current monthly spend, savings vs all-hot-3x,
//      unrealised potential. Operator gets the bottom line in 3s.
//   2. Per-backend table — where the money is going right now.
//      Bars on the right surface the dominant tier.
//   3. Recommendations — rule-based suggestions ("$X/mo savings if
//      you tier this collection to that backend") + an AI button that
//      synthesizes drafts using the cost + temperature + telemetry
//      triad. Drafts can be created as Tasks one click at a time.

import { useState } from "react";
import {
  DollarSign, Sparkles, Snowflake, Flame, TrendingDown, Camera,
  Loader2, ArrowRight, AlertTriangle, CheckCircle2,
} from "lucide-react";
import Link from "next/link";
import {
  api, useCurrentCosts, useCostHistory, type AIMigrationProposal, type CollectionCostRow,
} from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { bytes as fmtBytes, pct } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { AIProposalActions } from "@/components/ai-proposal-actions";
import { ShowbackSection } from "../_showback";

export function CostsOverviewPanel() {
  const { t } = useT();
  return (
    <Can cap="cost.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data, error, mutate, isLoading, isValidating } = useCurrentCosts(clusterID || undefined);
  const { data: history } = useCostHistory(clusterID || undefined, 12);
  const [snapshotting, setSnapshotting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [proposals, setProposals] = useState<AIMigrationProposal[] | null>(null);
  const [planSummary, setPlanSummary] = useState("");

  if (!clusterID) {
    return (
      <div className="card p-6 text-sm text-muted">
        {t("Pick a cluster in the top-right to start.")}
      </div>
    );
  }

  const snapshot = async () => {
    setSnapshotting(true);
    try {
      await api.snapshotCosts(clusterID);
      toast.success(t("Snapshot saved"));
      mutate();
    } catch (e) {
      toast.fromError(e, t("Snapshot failed"));
    } finally {
      setSnapshotting(false);
    }
  };

  const askAI = async () => {
    setPlanning(true);
    setProposals(null);
    try {
      const r = await api.aiPlanMigrations(clusterID, { max_proposals: 5 });
      if (!r.ok) {
        toast.error(t("AI plan failed"), r.error ?? "");
        return;
      }
      setProposals(r.proposals ?? []);
      setPlanSummary(r.summary ?? "");
    } catch (e) {
      toast.fromError(e, t("AI plan failed"));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar (no page H1 — the tab strip in /costs provides title context) */}
      <div className="flex items-center justify-end gap-2">
        <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        <Can cap="cost.write">
          <button onClick={snapshot} disabled={snapshotting}
            className="btn text-xs inline-flex items-center gap-1.5">
            {snapshotting ? <Loader2 size={12} className="animate-spin"/> : <Camera size={12}/>}
            {t("Snapshot this month")}
          </button>
          <button onClick={askAI} disabled={planning}
            className="btn btn-primary text-xs inline-flex items-center gap-1.5">
            {planning ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
            {t("AI plan migrations")}
          </button>
        </Can>
      </div>

      {error && <ErrorPanel error={error}/>}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={6} headers={[t("Backend"), t("Bytes"), t("$ / TB / mo"), t("Monthly cost"), ""]}/>
        </section>
      ) : !data ? null : (
        <>
          <Headline t={t} data={data}/>

          {data.unpriced_bytes > 0 && (
            <div className="card p-3 border-warning/40 bg-warning/5 text-xs text-warning inline-flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5"/>
              <div>
                {t("{n} of storage is on backends with no pricing configured.").replace("{n}", fmtBytes(data.unpriced_bytes))}{" "}
                <Link href="/costs?tab=pricing" className="underline text-text">{t("Configure pricing")}</Link>{" "}
                {t("to include it in the monthly bill.")}
              </div>
            </div>
          )}

          <section className="card overflow-hidden">
            <header className="px-3 py-2 border-b border-border text-xs font-semibold inline-flex items-center gap-2">
              {t("Per-backend monthly spend")}
            </header>
            <table className="grid">
              <thead>
                <tr>
                  <th>{t("Backend")}</th>
                  <th>{t("Kind")}</th>
                  <th className="text-right">{t("Bytes")}</th>
                  <th className="text-right">{t("$ / TB / mo")}</th>
                  <th className="text-right">{t("Monthly cost")}</th>
                  <th>{t("Share")}</th>
                </tr>
              </thead>
              <tbody>
                {data.backends.map(b => {
                  const share = data.total_monthly_cost > 0 ? b.monthly_cost / data.total_monthly_cost : 0;
                  return (
                    <tr key={b.name}>
                      <td>
                        <div className="font-mono text-sm">{b.name}</div>
                        <div className="text-[11px] text-muted">{b.display_name}</div>
                      </td>
                      <td><span className="badge text-[10px]">{t(b.kind || "—")}</span></td>
                      <td className="text-right font-mono text-xs">{fmtBytes(b.physical_bytes)}</td>
                      <td className="text-right font-mono text-xs">
                        {b.has_pricing ? `${b.currency} ${b.price_per_tb_month.toFixed(2)}` : <span className="text-warning">—</span>}
                      </td>
                      <td className="text-right font-mono text-sm">
                        {b.has_pricing ? `${b.currency} ${b.monthly_cost.toFixed(2)}` : <span className="text-muted">{t("unpriced")}</span>}
                      </td>
                      <td className="min-w-[160px]">
                        <div className="h-1.5 bg-panel2 rounded overflow-hidden">
                          <div className="h-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }}/>
                        </div>
                        <div className="text-[10px] text-muted font-mono mt-0.5">{pct(share)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {data.top_collections.length > 0 && (
            <CollectionsTable t={t} rows={data.top_collections} currency={data.currency}/>
          )}

          {/* Showback — attribute spend to bucket owners / domains. */}
          <ShowbackSection clusterID={clusterID}/>

          {history && history.items.length > 0 && (
            <HistoryChart t={t} items={history.items} currency={data.currency}/>
          )}

          {/* AI proposals — only shown after Ask AI returns. */}
          {proposals !== null && (
            <ProposalsList t={t} summary={planSummary} proposals={proposals} clusterID={clusterID}/>
          )}

          {/* Rule-based recommendations always shown when present. */}
          {data.recommendations.length > 0 && (
            <RuleRecsTable t={t} recs={data.recommendations}/>
          )}

          {data.backends.length === 0 && (
            <EmptyState icon={DollarSign} title={t("No volumes to price yet")} hint={t("Once the cluster has volumes, this dashboard fills in. Make sure pricing is configured on the Pricing tab.")}/>
          )}
        </>
      )}
    </div>
  );
}

// ---- headline tiles ----

function Headline({ t, data }: { t: (k: string) => string; data: import("@/lib/api").CostsResponse }) {
  return (
    <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile icon={<DollarSign size={14}/>} label={t("Monthly spend")}
        value={`${data.currency} ${data.total_monthly_cost.toFixed(2)}`}
        sub={t("priced backends only")} tone="muted"/>
      <Tile icon={<Flame size={14}/>} label={t("All-hot 3x baseline")}
        value={`${data.currency} ${data.counterfactual_cost.toFixed(2)}`}
        sub={data.hot_reference_backend ? `${t("vs")} ${data.hot_reference_backend}` : t("no hot reference")} tone="rose"/>
      <Tile icon={<TrendingDown size={14}/>} label={t("Realised saving")}
        value={`${data.currency} ${data.monthly_saving.toFixed(2)}`}
        sub={data.counterfactual_cost > 0 ? `${pct(data.monthly_saving / data.counterfactual_cost)} ${t("vs baseline")}` : "—"}
        tone="emerald"/>
      <Tile icon={<Snowflake size={14}/>} label={t("Potential extra saving")}
        value={`${data.currency} ${data.recommendations.reduce((s, r) => s + r.monthly_saving, 0).toFixed(2)}`}
        sub={`${data.recommendations.length} ${t("recommendations")}`} tone="indigo"/>
    </section>
  );
}

function Tile({ icon, label, value, sub, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "muted" | "rose" | "emerald" | "indigo";
}) {
  const toneClass = {
    muted: "text-muted",
    rose: "text-danger",
    emerald: "text-success",
    indigo: "text-accent",
  }[tone];
  return (
    <div className="card p-3">
      <div className={`text-[11px] uppercase tracking-wide inline-flex items-center gap-1.5 ${toneClass}`}>
        {icon} {label}
      </div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}

// ---- per-collection table ----

function CollectionsTable({ t, rows, currency }: { t: (k: string) => string; rows: CollectionCostRow[]; currency: string }) {
  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border text-xs font-semibold">
        {t("Top collections by monthly cost")}
      </header>
      <table className="grid">
        <thead>
          <tr>
            <th>{t("Collection")}</th>
            <th className="text-right">{t("Bytes")}</th>
            <th className="text-right">{t("Monthly cost")}</th>
            <th>{t("Backend mix")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.collection || "__default__"}>
              <td className="font-mono text-sm">{r.collection || <span className="text-muted/60">{t("(default)")}</span>}</td>
              <td className="text-right font-mono text-xs">{fmtBytes(r.physical_bytes)}</td>
              <td className="text-right font-mono text-xs">{currency} {r.monthly_cost.toFixed(2)}</td>
              <td className="text-[11px] text-muted">
                {Object.entries(r.by_backend_bytes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k}: ${fmtBytes(v)}`)
                  .join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- history chart ----

function HistoryChart({ t, items, currency }: { t: (k: string) => string; items: import("@/lib/api").CostSnapshot[]; currency: string }) {
  // Group snapshots by month → totals across backends; render as a
  // horizontal scrollable bar list. Echarts would be nicer but this
  // page is read-only so we keep it dependency-free.
  const months = Array.from(new Set(items.map(i => i.year_month.slice(0, 7)))).sort();
  const totalByMonth: Record<string, { actual: number; counterfactual: number }> = {};
  for (const i of items) {
    const m = i.year_month.slice(0, 7);
    if (!totalByMonth[m]) totalByMonth[m] = { actual: 0, counterfactual: 0 };
    totalByMonth[m].actual += i.cost_estimate;
    totalByMonth[m].counterfactual += i.counterfactual_cost;
  }
  const maxVal = Math.max(1, ...months.map(m => totalByMonth[m]?.counterfactual ?? 0));
  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border text-xs font-semibold">
        {t("Last 12 months")}
      </header>
      <div className="p-3 overflow-x-auto">
        <div className="flex items-end gap-2 min-w-max h-32">
          {months.map(m => {
            const v = totalByMonth[m];
            return (
              <div key={m} className="flex flex-col items-center gap-0.5 w-12">
                <div className="flex-1 flex items-end gap-0.5 w-full">
                  <div className="bg-danger/40 w-1/2 rounded-t" title={t("counterfactual")}
                    style={{ height: `${(v.counterfactual / maxVal) * 100}%` }}/>
                  <div className="bg-accent w-1/2 rounded-t" title={t("actual")}
                    style={{ height: `${(v.actual / maxVal) * 100}%` }}/>
                </div>
                <div className="text-[9px] text-muted font-mono">{m.slice(5)}</div>
                <div className="text-[10px] tabular-nums">{currency} {v.actual.toFixed(0)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---- rule-based recommendations ----

function RuleRecsTable({ t, recs }: { t: (k: string) => string; recs: import("@/lib/api").CostRecommendation[] }) {
  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border text-xs font-semibold inline-flex items-center gap-2">
        <Snowflake size={12}/> {t("Unrealised savings (rule-based)")}
      </header>
      <table className="grid">
        <thead>
          <tr>
            <th>{t("Move")}</th>
            <th>{t("Collection")}</th>
            <th className="text-right">{t("Bytes")}</th>
            <th className="text-right">{t("Monthly saving")}</th>
            <th>{t("Rationale")}</th>
          </tr>
        </thead>
        <tbody>
          {recs.map((r, i) => (
            <tr key={i}>
              <td className="font-mono text-xs">{r.from_backend} <ArrowRight size={10} className="inline mx-0.5"/> {r.to_backend}</td>
              <td className="font-mono text-xs">{r.collection || "(default)"}</td>
              <td className="text-right font-mono text-xs">{fmtBytes(r.bytes)}</td>
              <td className="text-right font-mono text-sm text-success">{r.currency} {r.monthly_saving.toFixed(2)}</td>
              <td className="text-[11px] text-muted">{r.rationale}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- AI proposals ----

function ProposalsList({ t, summary, proposals, clusterID }: {
  t: (k: string) => string;
  summary: string;
  proposals: AIMigrationProposal[];
  clusterID: string;
}) {
  return (
    <section className="card overflow-hidden border-accent/40 bg-accent/[0.03]">
      <header className="px-3 py-2 border-b border-border inline-flex items-center gap-2 text-xs font-semibold">
        <Sparkles size={12} className="text-warning"/> {t("AI migration proposals")}
      </header>
      {summary && (
        <div className="px-3 py-2 text-xs text-muted border-b border-border italic">{summary}</div>
      )}
      {proposals.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted">
          <CheckCircle2 size={16} className="inline mr-1 text-success"/>
          {t("The AI didn't find any worthwhile migrations. Everything looks well-placed.")}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {proposals.map((p, i) => (
            <li key={i} className="p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{p.title}</div>
                  <div className="text-[11px] text-muted font-mono">
                    {p.collection || "(default)"} · {p.from_backend} → {p.to_backend} · {fmtBytes(p.bytes)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold text-success tabular-nums">
                    {p.currency} {p.monthly_saving.toFixed(2)}/mo
                  </div>
                  <div className="text-[10px] inline-flex gap-1.5 mt-0.5">
                    <span className={`badge ${
                      p.risk === "high" ? "border-danger/40 text-danger"
                      : p.risk === "medium" ? "border-warning/40 text-warning"
                      : "border-success/40 text-success"
                    }`}>{t("risk")}: {t(p.risk)}</span>
                    <span className="badge border-muted/40 text-muted">{t("conf")}: {t(p.confidence)}</span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted">{p.rationale}</p>
              {p.task_command && (
                <code className="block text-[11px] font-mono bg-black/30 p-2 rounded">{p.task_command}</code>
              )}
              <AIProposalActions clusterID={clusterID} proposal={p}/>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
