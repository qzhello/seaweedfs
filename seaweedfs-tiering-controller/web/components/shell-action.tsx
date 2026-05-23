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
import { MoreVertical, ShieldAlert, AlertTriangle, Loader2, X, CheckCircle2, Play, ShieldCheck } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Result of the preflight lock probe injected into the dialog right before
// a mutating run. `null` = not yet probed; `free` = OK to proceed; the
// other two states require an explicit "continue anyway" confirmation.
interface PreflightProbe {
  status: "free" | "held" | "quorum_unhealthy";
  holder?: string;
  message?: string;
  address?: string;
}

export interface ShellActionField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
  default?: string;
}

// Key under which the Apply-checkbox state is injected into the
// buildArgs `input` map: "1" when checked, "" otherwise. Lets an action
// emit `-apply` only when the operator opts in. Several weed shell
// commands (collection.delete, volume.balance, volume.fix.replication)
// default to a harmless simulation and only mutate with -apply.
export const APPLY_INPUT_KEY = "__apply";

export interface ShellAction<Row> {
  key: string;
  label: string;
  command: string;
  risk: "read" | "mutate" | "destructive";
  fields?: ShellActionField[];
  // When set, the dialog renders an "Apply (actually run)" checkbox.
  // Unchecked (default) the command runs in its native simulation mode;
  // checked, buildArgs sees input[APPLY_INPUT_KEY] === "1" and should
  // append `-apply`. label/help override the default checkbox copy.
  apply?: { label?: string; help?: string };
  // Run via the SSE /shell/stream endpoint instead of the buffered POST
  // /shell. Required for slow mutating commands (collection.delete -apply
  // deletes every volume in the collection): the buffered handler emits
  // no bytes until done, so the dev/prod proxy times out the silent
  // connection and returns 500. Streaming keeps bytes flowing (lock →
  // command → unlock → exit) and shows live output.
  stream?: boolean;
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
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-panel2 ${danger ? "text-danger" : ""}`}
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
    if (action.apply) v[APPLY_INPUT_KEY] = "";
    return v;
  });
  const applied = (input[APPLY_INPUT_KEY] || "") === "1";
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  // Preflight lock probe state. Null until a mutating run is attempted;
  // once populated with a non-free result the user must click Run a
  // second time to bypass — that second click clears `probe` and
  // proceeds, replicating the manual "are you sure?" affordance without
  // an extra modal layer.
  const [probe, setProbe] = useState<PreflightProbe | null>(null);
  const [probing, setProbing] = useState(false);

  // willMutate gates the preflight: read-only actions don't take the
  // cluster admin lock, and `apply`-gated actions only mutate when the
  // checkbox is ticked. Without this check we'd probe for harmless
  // dry-runs and slow down the most common path.
  const willMutate = action.risk !== "read" && (!action.apply || applied);
  const needsAck = probe && probe.status !== "free";

  const fieldsOk = (action.fields || []).every((f) => !f.required || (input[f.key] || "").trim().length > 0);
  const canRun = !running && !done && fieldsOk;
  const danger = action.risk === "destructive";

  // SSE consumer for action.stream. Mirrors ops/page.tsx::streamShell:
  // EventSource can't set Authorization, so we fetch + parse SSE by hand.
  // Lines append live so the operator sees lock/command/unlock progress
  // and the proxy connection never goes silent (no timeout → no 500).
  async function runStreaming(args: string) {
    const qs = new URLSearchParams({ command: action.command });
    if (args) qs.set("args", args);
    if (reason) qs.set("reason", reason);
    const headers: Record<string, string> = {};
    const tok = getToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    const r = await fetch(`/api/v1/clusters/${clusterID}/shell/stream?${qs.toString()}`, { headers });
    if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let event = "line";
    const acc: string[] = [];
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        if (raw.startsWith("event: ")) {
          event = raw.slice(7).trim();
        } else if (raw.startsWith("data: ")) {
          const payload = raw.slice(6);
          if (event === "line") {
            acc.push(payload);
            setOutput(acc.join("\n"));
          } else if (event === "error") {
            throw new Error(payload);
          } else if (event === "done") {
            setOutput(acc.length ? acc.join("\n") : t("Done — command finished with no output."));
            return;
          }
        }
      }
    }
    setOutput(acc.length ? acc.join("\n") : t("Done — command finished with no output."));
  }

  async function run() {
    // Preflight: only when this run will actually take the shell lock,
    // and only on the first click. A second click clears `probe` first,
    // then bypasses — that's the "Continue anyway" path.
    if (willMutate && probe === null) {
      setError("");
      setProbing(true);
      try {
        const p = await api.lockProbe(clusterID);
        setProbe({
          status: p.status,
          holder: p.holder,
          message: p.message,
          address: p.address,
        });
        if (p.status !== "free") {
          // Stop. The banner explains the state; the operator clicks Run
          // again to bypass once they've read it.
          setProbing(false);
          return;
        }
      } catch (e: unknown) {
        // Probe failures shouldn't permanently block — surface the
        // error and let the user override, same as a "held" result.
        setProbe({
          status: "quorum_unhealthy",
          message: e instanceof Error ? e.message : String(e),
        });
        setProbing(false);
        return;
      } finally {
        setProbing(false);
      }
    }

    setError(""); setOutput(""); setRunning(true);
    // Clear the probe so a future "run again from the same dialog"
    // re-probes instead of inheriting a stale result.
    setProbe(null);
    try {
      const args = action.buildArgs(row, input);
      if (args === null) {
        setOutput(t("Skipped (no-op)."));
      } else if (action.stream) {
        await runStreaming(args);
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
            {danger ? <ShieldAlert size={16} className="text-danger"/>
                    : action.risk === "mutate" ? <AlertTriangle size={16} className="text-warning"/> : null}
            {t(action.label)} <span className="text-xs text-muted font-mono">· {action.command}</span>
          </h2>
          {!running && <button onClick={() => onClose(done)} className="p-1 text-muted hover:text-text"><X size={16}/></button>}
        </div>

        {danger && !done && (
          action.apply && !applied ? (
            <div className="mb-3 text-xs text-warning bg-warning/10 border border-warning/30 rounded-md px-3 py-2">
              {t("Dry-run mode — nothing is changed. Tick \"Apply\" below to actually run this destructive command.")}
            </div>
          ) : (
            <div className="mb-3 text-xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2">
              {t("This action is destructive and cannot be undone.")}
            </div>
          )
        )}

        {!done && (
          <div className="space-y-3">
            {(action.fields || []).map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted">
                  {t(f.label)}{f.required && <span className="text-danger ml-1">*</span>}
                </label>
                <input
                  value={input[f.key] ?? ""}
                  onChange={(e) => { setInput((s) => ({ ...s, [f.key]: e.target.value })); setProbe(null); }}
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

            {action.apply && (
              <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                applied ? "border-danger/40 bg-danger/10" : "border-border bg-panel2/40 hover:border-border"
              }`}>
                <input
                  type="checkbox"
                  className="mt-0.5 accent-danger"
                  checked={applied}
                  disabled={running}
                  onChange={(e) => { setInput((s) => ({ ...s, [APPLY_INPUT_KEY]: e.target.checked ? "1" : "" })); setProbe(null); }}
                />
                <span className="flex-1">
                  <span className={`text-sm font-medium inline-flex items-center gap-1.5 ${applied ? "text-danger" : ""}`}>
                    {applied && <AlertTriangle size={12}/>}
                    {t(action.apply.label ?? "Apply (actually run — default is a safe dry-run)")}
                  </span>
                  <span className="block text-[11px] text-muted mt-0.5">
                    {t(action.apply.help ?? "Leave unchecked to preview what the command would do. The shell prints a simulation and changes nothing.")}
                  </span>
                </span>
              </label>
            )}
          </div>
        )}

        {needsAck && !done && (
          <div className={`mt-3 text-xs rounded-md px-3 py-2 border ${
            probe!.status === "held"
              ? "text-warning bg-warning/10 border-warning/30"
              : "text-danger bg-danger/10 border-danger/30"
          }`}>
            <div className="font-medium inline-flex items-center gap-1.5">
              {probe!.status === "held"
                ? <><AlertTriangle size={12}/> {t("Cluster admin lock is held")}</>
                : <><ShieldAlert size={12}/> {t("Cluster quorum is unhealthy")}</>}
            </div>
            {probe!.status === "held" && (
              <div className="text-[11px] mt-1 text-muted">
                {t("Currently held by")} <span className="font-mono text-warning">{probe!.holder || t("unknown")}</span>
                {probe!.address && <> {t("on")} <span className="font-mono">{probe!.address}</span></>}.
                {" "}{t("Running now will block until they release.")}
              </div>
            )}
            {probe!.status === "quorum_unhealthy" && (
              <div className="text-[11px] mt-1 font-mono text-muted break-all">
                {probe!.message || t("probe failed")}
              </div>
            )}
            <div className="text-[11px] mt-1 text-muted">
              {t("Click \"Continue anyway\" to bypass and run.")}
            </div>
          </div>
        )}

        {error && (
          <pre className="mt-3 text-[11px] font-mono text-danger bg-danger/10 border border-danger/30 rounded-md p-2 whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}
        {output && (
          <div className="mt-3 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted/70 inline-flex items-center gap-1">
              <CheckCircle2 size={12} className="text-success"/> {t("Output")}
            </div>
            <pre className="text-[11px] font-mono bg-black/40 border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {output}
            </pre>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4">
          {!done ? (
            <>
              <button onClick={() => onClose(false)} className="btn" disabled={running || probing}>{t("Cancel")}</button>
              <button onClick={run} disabled={!canRun || probing}
                className={`btn inline-flex items-center gap-2 ${
                  needsAck
                    ? "bg-danger/80 text-white hover:bg-danger"
                    : action.apply && !applied
                      ? "bg-accent text-accent-fg"
                      : danger
                        ? "bg-danger/80 text-white hover:bg-danger"
                        : "bg-accent text-accent-fg"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {probing
                  ? <Loader2 size={14} className="animate-spin"/>
                  : running
                    ? <Loader2 size={14} className="animate-spin"/>
                    : needsAck
                      ? <AlertTriangle size={14}/>
                      : willMutate
                        ? <ShieldCheck size={14}/>
                        : <Play size={14}/>}
                {probing
                  ? t("Probing lock…")
                  : needsAck
                    ? t("Continue anyway")
                    : action.apply
                      ? (applied ? t("Apply") : t("Simulate (dry-run)"))
                      : t("Run")}
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
