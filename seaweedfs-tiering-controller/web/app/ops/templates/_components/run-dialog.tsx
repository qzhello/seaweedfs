"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Loader2, X, AlertTriangle, ChevronRight, FlaskConical } from "lucide-react";
import {
  useClusters, authHeaders,
  type OpsTemplate, type OpsStep,
} from "@/lib/api";
import { FlowCanvas, type FlowStepStatus, type StepRunStatus } from "@/components/ops/flow-canvas";
import { useT } from "@/lib/i18n";
import { ModalShell } from "./modal-shell";
import { ApprovalCard } from "./approval-card";
import { stepsOf, type StepStatus, type PendingConfirm } from "./shared";

export function RunDialog({
  template, initialClusterID, onClose,
}: { template: OpsTemplate; initialClusterID: string; onClose: () => void; }) {
  const { t } = useT();
  const { data: clusterData } = useClusters();
  const clusters: Array<{ id: string; name: string }> = clusterData?.items ?? [];
  // Operator MUST confirm which cluster to hit before any command
  // runs. Initialize from the topbar selection but force a real choice
  // when none exists.
  const [clusterID, setClusterIDLocal] = useState(initialClusterID);
  useEffect(() => {
    if (!clusterID && initialClusterID) setClusterIDLocal(initialClusterID);
  }, [initialClusterID]); // eslint-disable-line react-hooks/exhaustive-deps
  // Steps come straight from the saved template. Backfill IDs so the
  // flow canvas + per-step status map can address every node, even
  // when the template was saved before the DAG column existed.
  const steps = useMemo(() => {
    const arr = stepsOf(template);
    const taken = new Set(arr.map(s => s.id).filter(Boolean));
    let nextN = 1;
    return arr.map(s => {
      if (s.id) return s;
      while (taken.has(`s${nextN}`)) nextN++;
      const id = `s${nextN++}`;
      taken.add(id);
      return { ...s, id };
    });
  }, [template]);
  const stepIdByIdx = useMemo(() => steps.map(s => s.id!), [steps]);
  const vars  = template.variables ?? [];
  const [statuses, setStatuses] = useState<StepStatus[]>(() => steps.map(() => "pending"));
  const [outputs, setOutputs]   = useState<string[]>(() => steps.map(() => ""));
  const [errors, setErrors]     = useState<string[]>(() => steps.map(() => ""));
  const [resolved, setResolved] = useState<string[]>(() => steps.map(() => ""));
  const [running, setRunning]   = useState(false);
  const [done, setDone]         = useState(false);
  const [continueOnError, setContinueOnError] = useState(false);
  const needsInteractive = steps.some(s => s.confirm_before || (s.infer_vars && s.infer_vars.length > 0));
  const [interactive, setInteractive] = useState(needsInteractive);
  const [runID, setRunID] = useState<string>("");
  const [pendingMap, setPendingMap] = useState<Record<number, PendingConfirm>>({});
  const [focusStepId, setFocusStepId] = useState<string | null>(null);
  const [varInputs, setVarInputs] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const x of vars) v[x.key] = x.default ?? "";
    return v;
  });

  // Required variables must all be filled before we let the operator
  // hit Run. In interactive mode, variables that some step's
  // infer_vars will fill are deliberately NOT required upfront — the
  // operator confirms them when the approval card pops up. Only "no
  // one's going to fill this except you" variables block Run.
  const inferableKeySet = new Set<string>(
    steps.flatMap(s => (s.infer_vars || []).map(iv => iv.var))
  );
  const missingRequired = vars
    .filter(v => v.required && !(varInputs[v.key] ?? "").trim())
    .filter(v => !interactive || !inferableKeySet.has(v.key))
    .map(v => v.key);

  // Simulation mode: read-only commands + analyzer scripts execute,
  // mutating commands report what they'd run but don't fire. Skips
  // confirm pauses, AI inference, and alert emission. Surfaced via
  // a separate button so it's clearly distinct from a real Run.
  async function run(simulate = false) {
    if (running) return;
    if (!clusterID) return;
    if (!simulate && missingRequired.length > 0) return;
    setRunning(true); setDone(false);
    setStatuses(steps.map(() => "pending"));
    setOutputs(steps.map(() => ""));
    setErrors(steps.map(() => ""));
    setResolved(steps.map(() => ""));
    setPendingMap({});
    setRunID("");

    const qs = new URLSearchParams();
    if (continueOnError) qs.set("continue_on_error", "true");
    if (simulate) qs.set("simulate", "true");
    for (const v of vars) {
      const val = varInputs[v.key];
      if (val !== undefined && val !== "") qs.set(`var.${v.key}`, val);
    }
    // Simulation always uses the interactive endpoint (it's the one
    // that knows about kind="analyzer" and per-step gating) and the
    // ?simulate=true flag forces the read-only path.
    const endpoint = simulate || interactive ? "run-interactive" : "run";
    const url = `/api/v1/clusters/${clusterID}/ops/templates/${template.id}/${endpoint}`
              + (qs.toString() ? `?${qs.toString()}` : "");
    const headers: Record<string, string> = { ...authHeaders() };

    try {
      const r = await fetch(url, { headers });
      if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let event = "line";
      let currentIdx = -1;
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.startsWith("event: ")) {
            event = raw.slice(7).trim();
          } else if (raw.startsWith("data: ")) {
            const payload = raw.slice(6);
            if (event === "run_id") {
              try {
                const { run_id } = JSON.parse(payload) as { run_id: string };
                setRunID(run_id);
              } catch { /* ignore */ }
            } else if (event === "step_start") {
              try {
                const { index, args } = JSON.parse(payload) as { index: number; args?: string };
                currentIdx = index;
                setStatuses((s) => s.map((x, i) => (i === index ? "running" : x)));
                if (args !== undefined) {
                  setResolved((r) => r.map((x, i) => (i === index ? args : x)));
                }
                setPendingMap(m => {
                  if (!(index in m)) return m;
                  const { [index]: _drop, ...rest } = m;
                  void _drop;
                  return rest;
                });
                setFocusStepId(stepIdByIdx[index] ?? null);
              } catch { /* ignore */ }
            } else if (event === "line") {
              let handled = false;
              try {
                const m = JSON.parse(payload) as { index?: number; text?: string };
                if (typeof m.index === "number" && typeof m.text === "string") {
                  const idx = m.index;
                  const txt = m.text;
                  setOutputs((o) => o.map((x, i) => (i === idx ? x + txt + "\n" : x)));
                  handled = true;
                }
              } catch { /* not JSON, fall through */ }
              if (!handled && currentIdx >= 0) {
                const idx = currentIdx;
                setOutputs((o) => o.map((x, i) => (i === idx ? x + payload + "\n" : x)));
              }
            } else if (event === "step_done") {
              try {
                const { index } = JSON.parse(payload) as { index: number };
                setStatuses((s) => s.map((x, i) => (i === index ? "done" : x)));
              } catch { /* ignore */ }
            } else if (event === "step_error") {
              try {
                const { index, error } = JSON.parse(payload) as { index: number; error: string };
                setStatuses((s) => s.map((x, i) => (i === index ? "error" : x)));
                setErrors((e) => e.map((x, i) => (i === index ? error : x)));
              } catch { /* ignore */ }
            } else if (event === "step_skipped") {
              try {
                const { index, reason } = JSON.parse(payload) as { index: number; reason: string };
                setStatuses((s) => s.map((x, i) => (i === index ? "error" : x)));
                setErrors((e) => e.map((x, i) => (i === index ? "skipped: " + reason : x)));
              } catch { /* ignore */ }
            } else if (event === "schedule") {
              // Informational: which steps are about to start in parallel.
            } else if (event === "analysis_start") {
              try {
                const { index } = JSON.parse(payload) as { index: number };
                setStatuses((s) => s.map((x, i) => (i === index ? "running" : x)));
              } catch { /* ignore */ }
            } else if (event === "analysis_error") {
              try {
                const { index, error } = JSON.parse(payload) as { index: number; error: string };
                setErrors((e) => e.map((x, i) => (i === index ? "AI inference unavailable: " + error : x)));
              } catch { /* ignore */ }
            } else if (event === "await_confirm") {
              try {
                const p = JSON.parse(payload) as PendingConfirm;
                setPendingMap(m => ({ ...m, [p.index]: p }));
                setStatuses((s) => s.map((x, i) => (i === p.index ? "pending" : x)));
              } catch { /* ignore */ }
            } else if (event === "cancelled") {
              setPendingMap({});
            } else if (event === "done") {
              setDone(true);
            }
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors((arr) => {
        const next = arr.slice();
        const firstPending = statuses.findIndex((s) => s !== "done");
        if (firstPending >= 0) next[firstPending] = msg;
        return next;
      });
    } finally {
      setRunning(false);
      setDone(true);
      setRunID("");
    }
  }

  function makeApprover(pendingIdx: number) {
    return async (varValues: Record<string, string>) => {
      if (!runID) return;
      const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
      try {
        const stepId = stepIdByIdx[pendingIdx];
        const r = await fetch(`/api/v1/ops-runs/${runID}/approve`, {
          method: "POST", headers,
          body: JSON.stringify({ step_id: stepId, vars: varValues }),
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("approve failed", e);
      }
    };
  }

  async function cancelRun() {
    if (!runID) return;
    const headers: Record<string, string> = { ...authHeaders() };
    try {
      await fetch(`/api/v1/ops-runs/${runID}/cancel`, { method: "POST", headers });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("cancel failed", e);
    }
  }

  return (
    <ModalShell onClose={onClose} title={`${t("Run")}: ${template.name}`} wide>
      <div className="space-y-3">
        <div className={`card p-3 ${clusterID ? "bg-panel/40" : "border-warning/50 bg-warning/5"}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-xs uppercase tracking-wider text-muted/70 shrink-0">
              {t("Target cluster")}
            </div>
            <select
              value={clusterID}
              onChange={(e) => setClusterIDLocal(e.target.value)}
              disabled={running}
              className="bg-panel2 border border-border rounded-md px-2 py-1 text-sm flex-1 min-w-[200px]"
            >
              <option value="">{t("— pick a cluster —")}</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.id.slice(0, 8)})</option>
              ))}
            </select>
            {!clusterID && (
              <span className="text-[11px] text-warning inline-flex items-center gap-1">
                <AlertTriangle size={12}/>
                {t("Confirm the cluster before running — commands execute on whichever you pick.")}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-muted flex-1 min-w-[60%]">{template.description}</p>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted inline-flex items-center gap-2"
              title={t("Pause on confirm_before steps; AI infers variable values from prior outputs.")}>
              <input
                type="checkbox" checked={interactive}
                onChange={(e) => setInteractive(e.target.checked)}
                disabled={running}
              />
              {t("Interactive (AI + step approval)")}
            </label>
            <label className="text-xs text-muted inline-flex items-center gap-2">
              <input
                type="checkbox" checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                disabled={running || interactive}
              />
              {t("Continue on error")}
            </label>
          </div>
        </div>

        {(() => {
          const inferableKeys = new Set<string>(
            steps.flatMap(s => (s.infer_vars || []).map(iv => iv.var))
          );
          const upfrontVars = interactive
            ? vars.filter(v => !inferableKeys.has(v.key))
            : vars;
          if (upfrontVars.length === 0) return null;
          return (
            <div className="card p-3 space-y-2 bg-panel/40">
              <div className="text-xs uppercase tracking-wider text-muted/70">
                {t("Inputs")}
                {interactive && inferableKeys.size > 0 && (
                  <span className="ml-2 normal-case tracking-normal text-muted/60">
                    — {t("AI-inferred variables collected per step below")}
                  </span>
                )}
              </div>
              {upfrontVars.map((v) => (
                <div key={v.key} className="grid grid-cols-12 gap-2 items-center">
                  <label className="col-span-3 text-xs text-muted">
                    {v.label || v.key}
                    {v.required && <span className="text-danger ml-1">*</span>}
                    <span className="block text-[10px] font-mono text-muted/60">{`{{${v.key}}}`}</span>
                  </label>
                  <input
                    value={varInputs[v.key] ?? ""}
                    onChange={(e) => setVarInputs((s) => ({ ...s, [v.key]: e.target.value }))}
                    placeholder={v.default || ""}
                    disabled={running}
                    className="col-span-9 bg-panel2 border border-border rounded-md px-2 py-1 text-sm font-mono"
                  />
                  {v.help && <p className="col-span-12 col-start-4 text-[11px] text-muted">{v.help}</p>}
                </div>
              ))}
            </div>
          );
        })()}

        {(() => {
          const flowStatuses: Record<string, FlowStepStatus> = {};
          steps.forEach((s, i) => {
            const id = s.id!;
            const st = statuses[i];
            let status: StepRunStatus = "idle";
            if (st === "running") status = "running";
            else if (st === "done") status = "done";
            else if (st === "error") status = "error";
            else if (st === "pending") status = i in pendingMap ? "awaiting" : "pending";
            flowStatuses[id] = {
              status,
              outputPreview: outputs[i] ? outputs[i].trim().split("\n").slice(-1)[0] : undefined,
              error: errors[i] || undefined,
            };
          });
          const firstPendingIdx = Object.keys(pendingMap)
            .map(Number).sort((a, b) => a - b)[0];
          const effectiveFocus = focusStepId
            ?? (firstPendingIdx !== undefined ? stepIdByIdx[firstPendingIdx] : null)
            ?? null;
          return (
            <FlowCanvas
              steps={steps}
              statuses={flowStatuses}
              selectedId={effectiveFocus ?? undefined}
              onSelect={setFocusStepId}
              height={360}
            />
          );
        })()}

        {Object.keys(pendingMap).length > 1 && (
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-muted">{t("Awaiting approval:")}</span>
            {Object.keys(pendingMap).map(Number).sort((a, b) => a - b).map(idx => {
              const id = stepIdByIdx[idx];
              const isFocus = id === (focusStepId ?? (Object.keys(pendingMap).map(Number).sort((a, b) => a - b)[0] !== undefined
                ? stepIdByIdx[Object.keys(pendingMap).map(Number).sort((a, b) => a - b)[0]] : null));
              return (
                <button
                  key={idx}
                  onClick={() => setFocusStepId(id)}
                  className={`badge inline-flex items-center gap-1.5 ${
                    isFocus
                      ? "border-warning/60 text-warning bg-warning/10"
                      : "border-warning/30 text-warning/80 hover:bg-warning/5"
                  }`}
                  title={steps[idx]?.command}
                >
                  <Loader2 size={10} className="animate-spin"/>
                  <span className="font-mono">{id}</span>
                  <span className="text-muted/80 normal-case font-normal">{steps[idx]?.command}</span>
                </button>
              );
            })}
          </div>
        )}

        {(() => {
          const firstPending = Object.keys(pendingMap).map(Number).sort((a, b) => a - b)[0];
          const id = focusStepId ?? (firstPending !== undefined ? stepIdByIdx[firstPending] : null);
          if (!id) {
            return (
              <div className="text-[11px] text-muted text-center py-3">
                {t("Click a node to see its output, errors, and approve any pending action.")}
              </div>
            );
          }
          const idx = stepIdByIdx.indexOf(id);
          if (idx < 0) return null;
          const s = steps[idx];
          const focusedPending = pendingMap[idx] ?? null;
          return (
            <StepRow
              key={id}
              idx={idx}
              step={s}
              status={statuses[idx]}
              output={outputs[idx]}
              error={errors[idx]}
              resolvedArgs={resolved[idx]}
              pending={focusedPending}
              onApprove={makeApprover(idx)}
              onCancel={cancelRun}
              aiPrecheckEnabled={template.ai_precheck ?? true}
              templateGoal={template.description ?? ""}
              priorOutput={idx > 0 ? outputs[idx - 1] : ""}
            />
          );
        })()}

        <div className="flex justify-end gap-2 pt-1 flex-wrap">
          {running && runID && (
            <button
              onClick={cancelRun}
              className="btn border-danger/40 text-danger hover:bg-danger/10 inline-flex items-center gap-1.5"
              title={t("Stop this run immediately. Already-finished steps are not undone.")}
            >
              <X size={12}/> {t("Cancel run")}
            </button>
          )}
          <button onClick={onClose} className="btn">{done ? t("Close") : t("Dismiss")}</button>
          {missingRequired.length > 0 && (
            <span className="text-[11px] text-danger self-center mr-2">
              {t("Missing required input(s): {keys}").replace("{keys}", missingRequired.join(", "))}
            </span>
          )}
          {/* Simulate: dry-run that only executes read-only +
              analyzer steps. Doesn't require missing inputs because
              mutating commands won't fire anyway. */}
          <button
            onClick={() => run(true)}
            disabled={running || !clusterID}
            className="btn inline-flex items-center gap-2"
            title={t("Dry-run: read-only commands + analyzer scripts execute against the live cluster; mutating commands are reported but skipped.")}
          >
            <FlaskConical size={14}/>
            {t("Simulate")}
          </button>
          <button onClick={() => run(false)} disabled={running || !clusterID || missingRequired.length > 0}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            {running ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
            {done && !running ? t("Run again") : t("Run")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// StepRow renders one focused step's collapsible detail panel
// (resolved args, output, error). When the step is paused awaiting
// approval, an ApprovalCard is rendered inline at the top.
function StepRow({
  idx, step, status, output, error, resolvedArgs, pending, onApprove, onCancel,
  aiPrecheckEnabled, templateGoal, priorOutput,
}: {
  idx: number; step: OpsStep; status: StepStatus; output: string; error: string;
  resolvedArgs?: string;
  pending: PendingConfirm | null;
  onApprove: (vars: Record<string, string>) => Promise<void>;
  onCancel: () => Promise<void>;
  aiPrecheckEnabled: boolean;
  templateGoal: string;
  priorOutput: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const effOpen = open || !!pending || status === "running" || status === "error";
  const statusBadge: Record<StepStatus, string> = {
    pending: "border-muted text-muted",
    running: "border-warning/40 text-warning",
    done:    "border-success/40 text-success",
    error:   "border-danger/40 text-danger",
  };
  return (
    <div className={`card p-3 bg-panel/40 ${pending ? "ring-1 ring-warning/40" : ""}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 text-left">
        <span className="text-xs font-mono w-6 text-muted">{idx + 1}.</span>
        <span className="flex-1 font-mono text-xs truncate">
          {step.command} <span className="text-muted">{step.args || ""}</span>
        </span>
        {pending && (
          <span className="badge border-warning/40 text-warning inline-flex items-center gap-1">
            <Loader2 size={11} className="animate-spin"/> {t("Awaiting your approval")}
          </span>
        )}
        {!pending && (
          <span className={`badge ${statusBadge[status]}`}>
            {status === "running" && <Loader2 size={11} className="animate-spin inline mr-1"/>}
            {t(status)}
          </span>
        )}
        <ChevronRight size={14} className={`text-muted transition-transform ${effOpen ? "rotate-90" : ""}`}/>
      </button>
      {pending && (
        <ApprovalCard
          pending={pending}
          onApprove={onApprove}
          onCancel={onCancel}
          aiPrecheckEnabled={aiPrecheckEnabled}
          templateGoal={templateGoal}
          priorOutput={priorOutput}
        />
      )}
      {effOpen && (
        <div className="mt-3 space-y-2">
          {resolvedArgs !== undefined && resolvedArgs !== "" && resolvedArgs !== step.args && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted/70 mb-1">{t("Resolved")}</div>
              <pre className="text-[11px] font-mono bg-panel2 border border-border rounded-md p-2 whitespace-pre-wrap break-all">
                {step.command} {resolvedArgs}
              </pre>
            </div>
          )}
          {error && (
            <pre className="text-[11px] font-mono text-danger bg-danger/10 border border-danger/30 rounded-md p-2 whitespace-pre-wrap break-all">
              {error}
            </pre>
          )}
          {output && (
            <pre className="text-[11px] font-mono bg-black/40 border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {output}
            </pre>
          )}
          {!output && !error && status === "pending" && (
            <p className="text-[11px] text-muted">{t("Not started yet.")}</p>
          )}
          {!output && !error && status === "running" && (
            <p className="text-[11px] text-muted inline-flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin"/>
              {t("Running… stdout will stream here as the command emits lines. Short commands may only print at completion.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
