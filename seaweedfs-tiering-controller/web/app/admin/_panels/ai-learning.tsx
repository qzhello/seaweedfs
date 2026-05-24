"use client";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { useAILearning, useAIS3Learning, useAIS3LimitLearning } from "@/lib/api";
import type { AIS3LearningResp, AIS3LimitLearningResp } from "@/lib/api";
import {
  Brain, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, ShieldAlert, UserCheck, Bot, Key, Gauge,
} from "lucide-react";
import { useT } from "@/lib/i18n";

interface AccuracyRow {
  verdict: "proceed" | "abort" | "needs_human";
  provider_name?: string;
  business_domain?: string;
  total: number;
  correct: number;
  accuracy_rate: number;
  avg_confidence: number;
}

interface Outcome {
  id: string;
  review_id: string;
  task_id: string;
  observation_hours: number;
  verdict: "proceed" | "abort" | "needs_human";
  confidence?: number;
  was_correct: boolean;
  evidence: string;
  reads_after?: number;
  re_warmed?: boolean;
  abort_was_safe?: boolean;
  business_domain: string;
  provider_name: string;
  created_at: string;
}

interface LearningResp {
  hours: number;
  by_provider: AccuracyRow[];
  by_domain: AccuracyRow[];
  recent_outcomes: Outcome[];
}

