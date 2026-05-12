"use client";

// Generic shell-action launcher. Used by /buckets, /collections, and the
// cluster-detail node panel to expose per-row weed shell actions without
// each page reimplementing the form + run + audit logic.
//
// Caller declares a list of ShellAction descriptors (label, command,
// optional fields, buildArgs). The component renders a dropdown menu
// and, on pick, opens a single-row dialog that collects field input +
// the mandatory reason, then calls /clusters/:id/shell. Output is
// rendered as a wrapped pre.

import { useState } from "react";
import { MoreVertical, ShieldAlert, AlertTriangle, Loader2, X, CheckCircle2, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export interface ShellActionField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
  default?: string;
}

export interface ShellAction<Row> {
  key: string;
  label: string;
  command: string;
  risk: "read" | "mutate" | "destructive";
  fields?: ShellActionField[];
  // Build the `args` string for /clusters/:id/shell. May return null to
  // abort with a "skipped" status.
  buildArgs: (row: Row, input: Record<string, string>) => string | null;
  // Hide from the menu when the predicate returns false (e.g. mark-RO
  // only on writable rows).
  visibleIf?: (row: Row) => boolean;
}

export function ShellActionMenu<Row>({
  row, actions, onPick,
}: {
  row: Row;
  actions: ShellAction<Row>[];
  onPick: (a: ShellAction<Row>) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const visible = actions.filter((a) => !a.visibleIf || a.visibleIf(row));
  if (visible.length === 0) return null;
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((x) => !x); }}
        className="p-1 text-muted hover:text-text"
        title={t("Actions")}
      >
        <MoreVertical size={14}/>
      </button>
      {open && (
        <>
          <button onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default" aria-hidden/>
          <div className="absolute right-0 mt-1 z-40 w-56 rounded-md border border-border bg-panel shadow-lg py-1">
            {visible.map((a) => {
              const danger = a.risk === "destructive";
              return (
                <button
                  key={a.key}
                  onClick={() => { setOpen(false); onPick(a); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-panel2 ${danger ? "text-rose-300" : ""}`}
                >
                  {t(a.label)}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ShellActionDialog: collect inputs, fire the call, show status. Stays
// open until the operator closes it so they can read errors.
export function ShellActionDialog<Row>({
  clusterID, row, action, onClose,
}: {
  clusterID: string;
  row: Row;
  action: ShellAction<Row>;
  onClose: (didRun: boolean) => void;
}) {
  const { t } = useT();
  const [input, setInput] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of action.fields || []) v[f.key] = f.default ?? "";
    return v;
  });
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");

  const fieldsOk = (action.fields || []).every((f) => !f.required || (input[f.key] || "").trim().length > 0);
  const canRun = !running && !done && fieldsOk;
  const danger = action.risk === "destructive";

  async function run() {
    setError(""); setOutput(""); setRunning(true);
    try {
      const args = action.buildArgs(row, input);
      if (args === null) {
        setOutput(t("Skipped (no-op)."));
      } else {
        const r = await api.runClusterShell(clusterID, { command: action.command, args, reason });
        // Many mutating shell commands (e.g. s3.bucket.create) print
        // nothing on success. Empty stdout + no error == done; show a
        // clear confirmation instead of the confusing "(no output)".
        setOutput(r.output?.trim() ? r.output : t("Done — command finished with no output."));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setDone(true);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
         onClick={() => !running && onClose(done)}>
      <div className="card p-5 w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium inline-flex items-center gap-2">
            {danger ? <ShieldAlert size={16} className="text-rose-300"/>
                    : action.risk === "mutate" ? <AlertTriangle size={16} className="text-amber-300"/> : null}
            {t(action.label)} <span className="text-xs text-muted font-mono">· {action.command}</span>
          </h2>
          {!running && <button onClick={() => onClose(done)} className="p-1 text-muted hover:text-text"><X size={16}/></button>}
        </div>

        {danger && !done && (
          <div className="mb-3 text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-2">
            {t("This action is destructive and cannot be undone.")}
          </div>
        )}

        {!done && (
          <div className="space-y-3">
            {(action.fields || []).map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted">
                  {t(f.label)}{f.required && <span className="text-rose-400 ml-1">*</span>}
                </label>
                <input
                  value={input[f.key] ?? ""}
                  onChange={(e) => setInput((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm font-mono"
                  disabled={running}
                />
                {f.help && <p className="text-[11px] text-muted">{t(f.help)}</p>}
              </div>
            ))}
            <div className="space-y-1">
              <label className="text-xs text-muted">{t("Reason")}</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("Why are you running this? (logged in audit)")}
                className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
                disabled={running}
              />
            </div>
          </div>
        )}

        {error && (
          <pre className="mt-3 text-[11px] font-mono text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md p-2 whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}
        {output && (
          <div className="mt-3 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted/70 inline-flex items-center gap-1">
              <CheckCircle2 size={12} className="text-emerald-300"/> {t("Output")}
            </div>
            <pre className="text-[11px] font-mono bg-black/40 border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {output}
            </pre>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4">
          {!done ? (
            <>
              <button onClick={() => onClose(false)} className="btn" disabled={running}>{t("Cancel")}</button>
              <button onClick={run} disabled={!canRun}
                className={`btn inline-flex items-center gap-2 ${danger ? "bg-rose-500/80 text-white hover:bg-rose-500" : "bg-accent text-accent-fg"} disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {running ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
                {t("Run")}
              </button>
            </>
          ) : (
            <button onClick={() => onClose(true)} className="btn bg-accent text-accent-fg">{t("Close")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
