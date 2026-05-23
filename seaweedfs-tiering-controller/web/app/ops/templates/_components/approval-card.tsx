"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, CheckCircle2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { PendingConfirm } from "./shared";

// ApprovalCard renders the inline confirm pause UI. It shows:
//   - the rendered command + args that's about to fire,
//   - editable inputs for any variable values the AI proposed
//     (pre-filled, but editable — the operator's word is final),
//   - editable inputs for any variables that are still missing,
//   - Approve + Cancel buttons.
//
// The operator's edits go back via /ops-runs/<id>/approve. Cancel
// terminates the entire run (same as the top Cancel button).
export function ApprovalCard({
  pending, onApprove, onCancel, aiPrecheckEnabled, templateGoal, priorOutput,
}: {
  pending: PendingConfirm;
  onApprove: (vars: Record<string, string>) => Promise<void>;
  onCancel: () => Promise<void>;
  aiPrecheckEnabled: boolean;
  templateGoal: string;
  priorOutput: string;
}) {
  const { t } = useT();
  // Initial form values: pre-fill from AI proposal for proposed
  // vars; leave required ones empty so the operator types them.
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...pending.proposed_vars }));
  const [busy, setBusy] = useState(false);

  // AI advisor state. `advice` is the latest result; `adviceErr` is
  // the last failure message (e.g. timeout, no provider). `checking`
  // tracks the in-flight request so the button can spin and the block
  // can render a loading hint. Auto-fires once on mount for mutating
  // steps when the template has ai_precheck=true; otherwise the
  // operator can trigger it manually.
  const [advice, setAdvice] = useState<{ risk?: string; watch_out?: string; rollback?: string } | null>(null);
  const [adviceErr, setAdviceErr] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const isMutating = pending.risk === "mutate" || pending.risk === "destructive";
  // Build the same args preview we use for the operator, so the model
  // reasons about exactly what they'd approve.
  const livePreviewForAI = (pending.args_template
    ? pending.args_template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g,
        (m, key) => (vals[key] ?? "") || m)
    : pending.rendered_args);
  async function runPrecheck() {
    setChecking(true);
    setAdviceErr("");
    try {
      const r = await api.precheckOpsStep({
        command: pending.command,
        rendered_args: livePreviewForAI,
        reason: pending.reason,
        template_goal: templateGoal,
        prior_output: priorOutput,
      });
      if (r.ok && r.advice) {
        setAdvice(r.advice);
      } else {
        setAdviceErr(r.error || t("AI advisor unavailable"));
      }
    } catch (e: unknown) {
      setAdviceErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }
  // Auto-fire once per pending step. The dependency array intentionally
  // omits livePreviewForAI so we don't re-call the AI on every keystroke
  // — the operator can manually re-run after editing if they want fresh
  // advice with their values.
  useEffect(() => {
    if (aiPrecheckEnabled && isMutating && !advice && !checking && !adviceErr) {
      runPrecheck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.index]);
  // Union of vars the operator can edit: those proposed by AI plus
  // those still required because the substitution didn't resolve.
  const allKeys = Array.from(new Set([
    ...Object.keys(pending.proposed_vars || {}),
    ...(pending.required_vars || []),
  ]));
  const canApprove = (pending.required_vars || []).every(k => (vals[k] ?? "").trim() !== "");
  const approve = async () => {
    setBusy(true);
    try { await onApprove(vals); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try { await onCancel(); } finally { setBusy(false); }
  };
  // Live-render the command preview using the operator's current
  // input values. Without this the preview at the top would freeze
  // the AI proposal and stop matching what the inputs say.
  const livePreview = (pending.args_template
    ? pending.args_template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g,
        (m, key) => (vals[key] ?? "") || m)
    : pending.rendered_args);
  return (
    <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3 space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-warning/80 inline-flex items-center gap-1.5">
        <Sparkles size={11}/> {t("Confirm before running")}
      </div>
      {pending.reason && (
        <p className="text-xs text-muted italic">&quot;{pending.reason}&quot;</p>
      )}
      {pending.analysis && (
        <div className="rounded-md bg-panel2/60 border border-border p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-warning/80 inline-flex items-center gap-1.5">
            <Sparkles size={10}/> {t("AI analysis")}
          </div>
          <div className="text-[12px] leading-relaxed whitespace-pre-wrap break-words">
            {pending.analysis}
          </div>
        </div>
      )}
      {isMutating && (
        <div className="rounded-md bg-panel2/60 border border-border p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-warning/80 inline-flex items-center gap-1.5">
              <Sparkles size={10}/> {t("AI risk advisor")}
              {checking && <Loader2 size={10} className="animate-spin"/>}
            </div>
            {!checking && (
              <button onClick={runPrecheck}
                className="text-[10px] text-muted hover:text-fg inline-flex items-center gap-1">
                <Sparkles size={9}/>
                {advice || adviceErr ? t("Re-check") : t("Ask AI")}
              </button>
            )}
          </div>
          {!advice && !adviceErr && !checking && (
            <p className="text-[11px] text-muted italic">
              {aiPrecheckEnabled
                ? t("Asking AI for risk advice…")
                : t("AI advice is off for this template. Click \"Ask AI\" to request a one-time check.")}
            </p>
          )}
          {advice && (
            <div className="text-[12px] leading-relaxed space-y-1">
              {advice.risk && (
                <div><span className="text-warning font-medium">{t("Risk: ")}</span>{advice.risk}</div>
              )}
              {advice.watch_out && (
                <div><span className="text-warning font-medium">{t("Watch out: ")}</span>{advice.watch_out}</div>
              )}
              {advice.rollback && (
                <div><span className="text-warning font-medium">{t("Rollback: ")}</span>{advice.rollback}</div>
              )}
              {!advice.risk && !advice.watch_out && !advice.rollback && (
                <p className="text-[11px] text-muted italic">{t("AI had no specific advice to offer.")}</p>
              )}
            </div>
          )}
          {adviceErr && (
            <p className="text-[11px] text-muted italic">
              {t("AI advisor unavailable: {err}").replace("{err}", adviceErr)}
            </p>
          )}
        </div>
      )}
      {allKeys.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted/70 inline-flex items-center gap-1.5">
            {t("Variables for this step")}
            {Object.keys(pending.proposed_vars || {}).length > 0 && (
              <span className="text-warning/80 inline-flex items-center gap-1 normal-case tracking-normal">
                <Sparkles size={10}/> {t("review AI proposal before approving")}
              </span>
            )}
          </div>
          {allKeys.map(k => {
            const aiProposed = k in (pending.proposed_vars || {});
            const required = (pending.required_vars || []).includes(k);
            return (
              <div key={k} className="grid grid-cols-12 gap-2 items-center">
                <label className="col-span-3 text-xs">
                  <span className="font-mono">{k}</span>
                  {required && <span className="text-danger ml-1">*</span>}
                  {aiProposed && (
                    <span className="ml-1 text-[10px] text-warning" title={t("Suggested by AI")}>AI</span>
                  )}
                </label>
                <input
                  value={vals[k] ?? ""}
                  onChange={e => setVals(s => ({ ...s, [k]: e.target.value }))}
                  className="col-span-9 bg-panel2 border border-border rounded-md px-2 py-1 text-sm font-mono"
                />
              </div>
            );
          })}
        </div>
      )}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted/70 mb-1">{t("Will execute")}</div>
        <pre className="text-[11px] font-mono bg-panel2 border border-border rounded-md p-2 whitespace-pre-wrap break-all">
          {pending.command} {livePreview}
        </pre>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={cancel} disabled={busy}
          className="btn border-danger/40 text-danger hover:bg-danger/10 inline-flex items-center gap-1.5">
          <X size={12}/> {t("Cancel run")}
        </button>
        <button onClick={approve} disabled={busy || !canApprove}
          className="btn bg-accent text-accent-fg inline-flex items-center gap-1.5">
          {busy ? <Loader2 size={12} className="animate-spin"/> : <CheckCircle2 size={12}/>}
          {t("Approve & continue")}
        </button>
      </div>
    </div>
  );
}