const HORIZONS: { hours: number; label: string }[] = [
  { hours: 24,  label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
];

const VERDICT_TONE: Record<AccuracyRow["verdict"], { tone: string; icon: JSX.Element; label: string }> = {
  proceed:     { tone: "text-success", icon: <ShieldCheck size={14}/>,  label: "PROCEED" },
  abort:       { tone: "text-danger",  icon: <ShieldAlert size={14}/>, label: "ABORT" },
  needs_human: { tone: "text-warning", icon: <UserCheck size={14}/>,   label: "NEEDS HUMAN" },
};

export function AILearningPanel() {
  const { t } = useT();
  const [hours, setHours] = useState(24);
  const { data } = useAILearning(hours);
  const resp = data as LearningResp | undefined;

  // Aggregate totals for the headline stat strip.
  const totals = (resp?.by_provider ?? []).reduce(
    (acc, r) => {
      acc.total += r.total;
      acc.correct += r.correct;
      return acc;
    },
    { total: 0, correct: 0 }
  );
  const overallRate = totals.total > 0 ? (totals.correct / totals.total) : 0;

  return (
    <div className="space-y-6">
      {/* Toolbar — page title lives in the /ai tab strip */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted max-w-2xl">
          {t("After {h}h we look back at actual access and auto-grade whether the verdict was right.").replace("{h}", String(hours))}
          {t("Thresholds live under Settings → ai_review.*")}
        </p>
        <div className="flex gap-1 text-xs">
          {HORIZONS.map(h => (
            <button key={h.hours} onClick={() => setHours(h.hours)}
              className={`px-3 py-1.5 rounded-md border ${hours === h.hours ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-muted hover:text-text"}`}>
              {h.label}
            </button>
          ))}
        </div>
      </div>

      {/* Headline KPIs */}
      <section className="grid grid-cols-4 gap-4">
        <BigStat label={t("Total verdicts")}
          value={totals.total.toLocaleString()}/>
        <BigStat label={t("Correct")}
          value={totals.correct.toLocaleString()}
          tone="text-success"/>
        <BigStat label={t("Accuracy")}
          value={`${(overallRate * 100).toFixed(1)}%`}
          tone={overallRate >= 0.85 ? "text-success" : overallRate >= 0.70 ? "text-warning" : "text-danger"}/>
        <BigStat label={t("Observation window")}
          value={`${hours}h`}/>
      </section>

      {/* By provider */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">{t("By provider")}</h2>
        {(resp?.by_provider?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted">{t("No annotations yet —")}{" "}
            {t("wait {n} day(s) after tasks run.").replace("{n}", String(Math.max(1, Math.round(hours / 24))))}
          </div>
        ) : (
          <AccuracyTable rows={resp!.by_provider} bucketLabel={t("Provider")}/>
        )}
      </section>

      {/* By business domain */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">{t("By business domain")}</h2>
        {(resp?.by_domain?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted">{t("No annotations yet.")}</div>
        ) : (
          <DomainTable rows={resp!.by_domain}/>
        )}
      </section>

      {/* S3 policy proposals — counterfactual learning for the NL → IAM
          generator. Sourced from a separate table (ai_s3_proposals) so
          it stays decoupled from the task-bound verdict pipeline. */}
      <S3ProposalsCard hours={hours} />

      {/* Circuit-breaker limit proposals — second S3 AI advisor surface.
          Same lifecycle, different payload (type/value instead of
          actions/buckets). Rendered as its own card so operators can
          tell the two streams apart. */}
      <S3LimitProposalsCard hours={hours} />

      {/* Recent outcomes feed */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">{t("Recent annotations")}</h2>
        <div className="space-y-1.5 max-h-[600px] overflow-auto">
          {(resp?.recent_outcomes ?? []).map(o => <OutcomeRow key={o.id} o={o}/>)}
          {(resp?.recent_outcomes?.length ?? 0) === 0 && (
            <EmptyState icon={Bot} size="sm" title={t("No annotations yet")} hint={t("Operator feedback on past AI verdicts will accumulate here.")}/>
          )}
        </div>
      </section>
    </div>
  );
}

function BigStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-3xl font-semibold mt-1 tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function AccuracyTable({ rows, bucketLabel }: { rows: AccuracyRow[]; bucketLabel: string }) {
  const { t } = useT();
  return (
    <table className="grid">
      <thead><tr><th>{bucketLabel}</th><th>{t("Verdict")}</th><th>{t("Samples")}</th><th>{t("Correct")}</th><th>{t("Accuracy")}</th><th>{t("Avg conf")}</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.provider_name}-${r.verdict}-${i}`}>
            <td className="font-mono text-xs">{r.provider_name || "—"}</td>
            <td>
              <span className={`text-xs flex items-center gap-1 ${VERDICT_TONE[r.verdict].tone}`}>
                {VERDICT_TONE[r.verdict].icon}{t(VERDICT_TONE[r.verdict].label)}
              </span>
            </td>
            <td className="font-mono">{r.total}</td>
            <td className="font-mono">{r.correct}</td>
            <td><AccuracyBar rate={r.accuracy_rate}/></td>
            <td className="font-mono text-xs text-muted">{(r.avg_confidence * 100).toFixed(0)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DomainTable({ rows }: { rows: AccuracyRow[] }) {
  const { t } = useT();
  return (
    <table className="grid">
      <thead><tr><th>{t("Domain")}</th><th>{t("Verdict")}</th><th>{t("Samples")}</th><th>{t("Correct")}</th><th>{t("Accuracy")}</th><th>{t("Avg conf")}</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.business_domain}-${r.verdict}-${i}`}>
            <td><span className="badge">{r.business_domain || "—"}</span></td>
            <td>
              <span className={`text-xs flex items-center gap-1 ${VERDICT_TONE[r.verdict].tone}`}>
                {VERDICT_TONE[r.verdict].icon}{t(VERDICT_TONE[r.verdict].label)}
              </span>
            </td>
            <td className="font-mono">{r.total}</td>
            <td className="font-mono">{r.correct}</td>
            <td><AccuracyBar rate={r.accuracy_rate}/></td>
            <td className="font-mono text-xs text-muted">{(r.avg_confidence * 100).toFixed(0)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccuracyBar({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const tone = rate >= 0.85 ? "bg-success" : rate >= 0.70 ? "bg-warning" : "bg-danger";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 rounded-full bg-panel2 flex-1 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }}/>
      </div>
      <span className="text-xs tabular-nums w-10 text-right">{pct}%</span>
    </div>
  );
}

function OutcomeRow({ o }: { o: Outcome }) {
  const { t } = useT();
  const tone = VERDICT_TONE[o.verdict];
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs ${o.was_correct ? "bg-success/5" : "bg-danger/10"}`}>
      <span className={tone.tone}>{tone.icon}</span>
      <span className={`w-24 ${tone.tone}`}>{t(tone.label)}</span>
      <span>{o.was_correct ? <CheckCircle2 size={14} className="text-success"/> : <XCircle size={14} className="text-danger"/>}</span>
      {o.business_domain && <span className="badge">{o.business_domain}</span>}
      <a href={`/tasks?focus=${o.task_id}`} className="font-mono text-accent hover:underline">{o.task_id.slice(0, 8)}…</a>
      <span className="text-muted flex-1 truncate">{o.evidence}</span>
      {o.re_warmed && <span title={t("re-warmed")}><AlertTriangle size={12} className="text-danger"/></span>}
      <span className="text-muted">{new Date(o.created_at).toLocaleString("zh-CN")}</span>
    </div>
  );
}

// S3 policy proposals — read-only summary card. Acceptance rate measures
// whether the AI's NL→IAM proposals are useful as-shipped (approved),
// directionally right but needs tweaks (edited), or wrong (discarded).
// "Open" counts unsettled proposals so the operator notices the backlog.
function S3ProposalsCard({ hours }: { hours: number }) {
  const { t } = useT();
  const { data } = useAIS3Learning(hours);
  const s = data as AIS3LearningResp | undefined;
  const has = (s?.total ?? 0) > 0 || (s?.open_proposals ?? 0) > 0;

  return (
    <section className="card p-5">
      <header className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-lg font-medium inline-flex items-center gap-2">
          <Key size={16} className="text-accent" />
          {t("S3 policy proposals")}
        </h2>
        <span className="text-xs text-muted">{t("From the NL → IAM assistant")}</span>
      </header>

      {!has ? (
        <div className="text-sm text-muted">
          {t("No S3 policy proposals in this window. Open the AI policy assistant on the S3 → Identities tab to start collecting data.")}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-3 mb-4">
            <BigStat label={t("Total settled")} value={(s!.total).toLocaleString()} />
            <BigStat label={t("Approved")}      value={(s!.approved).toLocaleString()} tone="text-success" />
            <BigStat label={t("Edited")}        value={(s!.edited).toLocaleString()}   tone="text-warning" />
            <BigStat label={t("Discarded")}     value={(s!.discarded).toLocaleString()} tone="text-danger" />
            <BigStat label={t("Acceptance")}
              value={`${(s!.accept_rate * 100).toFixed(1)}%`}
              tone={s!.accept_rate >= 0.85 ? "text-success" : s!.accept_rate >= 0.6 ? "text-warning" : "text-danger"}
            />
          </div>

          {/* Per-risk breakdown */}
          {(s!.by_risk?.length ?? 0) > 0 && (
            <table className="grid text-xs">
              <thead>
                <tr>
                  <th>{t("Risk")}</th>
                  <th className="text-right">{t("Total")}</th>
                  <th className="text-right">{t("Approved+Edited")}</th>
                  <th className="text-right">{t("Acceptance")}</th>
                </tr>
              </thead>
              <tbody>
                {s!.by_risk.map(r => (
                  <tr key={r.risk}>
                    <td>
                      <span className={`badge ${r.risk === "high" ? "text-danger" : r.risk === "medium" ? "text-warning" : "text-success"}`}>
                        {t(r.risk.charAt(0).toUpperCase() + r.risk.slice(1) + " risk")}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{r.total}</td>
                    <td className="text-right tabular-nums">{r.approved}</td>
                    <td className="text-right tabular-nums">{(r.accept_rate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(s!.open_proposals ?? 0) > 0 && (
            <div className="mt-3 text-xs text-muted inline-flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-warning" />
              {t("{n} proposal(s) still pending an operator decision.").replace("{n}", String(s!.open_proposals))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// S3LimitProposalsCard — twin of S3ProposalsCard for circuit-breaker
// limit recommendations. Shape mirrors AIS3LearningResp so this could
// be merged into one generic component, but keeping them separate
// makes future per-kind tweaks (e.g. limit-specific drill-downs) easy.
function S3LimitProposalsCard({ hours }: { hours: number }) {
  const { t } = useT();
  const { data } = useAIS3LimitLearning(hours);
  const s = data as AIS3LimitLearningResp | undefined;
  const has = (s?.total ?? 0) > 0 || (s?.open_proposals ?? 0) > 0;

  return (
    <section className="card p-5">
      <header className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-lg font-medium inline-flex items-center gap-2">
          <Gauge size={16} className="text-accent" />
          {t("Circuit-breaker proposals")}
        </h2>
        <span className="text-xs text-muted">{t("From the AI limit advisor")}</span>
      </header>

      {!has ? (
        <div className="text-sm text-muted">
          {t("No circuit-breaker proposals in this window. Open S3 → Circuit Breaker and click \"Get AI suggestion\" to start collecting data.")}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-3 mb-4">
            <BigStat label={t("Total settled")} value={(s!.total).toLocaleString()} />
            <BigStat label={t("Approved")}      value={(s!.approved).toLocaleString()} tone="text-success" />
            <BigStat label={t("Edited")}        value={(s!.edited).toLocaleString()}   tone="text-warning" />
            <BigStat label={t("Discarded")}     value={(s!.discarded).toLocaleString()} tone="text-danger" />
            <BigStat label={t("Acceptance")}
              value={`${(s!.accept_rate * 100).toFixed(1)}%`}
              tone={s!.accept_rate >= 0.85 ? "text-success" : s!.accept_rate >= 0.6 ? "text-warning" : "text-danger"}
            />
          </div>

          {(s!.by_risk?.length ?? 0) > 0 && (
            <table className="grid text-xs">
              <thead>
                <tr>
                  <th>{t("Risk")}</th>
                  <th className="text-right">{t("Total")}</th>
                  <th className="text-right">{t("Approved+Edited")}</th>
                  <th className="text-right">{t("Acceptance")}</th>
                </tr>
              </thead>
              <tbody>
                {s!.by_risk.map(r => (
                  <tr key={r.risk}>
                    <td>
                      <span className={`badge ${r.risk === "high" ? "text-danger" : r.risk === "medium" ? "text-warning" : "text-success"}`}>
                        {t(r.risk.charAt(0).toUpperCase() + r.risk.slice(1) + " risk")}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{r.total}</td>
                    <td className="text-right tabular-nums">{r.approved}</td>
                    <td className="text-right tabular-nums">{(r.accept_rate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(s!.open_proposals ?? 0) > 0 && (
            <div className="mt-3 text-xs text-muted inline-flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-warning" />
              {t("{n} proposal(s) still pending an operator decision.").replace("{n}", String(s!.open_proposals))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
