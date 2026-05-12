"use client";
import { useTasks, useTaskReview, useClusterPressure, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { EmptyState } from "@/components/empty-state";
import { relTime } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { useState, Fragment } from "react";
import {
  CheckCircle2, XCircle, Play, ChevronDown, ChevronRight, Square, RotateCcw,
  Sparkles, Loader2, AlertTriangle, ShieldCheck, ShieldAlert, UserCheck, ListChecks,
} from "lucide-react";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";

const STATUSES = ["", "pending", "approved", "scheduled", "running", "succeeded", "failed", "rolled_back", "cancelled"];

export default function TasksPage() {
  const { t } = useT();
  const router = useRouter();
  const [status, setStatus] = useState("pending");
  const { data, mutate, isLoading, isValidating } = useTasks(status);
  const { data: pressure } = useClusterPressure();
  const pressureByCluster = new Map<string, { score: number; is_busy: boolean }>(
    (pressure?.items ?? []).map((p: { cluster_id: string; score: number; is_busy: boolean }) => [p.cluster_id, p]),
  );
  const threshold = pressure?.threshold ?? 0.6;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items: any[] = data?.items || [];
  const pg = usePagination<any>(items, 20);

  const act = async (fn: () => Promise<unknown>, id: string) => {
    setBusy(id);
    try { await fn(); await mutate(); } finally { setBusy(null); }
  };

  // Run kicks off async execution and immediately navigates to /executions/<id>
  // so the operator watches the live waterfall instead of staring at the task
  // row spinning.
  const runAndJump = async (taskID: string) => {
    setBusy(taskID);
    try {
      const res = (await api.runTask(taskID)) as { execution_id?: string; error?: string };
      await mutate();
      if (res?.execution_id) router.push(`/executions/${res.execution_id}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold tracking-tight">{t("Tasks")}</h1>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            {STATUSES.map(s => (
              <button key={s} onClick={() => setStatus(s)}
                className={`px-2.5 py-1 transition-colors ${
                  status === s ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                } ${s !== STATUSES[STATUSES.length - 1] ? "border-r border-border/60" : ""}`}>
                {s || "all"}
              </button>
            ))}
          </div>
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={6} headers={["", t("Vol"), t("Action"), t("Score"), t("Status"), t("Created"), ""]}/>
        ) : (
        <table className="grid">
          <thead><tr>
            <th></th><th>{t("Vol")}</th><th>{t("Action")}</th><th className="num">{t("Score")}</th><th>{t("Status")}</th><th>{t("Created")}</th><th></th>
          </tr></thead>
          <tbody>
            {pg.slice.map((task: any) => (
              <Fragment key={task.id}>
                <tr>
                  <td>
                    <button onClick={() => setExpanded(expanded === task.id ? null : task.id)} className="text-muted">
                      {expanded === task.id ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
                    </button>
                  </td>
                  <td className="font-mono">{task.volume_id} <span className="text-muted text-xs">{task.collection}</span></td>
                  <td><span className="badge">{task.action}</span> <span className="text-muted text-xs">{safeStringify(task.target)}</span></td>
                  <td className="font-mono">{Number(task.score).toFixed(3)}</td>
                  <td>
                    <StatusBadge s={task.status}/>
                    {task.approved_by === "ai-auto" && (
                      <span title={`Auto-approved by autonomy pipeline${task.autonomy_score ? ` · score ${(task.autonomy_score.total ?? 0).toFixed(2)} ≥ ${(task.autonomy_score.threshold ?? 0).toFixed(2)}` : ""}`}
                        className="ml-1.5 px-1.5 py-0.5 rounded border border-accent/40 bg-accent/10 text-accent text-[11px] inline-flex items-center gap-0.5">
                        <Sparkles size={10}/> AI {task.autonomy_score ? (task.autonomy_score.total ?? 0).toFixed(2) : ""}
                      </span>
                    )}
                    {task.status === "pending" && task.autonomy_score && (
                      <span title={`autonomy ${task.autonomy_score.total.toFixed(2)} < threshold ${task.autonomy_score.threshold.toFixed(2)} → needs human review`}
                        className="ml-1.5 px-1.5 py-0.5 rounded border border-warning/40 bg-warning/10 text-warning text-[11px] inline-flex items-center gap-0.5">
                        autonomy {task.autonomy_score.total.toFixed(2)}
                      </span>
                    )}
                    {task.status === "scheduled" && task.cluster_id && pressureByCluster.has(task.cluster_id) && (() => {
                      const p = pressureByCluster.get(task.cluster_id)!;
                      return (
                        <div className="mt-1 text-[11px] text-warning">
                          Waiting for pressure to drop · current {p.score.toFixed(2)} / threshold {threshold.toFixed(2)}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="text-muted text-xs">{relTime(task.created_at)}</td>
                  <td className="text-right space-x-1">
                    {task.status === "pending" && (
                      <button className="btn btn-primary" disabled={busy===task.id}
                        onClick={() => act(() => api.approveTask(task.id), task.id)}>
                        <CheckCircle2 size={14}/> Approve
                      </button>
                    )}
                    {task.status === "approved" && (
                      <button className="btn btn-primary" disabled={busy===task.id}
                        onClick={() => runAndJump(task.id)}>
                        <Play size={14}/> Run
                      </button>
                    )}
                    {(task.status === "running" || task.status === "succeeded" || task.status === "failed") && (
                      <button className="btn" disabled={busy===task.id}
                        onClick={async () => {
                          setBusy(task.id);
                          try {
                            const exec = await api.latestExecForTask(task.id);
                            if (exec?.id) router.push(`/executions/${exec.id}`);
                            else alert("No execution record yet");
                          } finally { setBusy(null); }
                        }}>
                        {task.status === "running"
                          ? <><Loader2 size={14} className="animate-spin"/> {t("View progress")}</>
                          : <>{t("View execution")}</>}
                      </button>
                    )}
                    {(task.status === "pending" || task.status === "approved") && (
                      <button className="btn btn-danger" disabled={busy===task.id}
                        onClick={() => act(() => api.cancelTask(task.id), task.id)}>
                        <XCircle size={14}/> Cancel
                      </button>
                    )}
                    {task.status === "running" && (
                      <button className="btn btn-danger" disabled={busy===task.id}
                        onClick={() => {
                          if (confirm("Force-stop this task? The running SeaweedFS command will be interrupted and may leave the volume in an intermediate state.")) {
                            act(() => api.stopTask(task.id), task.id);
                          }
                        }}>
                        <Square size={14}/> Stop
                      </button>
                    )}
                    {(task.status === "failed" || task.status === "cancelled") && (
                      <button className="btn btn-primary" disabled={busy===task.id}
                        onClick={() => act(() => api.retryTask(task.id), task.id)}
                        title="Reset the task to approved so you can click Run again">
                        <RotateCcw size={14}/> Retry
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === task.id && (
                  <tr><td colSpan={7} className="bg-panel2/40">
                    <ScoreDebugger task={task}/>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        )}
        {!isLoading && items.length === 0 && (
          <EmptyState icon={ListChecks} title="No tasks in this state" hint="Tasks appear after Dashboard “Run scoring” or as policies trigger."/>
        )}
        {items.length > 0 && <Pagination {...pg}/>}
      </section>
    </div>
  );
}

function safeStringify(v: any) {
  if (!v) return "";
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v)); } catch { return v; } }
  return JSON.stringify(v);
}

function StatusBadge({ s }: { s: string }) {
  const c: Record<string, string> = {
    pending: "border-muted text-muted", approved: "border-accent/40 text-accent",
    running: "border-warning/40 text-warning", succeeded: "border-success/40 text-success",
    failed: "border-danger/40 text-danger", rolled_back: "border-muted text-muted",
    cancelled: "border-muted text-muted/70" };
  return <span className={`badge ${c[s] || ""}`}>{s}</span>;
}

function ScoreDebugger({ task }: { task: any }) {
  let feats: Record<string, number> = {};
  try { feats = typeof task.features === "string" ? JSON.parse(task.features) : task.features; } catch {}
  const entries = Object.entries(feats).sort((a, b) => b[1] - a[1]);
  return (
    <div className="p-4 space-y-5">
      <div>
        <div className="text-xs text-muted">Explanation</div>
        <div className="text-sm">{task.explanation || "—"}</div>
        <div className="text-xs text-muted mt-3">Feature contributions</div>
        <div className="grid grid-cols-2 gap-2 max-w-2xl">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <div className="text-xs w-44 text-muted">{k}</div>
              <div className="h-1.5 flex-1 rounded-full bg-panel2 overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.round(v * 100)}%` }}/>
              </div>
              <div className="text-xs font-mono w-12 text-right">{v.toFixed(2)}</div>
            </div>
          ))}
        </div>
      </div>

      <ReviewTimeline taskId={task.id}/>
    </div>
  );
}

