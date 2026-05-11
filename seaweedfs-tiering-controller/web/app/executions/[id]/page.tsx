"use client";
import { useExecution, useTask, useTaskAutonomy, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useParams, useRouter } from "next/navigation";
import {
  Undo2, ArrowLeft, CheckCircle2, XCircle, AlertCircle, AlertTriangle, Repeat, Clock,
  Sparkles, RotateCcw, Bot,
} from "lucide-react";
import { useMemo, useState } from "react";
import { parseSkillLog, type StepRecord, type ParsedSkillLog } from "@/lib/skill-log";
import { explainOp, substituteCommand } from "@/lib/op-catalog";
import { Breadcrumb } from "@/components/breadcrumb";

export default function ExecutionDetail() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: e, mutate } = useExecution(id);
  const { data: task } = useTask(e?.task_id);
  const { data: autonomy } = useTaskAutonomy(e?.task_id);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo<ParsedSkillLog>(
    () => parseSkillLog(e?.log, e?.status === "running"),
    [e?.log, e?.status],
  );

  const opCtx = {
    volume_id: task?.volume_id,
    collection: task?.collection,
    src_server: task?.src_server,
  };

  if (!e) return <div className="text-muted">Loading…</div>;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: "Executions", href: "/executions" },
        { label: `${e.id.slice(0, 8)}…` },
      ]}/>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Execution <span className="font-mono text-base">{e.id.slice(0, 8)}…</span>
          </h1>
          {parsed.skillKey && (
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-mono text-accent">{parsed.skillKey}</span>
              <span className="text-muted">v{parsed.version}</span>
              <span className="badge">{parsed.riskLevel}</span>
              <StatusBadge status={e.status}/>
            </div>
          )}
        </div>
        {e.rollback_kind && e.status === "succeeded" && (
          <button className="btn btn-danger" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await api.rollbackExec(e.id); await mutate(); }
              finally { setBusy(false); }
            }}>
            <Undo2 size={14}/> {t("Roll back")}
          </button>
        )}
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-4 gap-3">
        <KPI label={t("Status")}       value={<StatusBadge status={e.status}/>}/>
        <KPI label={t("Total time")}   value={fmtMs(parsed.totalMs)}/>
        <KPI label={t("Steps")}        value={`${parsed.steps.filter(s => s.status === "succeeded").length}/${parsed.steps.length}`}/>
        <KPI label={t("Trace")}        value={<span className="font-mono text-xs">{e.trace_id?.slice(0, 12)}…</span>}/>
      </section>

      {/* Live progress bar — only while running */}
      {e.status === "running" && parsed.steps.length > 0 && (
        <section className="card p-4">
          <div className="flex items-center justify-between mb-2 text-sm">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-warning animate-pulse"/>
              <span>{t("Running")}</span>
              <span className="text-muted">·</span>
              <span className="font-mono">
                {parsed.steps.filter(s => s.status === "succeeded").length}/{parsed.steps.length} steps done
              </span>
            </div>
            <span className="text-xs text-muted">{t("auto-refresh every 1.5s")}</span>
          </div>
          <div className="h-2 rounded-full bg-panel2 overflow-hidden">
            <div className="h-full bg-warning/70 transition-all duration-500"
              style={{
                width: `${Math.round(
                  (parsed.steps.filter(s => s.status === "succeeded").length / Math.max(parsed.steps.length, 1)) * 100,
                )}%`,
              }}/>
          </div>
        </section>
      )}

      {/* AI decision archive — autonomy score + pipeline timeline */}
      {autonomy && <AutonomyCard data={autonomy}/>}

      {/* AI Postmortem (failed only) */}
      {(e.status === "failed" || e.ai_postmortem) && (
        <PostmortemCard exec={e} onChanged={mutate}/>
      )}

      {/* Banners (preconditions / postchecks) */}
      {parsed.banners.length > 0 && (
        <section className="space-y-1">
          {parsed.banners.map((b, i) => (
            <div key={i} className={`text-xs px-3 py-2 rounded-md border ${
              b.kind === "error" ? "border-danger/40 bg-danger/10 text-danger" :
              b.kind === "warn"  ? "border-warning/40 bg-warning/10 text-warning" :
              "border-border bg-panel2 text-muted"
            }`}>
              {b.text}
            </div>
          ))}
        </section>
      )}

      {/* Plan preview — shows what each step DOES + the real command */}
      {parsed.steps.length > 0 && (
        <PlanPreview steps={parsed.steps} ctx={opCtx}/>
      )}

      {/* Waterfall */}
      {parsed.steps.length > 0 ? (
        <section className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium">{t("Step waterfall")}</h2>
            <span className="text-xs text-muted">total {fmtMs(parsed.totalMs)}</span>
          </div>
          <Waterfall steps={parsed.steps} totalMs={parsed.totalMs} ctx={opCtx}/>
        </section>
      ) : (
        <section className="card p-5 text-sm text-muted">
          Legacy execution log (no Skill metadata) — see raw log below.
        </section>
      )}

      {/* Metadata */}
      <section className="grid grid-cols-2 gap-4">
        <KV k={t("Started at")}    v={new Date(e.started_at).toLocaleString()}/>
        <KV k={t("Finished at")}   v={e.finished_at ? new Date(e.finished_at).toLocaleString() : "—"}/>
        <KV k={t("Rollback kind")} v={e.rollback_kind || "—"}/>
        <KV k={t("Error")}         v={e.error || "—"}/>
      </section>

      {/* Raw log (collapsible) */}
      <details className="card p-5">
        <summary className="text-sm font-medium cursor-pointer">Raw log</summary>
        <pre className="font-mono text-xs whitespace-pre-wrap bg-bg p-3 rounded border border-border max-h-[600px] overflow-auto mt-3">
{e.log || "(empty)"}
        </pre>
      </details>
    </div>
  );
}

