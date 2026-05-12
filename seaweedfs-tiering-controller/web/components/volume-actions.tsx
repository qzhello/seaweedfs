"use client";

// Volume-row action surface. Each action maps to a single weed shell
// command from the catalog; this component renders the per-row kebab,
// the bulk toolbar that floats in when rows are selected, and the
// confirmation modal that collects extra inputs (target node, etc.)
// before issuing one shell call per affected volume.
//
// Bulk semantics are intentionally simple: each selected volume becomes
// its own shell call, serialised so the operator sees a per-volume
// status row. We don't try to batch into a single weed command because
// most volume commands take a single -volumeId; mixing volumes from
// different clusters or nodes also forces per-row calls anyway.

import { useState } from "react";
import {
  MoreVertical, Move, Copy, Trash2, Eraser, Lock, Unlock,
  ArrowUpToLine, ArrowDownToLine, ShieldAlert, AlertTriangle, Loader2, X, CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

// ----------------------------------------------------------------------------
// Action catalog
// ----------------------------------------------------------------------------

export interface VolumeRowLike {
  ID: number;
  Server: string;
  Collection?: string;
  cluster_id?: string;
  cluster_name?: string;
  ReadOnly?: boolean;
}

type FieldKind = "string" | "node";   // node = "host:port", validated lightly

interface ActionField {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  required?: boolean;
  help?: string;
}

interface VolumeAction {
  key: string;
  label: string;
  icon: typeof Move;
  risk: "mutate" | "destructive";
  command: string;           // weed shell name
  fields: ActionField[];     // operator inputs (besides volumeId + source)
  // buildArgs joins the volume id, current row, and operator inputs into
  // the args string weed shell expects. Returning null aborts the row
  // (used by mark-readonly/writable to honour the current state).
  buildArgs: (v: VolumeRowLike, input: Record<string, string>) => string | null;
  // When set, the row is auto-skipped if the predicate returns false (e.g.
  // "writable" only on read-only volumes).
  skipIf?: (v: VolumeRowLike) => boolean;
}

const ACTIONS: VolumeAction[] = [
  {
    key: "move", label: "Move", icon: Move, risk: "mutate", command: "volume.move",
    fields: [
      { key: "target", kind: "node", label: "Target node", placeholder: "host:port", required: true,
        help: "Destination volume server. Must be a different node." },
      { key: "disk", kind: "string", label: "Disk type (optional)", placeholder: "hdd / ssd" },
    ],
    buildArgs: (v, x) => {
      const parts = [`-volumeId=${v.ID}`, `-source=${v.Server}`, `-target=${x.target}`];
      if (x.disk) parts.push(`-disk=${x.disk}`);
      return parts.join(" ");
    },
  },
  {
    key: "copy", label: "Copy to node", icon: Copy, risk: "mutate", command: "volume.copy",
    fields: [
      { key: "target", kind: "node", label: "Target node", placeholder: "host:port", required: true,
        help: "Destination volume server. The source stays in place." },
    ],
    buildArgs: (v, x) => `-volumeId=${v.ID} -source=${v.Server} -target=${x.target}`,
  },
  {
    key: "delete", label: "Delete on this node", icon: Trash2, risk: "destructive", command: "volume.delete",
    fields: [],
    buildArgs: (v) => `-volumeId=${v.ID} -node=${v.Server}`,
  },
  {
    key: "mark-readonly", label: "Mark read-only", icon: Lock, risk: "mutate", command: "volume.mark",
    fields: [],
    skipIf: (v) => v.ReadOnly === true,
    buildArgs: (v) => `-volumeId=${v.ID} -readonly`,
  },
  {
    key: "mark-writable", label: "Mark writable", icon: Unlock, risk: "mutate", command: "volume.mark",
    fields: [],
    skipIf: (v) => v.ReadOnly !== true,
    buildArgs: (v) => `-volumeId=${v.ID} -writable`,
  },
  {
    key: "vacuum", label: "Vacuum (compact)", icon: Eraser, risk: "mutate", command: "volume.vacuum",
    fields: [
      { key: "garbageThreshold", kind: "string", label: "Garbage threshold", placeholder: "0.3",
        help: "Float 0..1. Lower = more aggressive." },
    ],
    buildArgs: (v, x) => {
      const parts = [`-volumeId=${v.ID}`];
      if (x.garbageThreshold) parts.push(`-garbageThreshold=${x.garbageThreshold}`);
      return parts.join(" ");
    },
  },
  {
    key: "tier-upload", label: "Tier upload", icon: ArrowUpToLine, risk: "mutate", command: "volume.tier.upload",
    fields: [
      { key: "dest", kind: "string", label: "Remote backend name", required: true,
        help: "Name configured under /backends, e.g. s3-cold-tier." },
      { key: "collection", kind: "string", label: "Collection (optional)" },
    ],
    buildArgs: (v, x) => {
      const parts = [`-dest=${x.dest}`];
      if (x.collection || v.Collection) parts.push(`-collection=${x.collection || v.Collection}`);
      return parts.join(" ");
    },
  },
  {
    key: "tier-download", label: "Tier download", icon: ArrowDownToLine, risk: "mutate", command: "volume.tier.download",
    fields: [
      { key: "collection", kind: "string", label: "Collection (optional)" },
    ],
    buildArgs: (v, x) => {
      const parts = [`-volumeId=${v.ID}`];
      if (x.collection || v.Collection) parts.push(`-collection=${x.collection || v.Collection}`);
      return parts.join(" ");
    },
  },
];

function actionByKey(k: string) { return ACTIONS.find((a) => a.key === k); }

// ----------------------------------------------------------------------------
// Row kebab
// ----------------------------------------------------------------------------

export function VolumeRowActions({ v, onPick }: {
  v: VolumeRowLike; onPick: (actionKey: string, rows: VolumeRowLike[]) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
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
          <button
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default" aria-hidden
          />
          <div className="absolute right-0 mt-1 z-40 w-52 rounded-md border border-border bg-panel shadow-lg py-1">
            {ACTIONS.map((a) => {
              if (a.skipIf && a.skipIf(v)) return null;
              const Icon = a.icon;
              const danger = a.risk === "destructive";
              return (
                <button
                  key={a.key}
                  onClick={() => { setOpen(false); onPick(a.key, [v]); }}
                  className={`w-full text-left px-3 py-1.5 text-xs inline-flex items-center gap-2 hover:bg-panel2 ${
                    danger ? "text-rose-300" : ""
                  }`}
                >
                  <Icon size={12}/> {t(a.label)}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Bulk toolbar (sticky at the top of the table when rows selected)
// ----------------------------------------------------------------------------

export function VolumeBulkBar({
  selected, onClear, onPick,
}: {
  selected: VolumeRowLike[];
  onClear: () => void;
  onPick: (actionKey: string, rows: VolumeRowLike[]) => void;
}) {
  const { t } = useT();
  if (selected.length === 0) return null;
  return (
    <div className="card px-3 py-2 flex items-center gap-2 flex-wrap bg-accent/10 border-accent/30">
      <span className="text-xs">
        <span className="text-accent font-medium">{selected.length}</span> {t("volume(s) selected")}
      </span>
      <div className="flex-1"/>
      {ACTIONS.map((a) => {
        const Icon = a.icon;
        const danger = a.risk === "destructive";
        return (
          <button
            key={a.key}
            onClick={() => onPick(a.key, selected)}
            className={`btn inline-flex items-center gap-1 text-xs ${danger ? "text-rose-300" : ""}`}
            title={t(a.label)}
          >
            <Icon size={12}/> {t(a.label)}
          </button>
        );
      })}
      <button onClick={onClear} className="p-1 text-muted hover:text-text" title={t("Clear selection")}>
        <X size={14}/>
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Confirmation + run modal
// ----------------------------------------------------------------------------

type RowStatus = { state: "pending" | "running" | "done" | "error"; message?: string };

export function VolumeActionDialog({
  actionKey, rows, onClose,
}: {
  actionKey: string;
  rows: VolumeRowLike[];
  onClose: (didRun: boolean) => void;
}) {
  const { t } = useT();
  const action = actionByKey(actionKey);
  const [input, setInput] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [statuses, setStatuses] = useState<RowStatus[]>(() => rows.map(() => ({ state: "pending" })));

  if (!action) return null;
  // Narrow `action` for the closure below — TS doesn't propagate the
  // early return into hoisted function declarations.
  const act: VolumeAction = action;

  // Volumes with no cluster_id (shouldn't happen but guard anyway) are
  // dropped early so we don't fire a request that's guaranteed to 400.
  const runnable = rows.filter((r) => !!r.cluster_id && !(action.skipIf && action.skipIf(r)));
  const skipped = rows.length - runnable.length;

  const danger = action.risk === "destructive";
  const fieldsOk = action.fields.every((f) => !f.required || (input[f.key] || "").trim().length > 0);
  const canRun = !running && !done && fieldsOk && runnable.length > 0;

  async function runAll() {
    setRunning(true);
    setStatuses(rows.map(() => ({ state: "pending" })));
    // Serial: keeps the UI readable and avoids hammering the shell
    // subprocess pool. weed shell volume.move on the same source node
    // also doesn't parallelise well in practice.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (act.skipIf && act.skipIf(r)) {
        setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "done", message: t("Skipped (no-op).") } : x)));
        continue;
      }
      if (!r.cluster_id) {
        setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "error", message: t("No cluster id on row.") } : x)));
        continue;
      }
      const args = act.buildArgs(r, input);
      if (args === null) {
        setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "done", message: t("Skipped (no-op).") } : x)));
        continue;
      }
      setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "running" } : x)));
      try {
        await api.runClusterShell(r.cluster_id, {
          command: act.command,
          args,
          reason,
        });
        setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "done" } : x)));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatuses((arr) => arr.map((x, j) => (j === i ? { state: "error", message: msg } : x)));
      }
    }
    setRunning(false);
    setDone(true);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
         onClick={() => !running && onClose(done)}>
      <div className="card p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium inline-flex items-center gap-2">
            {danger ? <ShieldAlert size={16} className="text-rose-300"/> : <AlertTriangle size={16} className="text-amber-300"/>}
            {t(action.label)} <span className="text-xs text-muted">· {runnable.length} {t("volume(s)")}</span>
          </h2>
          {!running && (
            <button onClick={() => onClose(done)} className="p-1 text-muted hover:text-text"><X size={16}/></button>
          )}
        </div>

        {danger && !done && (
          <div className="mb-3 text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-2">
            {t("This action is destructive and cannot be undone.")}
          </div>
        )}
        {skipped > 0 && !done && (
          <div className="mb-3 text-xs text-muted">
            {t("{n} volume(s) will be skipped (action does not apply).").replace("{n}", String(skipped))}
          </div>
        )}

        {!done && (
          <div className="space-y-3">
            {action.fields.map((f) => (
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

            <details className="text-xs">
              <summary className="cursor-pointer text-muted">{t("Affected volumes")}</summary>
              <ul className="mt-2 space-y-0.5 max-h-32 overflow-auto">
                {rows.map((r, i) => (
                  <li key={`${r.cluster_id}-${r.ID}-${i}`} className="font-mono text-muted">
                    #{r.ID} <span className="text-muted/60">on</span> {r.Server}
                    {r.cluster_name && <span className="text-muted/60"> · {r.cluster_name}</span>}
                    {action.skipIf && action.skipIf(r) && <span className="text-amber-300 ml-2">— {t("skip")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {done && (
          <div className="space-y-1 max-h-[60vh] overflow-auto">
            {rows.map((r, i) => {
              const s = statuses[i];
              const dot = s.state === "done" ? "text-emerald-300"
                : s.state === "error" ? "text-rose-300"
                : s.state === "running" ? "text-amber-300" : "text-muted";
              return (
                <div key={`${r.cluster_id}-${r.ID}-${i}`} className="flex items-start gap-2 text-xs font-mono py-1 border-b border-border/30 last:border-b-0">
                  <span className={`${dot} mt-0.5`}>
                    {s.state === "done" ? <CheckCircle2 size={12}/>
                      : s.state === "error" ? <X size={12}/>
                      : <span>•</span>}
                  </span>
                  <span className="flex-1">
                    #{r.ID} on {r.Server}
                    {s.message && <div className="text-muted text-[11px] whitespace-pre-wrap break-all">{s.message}</div>}
                  </span>
                  <span className={`text-[10px] ${dot}`}>{t(s.state)}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4">
          {!done ? (
            <>
              <button onClick={() => onClose(false)} className="btn" disabled={running}>{t("Cancel")}</button>
              <button
                onClick={runAll} disabled={!canRun}
                className={`btn inline-flex items-center gap-2 ${danger ? "bg-rose-500/80 text-white hover:bg-rose-500" : "bg-accent text-accent-fg"} disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {running ? <Loader2 size={14} className="animate-spin"/> : null}
                {t("Run on {n} volume(s)").replace("{n}", String(runnable.length))}
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