// ----- AI Review timeline ---------------------------------------------------

interface ReviewRound {
  id: string;
  round_number: number;
  round_kind: "initial_scan" | "deep_analysis" | "devils_advocate" | "custom";
  verdict?: "proceed" | "abort" | "needs_human";
  confidence?: number;
  reasoning: string;
  factors: { name: string; weight: number; note?: string }[];
  prompt?: string;
  raw_response?: string;
  duration_ms?: number;
  error?: string;
}

interface ReviewResp {
  review: {
    id: string;
    verdict?: "proceed" | "abort" | "needs_human";
    confidence?: number;
    provider_name: string;
    status: string;
    error?: string;
    started_at: string;
    finished_at?: string;
  };
  rounds: ReviewRound[];
}

const ROUND_LABEL: Record<ReviewRound["round_kind"], string> = {
  initial_scan: "Initial scan",
  deep_analysis: "Deep analysis",
  devils_advocate: "Devil's advocate",
  custom: "Custom" };

const VERDICT_TONE: Record<NonNullable<ReviewRound["verdict"]>, { tone: string; icon: JSX.Element; label: string }> = {
  proceed:     { tone: "border-success/40 bg-success/10 text-success", icon: <ShieldCheck size={14}/>,  label: "PROCEED" },
  abort:       { tone: "border-danger/40 bg-danger/10 text-danger",    icon: <ShieldAlert size={14}/>, label: "ABORT" },
  needs_human: { tone: "border-warning/40 bg-warning/10 text-warning", icon: <UserCheck size={14}/>,   label: "NEEDS HUMAN" } };