// ---- Autonomy decision archive --------------------------------------------

interface AutonomyFactor { raw: unknown; value: number; weight: number; weighted: number; notes?: string }
interface Rebuttal {
  claim: { name: string; weight: number; note: string };
  category: string;
  rebutted: boolean;
  evidence: string;
}
interface VetoAssessment {
  rebuttals: Rebuttal[];
  total_weight: number;
  rebutted_weight: number;
  effective_strength: number;
  override: boolean;
}
interface AutonomyScore {
  total: number;
  threshold: number;
  verdict: "auto_proceed" | "needs_human" | "blocked";
  factors: Record<string, AutonomyFactor>;
  computed_at: string;
  vetoed_by?: string;
  veto_assessment?: VetoAssessment;
}
interface PipelineRun {
  stage: string;
  decision: string;
  reason: string;
  duration_ms?: number;
  started_at: string;
  evidence: Record<string, unknown>;
}
interface AutonomyResp { task_id: string; autonomy_score?: AutonomyScore; pipeline_runs: PipelineRun[] }

function AutonomyCard({ data }: { data: AutonomyResp }) {
  const { t } = useT();
  const sc = data.autonomy_score;
  const runs = data.pipeline_runs || [];
  if (!sc && runs.length === 0) return null;

  const verdictBadge =
    sc?.verdict === "auto_proceed"
      ? "border-success/40 bg-success/5 text-success"
      : sc?.verdict === "blocked"
      ? "border-danger/40 bg-danger/5 text-danger"
      : "border-warning/40 bg-warning/5 text-warning";

  const verdictLabel: Record<string, string> = {
    auto_proceed: "Auto-proceed",
    needs_human:  "Needs human",
    blocked:      "Blocked (high risk)",
  };

  return (
    <section className={`card p-5 border ${verdictBadge}`}>
      <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
        <Bot size={18} className="text-accent"/> {t("AI decision archive")}
        {sc && (
          <>
            <span className="badge ml-2">{verdictLabel[sc.verdict] || sc.verdict}</span>
            <span className="text-xs text-muted ml-1">
              autonomy {sc.total.toFixed(2)} / threshold {sc.threshold.toFixed(2)}
            </span>
          </>
        )}
      </h2>

      {sc?.vetoed_by && (
        <div className="mb-3 px-3 py-2 rounded-md border border-warning/40 bg-warning/5 text-warning text-xs">
          🛑 Veto: {sc.vetoed_by}
        </div>
      )}

      {sc?.veto_assessment && sc.veto_assessment.rebuttals.length > 0 && (
        <details className="mb-3 px-3 py-2 rounded-md border border-border bg-panel2 text-xs">
          <summary className="cursor-pointer">
            AI-concern rebuttals · {countRebutted(sc.veto_assessment.rebuttals)}/
            {sc.veto_assessment.rebuttals.length} refuted by ground-truth data
            {sc.veto_assessment.override && <span className="text-success ml-2">(autonomy overrode AI veto)</span>}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {sc.veto_assessment.rebuttals.map((r, i) => (
              <li key={i} className="border-l-2 pl-2 py-0.5"
                  style={{ borderColor: r.rebutted ? "rgb(34 197 94 / 0.6)" : "rgb(234 179 8 / 0.6)" }}>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 ${r.rebutted ? "text-success" : "text-warning"}`}>
                    {r.rebutted ? <><CheckCircle2 size={12}/> rebutted</> : <><AlertTriangle size={12}/> kept</>}
                  </span>
                  <span className="font-medium">{r.claim.name}</span>
                  <span className="text-muted">weight {r.claim.weight.toFixed(2)}</span>
                  <span className="text-muted text-[11px]">[{r.category}]</span>
                </div>
                <div className="text-muted mt-0.5">AI: {r.claim.note}</div>
                <div className={r.rebutted ? "text-success/80" : "text-warning/80"}>
                  ↳ {r.evidence}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {sc && (
        <div className="space-y-1 mb-4">
          {Object.entries(sc.factors).map(([name, f]) => (
            <FactorBar key={name} name={name} f={f}/>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="border-t border-border pt-3 space-y-1">
          <div className="text-xs text-muted mb-2">{t("Pipeline timeline")}</div>
          {runs.map((r, i) => (
            <div key={i} className="flex items-start gap-3 text-xs">
              <div className="font-mono text-muted w-32 shrink-0">{r.stage}</div>
              <span className={`badge text-[11px] ${
                r.decision === "pass" || r.decision === "auto_proceed" ? "border-success/40 text-success" :
                r.decision === "needs_human" ? "border-warning/40 text-warning" :
                r.decision === "fail" || r.decision === "blocked" ? "border-danger/40 text-danger" :
                "border-muted/40 text-muted"
              }`}>{r.decision}</span>
              <div className="flex-1 text-muted">{r.reason || "—"}</div>
              {r.duration_ms != null && <div className="font-mono text-muted">{r.duration_ms}ms</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const FACTOR_LABELS: Record<string, string> = {
  risk_level:       "Skill risk",
  blast_radius:     "Blast radius",
  cluster_pressure: "Cluster pressure",
  change_window:    "Change window",
  ai_consensus:     "AI consensus",
};

function countRebutted(rs: Rebuttal[]): number {
  return rs.reduce((n, r) => n + (r.rebutted ? 1 : 0), 0);
}

function FactorBar({ name, f }: { name: string; f: AutonomyFactor }) {
  const pct = Math.round(f.value * 100);
  const wpct = Math.round(f.weighted * 100);
  const label = FACTOR_LABELS[name] || name;
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="w-24 shrink-0 text-muted">{label}</div>
      <div className="flex-1 h-2 rounded-full bg-panel2 overflow-hidden">
        <div className="h-full bg-accent/70 transition-all" style={{ width: `${pct}%` }}/>
      </div>
      <div className="font-mono text-muted w-32 text-right shrink-0">
        {f.value.toFixed(2)} × {f.weight.toFixed(2)} = {f.weighted.toFixed(3)}
      </div>
      <div className="font-mono text-muted text-[11px] w-40 truncate" title={typeof f.raw === "string" ? f.raw : JSON.stringify(f.raw)}>
        {typeof f.raw === "string" ? f.raw : String(f.raw)}
      </div>
    </div>
  );
}

// ---- AI Postmortem ---------------------------------------------------------

interface Postmortem {
  verdict: "transient_retry" | "permanent_abort" | "needs_human" | "adjust_and_retry";
  confidence: number;
  root_cause: string;
  recommended_action: string;
  retry_safe: boolean;
  produced_at?: string;
  provider?: string;
}

function PostmortemCard({ exec, onChanged }: { exec: { id: string; ai_postmortem?: Postmortem | null; status: string }; onChanged: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState<"diagnose" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pm = exec.ai_postmortem;

  const tone = pm
    ? pm.verdict === "transient_retry" || pm.verdict === "adjust_and_retry"
      ? "border-success/40 bg-success/5"
      : pm.verdict === "permanent_abort"
      ? "border-danger/40 bg-danger/5"
      : "border-warning/40 bg-warning/5"
    : "border-border bg-panel2";

  const verdictLabel: Record<Postmortem["verdict"], string> = {
    transient_retry:  "Transient — retry recommended",
    adjust_and_retry: "Adjust args and retry",
    permanent_abort:  "No longer needed — abort",
    needs_human:      "Needs human judgement",
  };

  const canApply = pm && (pm.verdict === "transient_retry" || pm.verdict === "adjust_and_retry");

  const diagnose = async () => {
    setBusy("diagnose"); setError(null);
    try { await api.runPostmortem(exec.id); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const apply = async () => {
    setBusy("apply"); setError(null);
    try {
      await api.applyPostmortem(exec.id);
      alert("Accepted — task reset to approved. Click Run on /tasks to retry.");
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <section className={`card p-5 border ${tone}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <Bot size={18} className="text-accent"/> {t("AI postmortem")}
          {pm && <span className="badge ml-2">{verdictLabel[pm.verdict]}</span>}
          {pm && (
            <span className="text-xs text-muted ml-1">
              confidence {Math.round((pm.confidence || 0) * 100)}%
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={!!busy} onClick={diagnose}>
            <Sparkles size={14} className={busy === "diagnose" ? "animate-pulse" : ""}/>
            {pm ? "Re-diagnose" : "Run diagnosis"}
          </button>
          {canApply && (
            <button className="btn btn-primary" disabled={!!busy} onClick={apply}>
              <RotateCcw size={14} className={busy === "apply" ? "animate-spin" : ""}/>
              Accept suggestion (reset to approved)
            </button>
          )}
        </div>
      </div>

      {!pm && (
        <div className="text-sm text-muted">
          {exec.status === "failed"
            ? "Waiting for auto-diagnosis; trigger manually if it doesn't appear."
            : "Run diagnosis to have AI analyze the root cause and suggest next steps."}
        </div>
      )}

      {pm && (
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-muted mb-1">Root cause</div>
            <div>{pm.root_cause || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Suggested action</div>
            <div>{pm.recommended_action || "—"}</div>
          </div>
          <div className="flex gap-4 text-xs text-muted">
            <span>Idempotent retry: <span className={pm.retry_safe ? "text-success" : "text-warning"}>
              {pm.retry_safe ? "yes" : "no"}
            </span></span>
            {pm.provider && <span>provider: {pm.provider}</span>}
            {pm.produced_at && <span>{new Date(pm.produced_at).toLocaleString("zh-CN")}</span>}
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-xs text-danger">Error: {error}</div>}
    </section>
  );
}

// ---- Plan Preview ----------------------------------------------------------

interface OpCtx { volume_id?: number | string; collection?: string; src_server?: string; master?: string }

function PlanPreview({ steps, ctx }: { steps: StepRecord[]; ctx: OpCtx }) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  return (
    <section className="card p-5">
      <button onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full mb-3 hover:opacity-80">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <Bot size={18} className="text-accent"/> {t("AI execution plan")}
          <span className="text-xs text-muted ml-2">{steps.length} steps — expand to see the real command for each</span>
        </h2>
        <span className="text-muted text-xs">{open ? "Collapse" : "Expand"}</span>
      </button>
      {open && (
        <ol className="space-y-2 text-sm">
          {steps.map((s, i) => {
            const ex = explainOp(s.op);
            const cmd = substituteCommand(ex.command, ctx);
            return (
              <li key={s.index} className="flex gap-3 border-l-2 border-border pl-3 py-1.5">
                <div className="font-mono text-xs text-muted w-6 text-right">{i + 1}.</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{ex.title}</span>
                    {ex.external
                      ? <span className="badge border-accent/40 text-accent text-[11px]">SeaweedFS</span>
                      : <span className="badge text-[11px]">internal</span>}
                    <span className="text-xs text-muted font-mono">/{s.op}</span>
                  </div>
                  <div className="text-muted text-xs mt-0.5">{ex.description}</div>
                  <pre className="font-mono text-[11px] mt-1 px-2 py-1 bg-bg border border-border rounded overflow-x-auto whitespace-pre-wrap">$ {cmd}</pre>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ---- Waterfall -------------------------------------------------------------

function Waterfall({ steps, totalMs, ctx }: { steps: StepRecord[]; totalMs: number; ctx: OpCtx }) {
  const max = Math.max(totalMs, 1);
  // Cumulative offset in ms for each bar.
  let cursor = 0;
  return (
    <div className="space-y-2">
      {steps.map(s => {
        const dur = s.durationMs ?? 0;
        const offsetPct = (cursor / max) * 100;
        // Running steps have no known duration yet — give them ~25% of the
        // remaining width so the operator clearly sees which step is in flight.
        const widthPct = s.status === "running"
          ? Math.max(100 - offsetPct, 20) * 0.5
          : Math.max((dur / max) * 100, 0.5);
        cursor += dur;
        return <StepBar key={s.index} step={s} offsetPct={offsetPct} widthPct={widthPct} ctx={ctx}/>;
      })}
    </div>
  );
}

function StepBar({
  step, offsetPct, widthPct, ctx,
}: { step: StepRecord; offsetPct: number; widthPct: number; ctx: OpCtx }) {
  const [open, setOpen] = useState(false);
  const ex = explainOp(step.op);
  const cmd = substituteCommand(ex.command, ctx);
  const tone =
    step.status === "succeeded" ? "bg-success/40 border-success/60" :
    step.status === "failed"    ? "bg-danger/40 border-danger/60" :
    "bg-warning/30 border-warning/60 animate-pulse";

  return (
    <div className="text-xs">
      <button onClick={() => setOpen(!open)}
        className="w-full text-left flex items-center gap-3 hover:bg-panel2 rounded px-1 py-0.5">
        {/* Icon column */}
        <span className="w-4 shrink-0">
          {step.status === "succeeded" && <CheckCircle2 size={14} className="text-success"/>}
          {step.status === "failed"    && <XCircle size={14} className="text-danger"/>}
          {step.status === "running"   && <Clock size={14} className="text-warning"/>}
        </span>
        {/* Name column */}
        <div className="w-44 shrink-0 truncate">
          <span className="font-medium">{step.name}</span>
          <span className="text-muted ml-1">/ {step.op}</span>
        </div>
        {/* Bar column */}
        <div className="flex-1 h-5 relative bg-panel2 rounded">
          <div className={`absolute top-0 bottom-0 rounded border ${tone}`}
               style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}/>
          {step.attempts > 1 && (
            <div className="absolute right-1 top-0 bottom-0 flex items-center text-warning gap-0.5">
              <Repeat size={10}/><span className="text-[11px]">{step.attempts}</span>
            </div>
          )}
        </div>
        {/* Duration column */}
        <div className="w-20 shrink-0 text-right font-mono tabular-nums">
          {step.status === "running"
            ? <span className="text-warning">running…</span>
            : step.durationMs != null ? fmtMs(step.durationMs) : "—"}
        </div>
      </button>

      {open && (
        <div className="ml-7 mt-1 mb-2 px-3 py-2 rounded bg-bg border border-border text-[11px] space-y-1">
          <div className="pb-1 border-b border-border space-y-0.5">
            <div className="text-text font-medium">{ex.title}</div>
            <div className="text-muted">{ex.description}</div>
            <pre className="font-mono mt-1 px-2 py-0.5 bg-panel2 rounded overflow-x-auto whitespace-pre-wrap">$ {cmd}</pre>
          </div>
          {step.error && (
            <div className="text-danger flex items-start gap-1">
              <AlertCircle size={12} className="mt-0.5 shrink-0"/>
              <span>{step.error}</span>
            </div>
          )}
          {step.failureMode && (
            <div className="text-muted">on_failure: <span className="text-text">{step.failureMode}</span></div>
          )}
          {step.attempts > 1 && (
            <div className="text-muted">attempts: <span className="text-text">{step.attempts}</span></div>
          )}
          {step.detail.length > 0 ? (
            step.detail.map((d, i) => <div key={i} className="font-mono text-muted">{d}</div>)
          ) : (
            <div className="text-muted italic">no stdout captured</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- bits ------------------------------------------------------------------

function KPI({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="card p-3"><div className="text-xs text-muted">{k}</div><div className="mt-1">{v}</div></div>;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded" ? "border-success/40 bg-success/10 text-success" :
    status === "failed"    ? "border-danger/40 bg-danger/10 text-danger" :
    status === "rolled_back" ? "border-warning/40 bg-warning/10 text-warning" :
    "border-border bg-panel2 text-muted";
  return <span className={`px-2 py-0.5 rounded-md border text-xs ${tone}`}>{status}</span>;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  if (min < 60) return `${min}m ${sec}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}
