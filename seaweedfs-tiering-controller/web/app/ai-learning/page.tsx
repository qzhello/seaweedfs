"use client";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { useAILearning } from "@/lib/api";
import {
  Brain, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, ShieldAlert, UserCheck, Bot,
} from "lucide-react";

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

export default function AILearningPage() {
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
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-3">
            <Brain size={24} className="text-accent"/> AI counterfactual learning
          </h1>
          <p className="text-sm text-muted">
            After {hours}h we look back at actual access and auto-grade whether the verdict was right.
            Thresholds live under Settings → ai_review.*
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {HORIZONS.map(h => (
            <button key={h.hours} onClick={() => setHours(h.hours)}
              className={`px-3 py-1.5 rounded-md border ${hours === h.hours ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-muted hover:text-text"}`}>
              {h.label}
            </button>
          ))}
        </div>
      </header>

      {/* Headline KPIs */}
      <section className="grid grid-cols-4 gap-4">
        <BigStat label="Total verdicts"
          value={totals.total.toLocaleString()}/>
        <BigStat label="Correct"
          value={totals.correct.toLocaleString()}
          tone="text-success"/>
        <BigStat label="Accuracy"
          value={`${(overallRate * 100).toFixed(1)}%`}
          tone={overallRate >= 0.85 ? "text-success" : overallRate >= 0.70 ? "text-warning" : "text-danger"}/>
        <BigStat label="Observation window"
          value={`${hours}h`}/>
      </section>

      {/* By provider */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">By provider</h2>
        {(resp?.by_provider?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted">No annotations yet —{" "}
            wait {Math.max(1, Math.round(hours / 24))} day(s) after tasks run.
          </div>
        ) : (
          <AccuracyTable rows={resp!.by_provider} bucketLabel="Provider"/>
        )}
      </section>

      {/* By business domain */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">By business domain</h2>
        {(resp?.by_domain?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted">No annotations yet.</div>
        ) : (
          <DomainTable rows={resp!.by_domain}/>
        )}
      </section>

      {/* Recent outcomes feed */}
      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">Recent annotations</h2>
        <div className="space-y-1.5 max-h-[600px] overflow-auto">
          {(resp?.recent_outcomes ?? []).map(o => <OutcomeRow key={o.id} o={o}/>)}
          {(resp?.recent_outcomes?.length ?? 0) === 0 && (
            <EmptyState icon={Bot} size="sm" title="No annotations yet" hint="Operator feedback on past AI verdicts will accumulate here."/>
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
  return (
    <table className="grid">
      <thead><tr><th>{bucketLabel}</th><th>Verdict</th><th>Samples</th><th>Correct</th><th>Accuracy</th><th>Avg conf</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.provider_name}-${r.verdict}-${i}`}>
            <td className="font-mono text-xs">{r.provider_name || "—"}</td>
            <td>
              <span className={`text-xs flex items-center gap-1 ${VERDICT_TONE[r.verdict].tone}`}>
                {VERDICT_TONE[r.verdict].icon}{VERDICT_TONE[r.verdict].label}
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
  return (
    <table className="grid">
      <thead><tr><th>Domain</th><th>Verdict</th><th>Samples</th><th>Correct</th><th>Accuracy</th><th>Avg conf</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.business_domain}-${r.verdict}-${i}`}>
            <td><span className="badge">{r.business_domain || "—"}</span></td>
            <td>
              <span className={`text-xs flex items-center gap-1 ${VERDICT_TONE[r.verdict].tone}`}>
                {VERDICT_TONE[r.verdict].icon}{VERDICT_TONE[r.verdict].label}
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
  const tone = VERDICT_TONE[o.verdict];
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs ${o.was_correct ? "bg-success/5" : "bg-danger/10"}`}>
      <span className={tone.tone}>{tone.icon}</span>
      <span className={`w-24 ${tone.tone}`}>{tone.label}</span>
      <span>{o.was_correct ? <CheckCircle2 size={14} className="text-success"/> : <XCircle size={14} className="text-danger"/>}</span>
      {o.business_domain && <span className="badge">{o.business_domain}</span>}
      <a href={`/tasks?focus=${o.task_id}`} className="font-mono text-accent hover:underline">{o.task_id.slice(0, 8)}…</a>
      <span className="text-muted flex-1 truncate">{o.evidence}</span>
      {o.re_warmed && <AlertTriangle size={12} className="text-danger" title="re-warmed"/>}
      <span className="text-muted">{new Date(o.created_at).toLocaleString("zh-CN")}</span>
    </div>
  );
}

