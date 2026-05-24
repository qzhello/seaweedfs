"use client";

// Bucket-level cost plan panel.
//
// Per-bucket lifecycle proposals from the AI: set_quota, cleanup_uploads,
// review_for_deletion, investigate_tiering. Each proposal has a one-click
// Apply (where actionable) or a "Mark reviewed" (for advisory items).
//
// Counterfactual: every Apply / Discard click feeds back into
// /ai/bucket-cost-learning so the AI Learning panel can show whether
// proposals are getting accepted.

import { useState } from "react";
import {
  Sparkles, Loader2, ShieldCheck, Shield, ShieldAlert,
  ArrowRight, Check, X, Lightbulb, Wrench, AlertTriangle, Trash2,
} from "lucide-react";
import { api, bucketCostPlan, bucketCostPlanDecide,
         useBucketCostLearning, type BucketCostProposal } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { toast } from "@/lib/toast";
import { confirm as confirmDlg } from "@/lib/confirm";

export function BucketCostPlanPanel() {
  const { t } = useT();
  return (
    <Can cap="cost.write" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [loading, setLoading]   = useState(false);
  const [hint, setHint]         = useState("");
  const [summary, setSummary]   = useState<string>("");
  const [proposals, setProps]   = useState<BucketCostProposal[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [error, setError]       = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [empty, setEmpty]       = useState<string | null>(null);
  const [decided, setDecided]   = useState<Record<string, "approved" | "discarded">>({});

  const learning = useBucketCostLearning(168);

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async () => {
    setLoading(true); setError(null); setEmpty(null); setWarnings([]); setProps([]); setSummary("");
    try {
      const r = await bucketCostPlan(clusterID, { extra_context: hint || undefined });
      if (r.empty) { setEmpty(r.message || t("No bucket telemetry yet.")); return; }
      if (!r.ok)   { setError(r.error || t("AI call failed.")); return; }
      setSummary(r.summary || "");
      setProps(r.proposals || []);
      setCurrency(r.currency || "USD");
      setWarnings(r.warnings || []);
      setDecided({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <LearningCard data={learning.data} />

      <section className="card p-4">
        <header className="mb-3 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <Sparkles size={14}/> {t("Plan bucket lifecycle (AI)")}
          </div>
          <span className="text-[11px] text-muted">{t("Read-only until you click Apply on a proposal.")}</span>
        </header>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="text-xs">
            <span className="block text-muted">{t("Operator hint (optional)")}</span>
            <input
              className="input w-full"
              placeholder={t("e.g. focus on archive buckets, ignore logs-*")}
              value={hint}
              onChange={e => setHint(e.target.value)}
              disabled={loading}
            />
          </label>
          <button className="btn inline-flex items-center gap-1.5" onClick={run} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
            {loading ? t("Planning…") : t("Generate plan")}
          </button>
        </div>
        {error && <div className="mt-3 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger">{error}</div>}
        {empty && <div className="mt-3 rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">{empty}</div>}
        {warnings.length > 0 && (
          <div className="mt-3 rounded border border-warning/30 bg-warning/5 p-2 text-[11px] text-warning">
            <div className="mb-1 inline-flex items-center gap-1"><AlertTriangle size={12}/> {t("Warnings")}</div>
            <ul className="ml-4 list-disc">{warnings.map((w,i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
        {summary && (
          <p className="mt-3 rounded bg-panel2 p-2 text-xs">{summary}</p>
        )}
      </section>

      {proposals.length > 0 && (
        <section className="space-y-2">
          <div className="text-xs text-muted">
            {t("{n} proposal(s) · est. saving {amount} {ccy}/month").replace(
              "{n}", String(proposals.length)).replace(
              "{amount}", proposals.reduce((s, p) => s + (p.est_monthly_saving || 0), 0).toFixed(2)).replace(
              "{ccy}", currency)}
          </div>
          {proposals.map((p) => (
            <ProposalCard
              key={p.proposal_id || `${p.bucket}-${p.action}`}
              p={p}
              clusterID={clusterID}
              currency={currency}
              state={p.proposal_id ? decided[p.proposal_id] : undefined}
              onResolved={(verdict) => {
                if (p.proposal_id) setDecided(prev => ({ ...prev, [p.proposal_id!]: verdict }));
              }}
            />
          ))}
        </section>
      )}
    </div>
  );
}

// ---- Per-proposal card ----

function ProposalCard({ p, clusterID, currency, state, onResolved }: {
  p: BucketCostProposal;
  clusterID: string;
  currency: string;
  state?: "approved" | "discarded";
  onResolved: (verdict: "approved" | "discarded") => void;
}) {
  const { t } = useT();
  const [applying, setApplying] = useState(false);
  const meta = actionMeta(p.action, t);
  const value = p.value as Record<string, unknown>;

  const discard = async () => {
    if (!p.proposal_id) { onResolved("discarded"); return; }
    try {
      await bucketCostPlanDecide(p.proposal_id, { decision: "discarded" });
      onResolved("discarded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      // Some actions are advisory only — there's nothing to "apply".
      // For those we still record approval so the learning panel sees signal.
      let applied: Record<string, unknown> = {};
      switch (p.action) {
        case "set_quota": {
          const quotaMB = Number(value?.quota_mb ?? 0);
          if (!quotaMB) throw new Error("missing quota_mb");
          if (!(await confirmDlg.warning({
            title: t("Set quota on {bucket}?").replace("{bucket}", p.bucket),
            body:  t("Set quota to {n} MB. This may reject future writes once the bucket fills.").replace("{n}", String(quotaMB)),
          }))) { setApplying(false); return; }
          await api.s3BucketQuota(clusterID, { name: p.bucket, size_mb: quotaMB });
          applied = { quota_mb: quotaMB };
          break;
        }
        case "cleanup_uploads": {
          const olderHours = Number(value?.older_than_hours ?? 24);
          await api.s3CleanUploads(clusterID, `${olderHours}h`);
          applied = { older_than_hours: olderHours };
          break;
        }
        case "review_for_deletion":
        case "investigate_tiering":
          applied = {};
          break;
      }
      if (p.proposal_id) {
        await bucketCostPlanDecide(p.proposal_id, { decision: "approved", applied_value: applied });
      }
      onResolved("approved");
      toast.success(t("Recorded"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  if (state) {
    return (
      <div className="card flex items-center justify-between gap-3 p-3 opacity-60">
        <span className="inline-flex items-center gap-2 text-xs">
          {state === "approved" ? <Check size={12} className="text-success"/> : <X size={12} className="text-muted"/>}
          <span className="font-mono">{p.bucket}</span>
          <span className="text-muted">— {meta.label}</span>
        </span>
        <span className="text-[11px] text-muted">{state === "approved" ? t("Recorded") : t("Discarded")}</span>
      </div>
    );
  }

  return (
    <article className="card p-3">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <meta.icon size={14} className={meta.color}/> {meta.label}
            <span className="ml-1 text-muted">·</span>
            <span className="font-mono text-xs">{p.bucket}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <RiskBadge risk={p.risk}/>
            {p.confidence && <span className="badge text-[10px]">{t("Confidence")}: {p.confidence}</span>}
            {p.est_monthly_saving > 0 && (
              <span className="badge bg-success/15 text-success border-success/30 text-[10px]">
                ≈ {p.est_monthly_saving.toFixed(2)} {currency}/{t("month")}
              </span>
            )}
            {p.action === "set_quota" && value?.quota_mb && (
              <span className="badge text-[10px]">{t("Quota")}: {String(value.quota_mb)} MB</span>
            )}
            {p.action === "cleanup_uploads" && value?.older_than_hours && (
              <span className="badge text-[10px]">{t("Older than")}: {String(value.older_than_hours)}h</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button className="btn text-xs" onClick={discard} disabled={applying}>
            <X size={12}/> {t("Discard")}
          </button>
          <button className="btn text-xs bg-success/15 text-success border-success/40" onClick={apply} disabled={applying}>
            {applying ? <Loader2 size={12} className="animate-spin"/> : <ArrowRight size={12}/>}
            {meta.applyLabel}
          </button>
        </div>
      </header>
      <p className="text-xs text-muted">{p.explanation}</p>
    </article>
  );
}

// ---- Action meta ----

function actionMeta(a: BucketCostProposal["action"], t: (k: string) => string) {
  switch (a) {
    case "set_quota":           return { label: t("Set quota"),           icon: Wrench,    color: "text-accent",  applyLabel: t("Apply quota") };
    case "cleanup_uploads":     return { label: t("Cleanup uploads"),     icon: Wrench,    color: "text-accent",  applyLabel: t("Run cleanup") };
    case "review_for_deletion": return { label: t("Review for deletion"), icon: Trash2,    color: "text-warning", applyLabel: t("Mark reviewed") };
    case "investigate_tiering": return { label: t("Investigate tiering"), icon: Lightbulb, color: "text-warning", applyLabel: t("Mark reviewed") };
  }
}

function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const { t } = useT();
  const config = {
    low:    { label: t("Low risk"),    cls: "bg-success/15 text-success border-success/30",   icon: ShieldCheck },
    medium: { label: t("Medium risk"), cls: "bg-warning/15 text-warning border-warning/30",   icon: Shield },
    high:   { label: t("High risk"),   cls: "bg-danger/15  text-danger  border-danger/30",    icon: ShieldAlert },
  } as const;
  const { label, cls, icon: Icon } = config[risk] ?? config.medium;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <Icon size={11}/> {label}
    </span>
  );
}

// ---- Learning summary ----

function LearningCard({ data }: { data?: import("@/lib/api").BucketCostLearningResp }) {
  const { t } = useT();
  if (!data || data.total === 0) return null;
  return (
    <section className="card p-3">
      <header className="mb-2 inline-flex items-center gap-2 text-sm">
        <Sparkles size={14}/> <span className="font-medium">{t("Bucket plan acceptance (7d)")}</span>
        <span className="text-[11px] text-muted">{t("Approved or edited proposals out of total")}</span>
      </header>
      <div className="grid gap-2 sm:grid-cols-4 text-xs">
        <Stat label={t("Total")}        value={String(data.total)}/>
        <Stat label={t("Accept rate")}  value={`${(data.accept_rate * 100).toFixed(0)}%`}/>
        <Stat label={t("Open")}         value={String(data.open_proposals)}/>
        <Stat label={t("Saving recorded")} value={`${data.realised_saving.toFixed(2)} ${data.currency}`}/>
      </div>
      {data.by_action.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {data.by_action.map(a => (
            <span key={a.action} className="badge">
              {a.action}: <span className="font-mono">{a.approved}/{a.total}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-panel2 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}