function ReviewTimeline({ taskId }: { taskId: string }) {
  const { t } = useT();
  const { data, error, mutate } = useTaskReview(taskId);
  const [running, setRunning] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const runReview = async () => {
    setRunning(true); setErrMsg("");
    try { await api.runTaskReview(taskId); }
    catch (e) { setErrMsg(e instanceof Error ? e.message : "review failed"); }
    finally { setRunning(false); await mutate(); }
  };

  const resp = data as ReviewResp | undefined;
  const noReview = !resp && error;

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted flex items-center gap-2">
          <Sparkles size={14} className="text-accent"/>
          {t("Multi-round AI review")}
          {resp?.review.provider_name && (
            <span className="font-mono">· {resp.review.provider_name}</span>
          )}
        </div>
        <button onClick={runReview} disabled={running}
          className="btn btn-primary text-xs disabled:opacity-50">
          {running ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
          {resp ? t("Re-review") : t("Run review")}
        </button>
      </div>

      {errMsg && <div className="text-xs text-danger mb-2">{errMsg}</div>}

      {noReview && (
        <div className="text-xs text-muted">No AI review yet. Click "Run review" to start the 3-round check.</div>
      )}

      {resp && (
        <>
          {/* Aggregate verdict */}
          <div className="mb-3">
            {resp.review.verdict && (
              <span className={`px-3 py-1 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 ${VERDICT_TONE[resp.review.verdict].tone}`}>
                {VERDICT_TONE[resp.review.verdict].icon}
                {VERDICT_TONE[resp.review.verdict].label}
                {resp.review.confidence != null && (
                  <span className="font-normal opacity-80">
                    · confidence {Math.round(resp.review.confidence * 100)}%
                  </span>
                )}
              </span>
            )}
            {resp.review.status === "running" && (
              <span className="text-xs text-warning ml-2 flex items-center gap-1 inline-flex">
                <Loader2 size={12} className="animate-spin"/> Running
              </span>
            )}
          </div>

          {/* Rounds */}
          <div className="space-y-2 max-w-3xl">
            {resp.rounds.map(r => <RoundCard key={r.id} r={r}/>)}
          </div>
        </>
      )}
    </div>
  );
}

function RoundCard({ r }: { r: ReviewRound }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const tone = r.verdict ? VERDICT_TONE[r.verdict].tone : "border-border";
  return (
    <div className={`rounded-md border ${tone}`}>
      <button onClick={() => setOpen(!open)} className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-panel2/40">
        <span className="font-mono text-xs text-muted w-4">{r.round_number}</span>
        <span className="text-sm font-medium w-24">{ROUND_LABEL[r.round_kind]}</span>
        {r.verdict && (
          <span className="flex items-center gap-1 text-xs">
            {VERDICT_TONE[r.verdict].icon}
            {VERDICT_TONE[r.verdict].label}
          </span>
        )}
        {r.confidence != null && (
          <span className="text-xs text-muted">conf {Math.round(r.confidence * 100)}%</span>
        )}
        {r.duration_ms != null && (
          <span className="text-xs text-muted ml-auto font-mono">{r.duration_ms}ms</span>
        )}
        {r.error && <AlertTriangle size={12} className="text-danger"/>}
        {open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs space-y-2 border-t border-border">
          {r.error && <div className="text-danger">{r.error}</div>}
          {r.reasoning && <div className="text-text">{r.reasoning}</div>}
          {r.factors?.length > 0 && (
            <div className="space-y-1">
              {r.factors.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-32 text-muted truncate">{f.name}</span>
                  <div className="h-1 flex-1 bg-panel2 rounded-full overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(f.weight ?? 0) * 100}%` }}/>
                  </div>
                  <span className="text-muted text-[11px] w-10 text-right font-mono">{(f.weight ?? 0).toFixed(2)}</span>
                  {f.note && <span className="text-muted text-[11px] truncate flex-1">{f.note}</span>}
                </div>
              ))}
            </div>
          )}
          {r.raw_response && (
            <details className="text-muted">
              <summary className="cursor-pointer">{t("Raw response")}</summary>
              <pre className="font-mono text-[11px] bg-bg p-2 rounded mt-1 max-h-60 overflow-auto whitespace-pre-wrap">
                {r.raw_response}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
