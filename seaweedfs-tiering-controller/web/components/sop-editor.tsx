"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, XCircle, Loader2, FileCode2, Eye, Wand2, Plus, Search,
} from "lucide-react";
import { api } from "@/lib/api";
import { OP_CATALOG, explainOp } from "@/lib/op-catalog";

export interface SOPDraft {
  key: string;
  name: string;
  category: string;
  risk_level: "low" | "medium" | "high" | "critical";
  change_note: string;
  definition: string; // JSON text the operator edits
}

interface SOPEditorProps {
  initial: SOPDraft;
  isEdit: boolean;             // true when editing an existing key (key+name locked)
  onSave: (draft: SOPDraft) => Promise<void>;
}

const RISK_OPTIONS: SOPDraft["risk_level"][] = ["low", "medium", "high", "critical"];
const CATEGORIES = ["tiering", "ec", "topology", "maintenance", "recovery", "integrity", "general"];

const RISK_STYLES: Record<SOPDraft["risk_level"], string> = {
  low:      "bg-success/15 text-success border-success/30",
  medium:   "bg-warning/15 text-warning border-warning/30",
  high:     "bg-danger/15 text-danger border-danger/40",
  critical: "bg-danger/25 text-danger border-danger/60",
};

export function SOPEditor({ initial, isEdit, onSave }: SOPEditorProps) {
  const [draft, setDraft] = useState<SOPDraft>(initial);
  const [validateState, setValidateState] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [validateErr, setValidateErr] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string>("");
  const [showOps, setShowOps] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset local state when parent swaps the `initial` (e.g. fork-key change).
  useEffect(() => { setDraft(initial); }, [initial]);

  // Debounced live validation against POST /skills/validate.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setValidateState("checking");
    debounceRef.current = setTimeout(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.definition);
      } catch (e) {
        setValidateState("bad");
        setValidateErr(`JSON syntax: ${e instanceof Error ? e.message : "invalid"}`);
        return;
      }
      try {
        const res = await api.validateSkill(parsed);
        if (res?.ok) {
          setValidateState("ok");
          setValidateErr("");
        } else {
          setValidateState("bad");
          setValidateErr(res?.error ?? "schema validation failed");
        }
      } catch (e) {
        setValidateState("bad");
        setValidateErr(e instanceof Error ? e.message : "request failed");
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft.definition]);

  // Parsed definition — used by the live preview and step counter. We keep
  // it best-effort so the preview still works mid-typo (just shows what
  // last parsed).
  const parsed = useMemo<ParsedDef>(() => {
    try {
      return JSON.parse(draft.definition) as ParsedDef;
    } catch {
      return {} as ParsedDef;
    }
  }, [draft.definition]);

  const stepCount = parsed.steps?.length ?? 0;

  const canSave =
    validateState === "ok" &&
    draft.key.trim() !== "" &&
    draft.name.trim() !== "" &&
    !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveErr("");
    try {
      await onSave(draft);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  // Re-format definition (pretty-print) — common pasted-JSON cleanup.
  const formatJson = () => {
    try {
      const obj = JSON.parse(draft.definition);
      setDraft({ ...draft, definition: JSON.stringify(obj, null, 2) });
    } catch {
      // ignore — validate badge already shows the parse error.
    }
  };

  // Insert an op stub at the cursor in the textarea (step append helper).
  const insertOpStub = (op: string) => {
    const ta = textareaRef.current;
    const stub = JSON.stringify(
      { id: op.replace(/^[a-z_]+/, "").slice(0, 12) || op.slice(0, 12), op, args: {} },
      null, 2,
    );
    if (!ta) {
      // Append into the steps array if we can parse the doc.
      try {
        const obj = JSON.parse(draft.definition);
        obj.steps = obj.steps || [];
        obj.steps.push({ id: op.slice(0, 12), op, args: {} });
        setDraft({ ...draft, definition: JSON.stringify(obj, null, 2) });
      } catch { /* ignore */ }
      return;
    }
    const start = ta.selectionStart;
    const text = draft.definition;
    const next = text.slice(0, start) + stub + text.slice(start);
    setDraft({ ...draft, definition: next });
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + stub.length, start + stub.length);
    });
  };

  return (
    <div className="space-y-5">
      {/* Metadata strip — compact card with horizontal field layout */}
      <section className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <Field label="Key" hint="lowercase.dotted" span={4}>
            <input className="input font-mono"
              value={draft.key} disabled={isEdit} placeholder="e.g. custom.volume_balance"
              onChange={e => setDraft({ ...draft, key: e.target.value })}/>
          </Field>
          <Field label="Display name" span={5}>
            <input className="input"
              value={draft.name} placeholder="What operators see"
              onChange={e => setDraft({ ...draft, name: e.target.value })}/>
          </Field>
          <Field label="Category" span={3}>
            <select className="select" value={draft.category}
              onChange={e => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Risk level" span={4}>
            <div className="inline-flex rounded-md border border-border overflow-hidden w-full">
              {RISK_OPTIONS.map(r => (
                <button key={r} type="button"
                  onClick={() => setDraft({ ...draft, risk_level: r })}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium border-r border-border last:border-r-0 transition-colors ${
                    draft.risk_level === r ? RISK_STYLES[r] : "text-muted hover:bg-panel2 hover:text-text"
                  }`}>
                  {r}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Change note" hint="audit trail" span={8}>
            <input className="input"
              placeholder={isEdit ? "What changed? Why?" : "Initial version"}
              value={draft.change_note}
              onChange={e => setDraft({ ...draft, change_note: e.target.value })}/>
          </Field>
        </div>
      </section>

      {/* Two-column area: live structured preview | JSON editor */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Preview pane */}
        <div className="card lg:col-span-2 overflow-hidden">
          <header className="px-4 py-2.5 border-b border-border/60 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
              <Eye size={12}/> Live preview
            </h2>
            <span className="text-[11px] text-muted">{stepCount} step{stepCount === 1 ? "" : "s"}</span>
          </header>
          <DefPreview def={parsed}/>
        </div>

        {/* JSON editor */}
        <div className="card lg:col-span-3 overflow-hidden">
          <header className="px-4 py-2.5 border-b border-border/60 flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
              <FileCode2 size={12}/> Definition (JSON)
            </h2>
            <div className="flex items-center gap-3 text-xs">
              <ValidateBadge state={validateState}/>
              <button type="button" onClick={formatJson}
                className="text-muted hover:text-text inline-flex items-center gap-1"
                title="Reformat / pretty-print the JSON">
                <Wand2 size={12}/> format
              </button>
              <button type="button" onClick={() => setShowOps(s => !s)}
                className={`inline-flex items-center gap-1 ${showOps ? "text-accent" : "text-muted hover:text-text"}`}>
                <Plus size={12}/> insert op
              </button>
            </div>
          </header>
          {showOps && (
            <OpPicker onPick={op => { insertOpStub(op); setShowOps(false); }}/>
          )}
          <textarea ref={textareaRef}
            className="w-full h-[480px] font-mono text-xs bg-bg p-3 resize-y outline-none border-0
                       focus:ring-2 focus:ring-accent/30"
            spellCheck={false}
            value={draft.definition}
            onChange={e => setDraft({ ...draft, definition: e.target.value })}/>
          {validateState === "bad" && validateErr && (
            <div className="px-4 py-2 border-t border-danger/30 bg-danger/5 text-xs text-danger flex items-start gap-1">
              <XCircle size={14} className="mt-0.5 shrink-0"/>
              <span className="font-mono break-all">{validateErr}</span>
            </div>
          )}
        </div>
      </section>

      <TemplatePicker onPick={tpl => setDraft({ ...draft, definition: tpl })}/>

      {/* Footer action bar */}
      <section className="card p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted">
          {isEdit
            ? "Saving creates a new version. The latest version is what runs."
            : "Custom skills can't reuse a key owned by a system skill."}
        </div>
        <div className="flex items-center gap-3">
          {saveErr && <span className="text-xs text-danger max-w-md truncate" title={saveErr}>{saveErr}</span>}
          <button className="btn btn-primary" disabled={!canSave} onClick={submit}>
            {saving ? <Loader2 size={14} className="animate-spin"/> : null}
            {isEdit ? "Save new version" : "Create skill"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---- Live preview --------------------------------------------------------

interface ParsedStep { id?: string; op: string; on_failure?: string; timeout_seconds?: number }
interface ParsedCheck { check: string; fatal?: boolean; doc?: string }
interface ParsedParam { name: string; type: string; required?: boolean; default?: unknown }
interface ParsedDef {
  summary?: string;
  description?: string;
  params?: ParsedParam[];
  preconditions?: ParsedCheck[];
  steps?: ParsedStep[];
  rollback?: ParsedStep[];
  postchecks?: ParsedCheck[];
}

function DefPreview({ def }: { def: ParsedDef }) {
  const empty = !def.summary && !def.steps?.length && !def.params?.length && !def.preconditions?.length;
  if (empty) {
    return (
      <div className="px-4 py-10 text-center text-xs text-muted">
        The structured view will fill in as you edit the JSON.
      </div>
    );
  }
  return (
    <div className="p-4 space-y-3 text-sm">
      {def.summary && (
        <p className="text-text">{def.summary}</p>
      )}
      {def.description && (
        <p className="text-xs text-muted whitespace-pre-line">{def.description}</p>
      )}

      {(def.params?.length ?? 0) > 0 && (
        <PreviewSection title="Params" count={def.params!.length}>
          {def.params!.map(p => (
            <div key={p.name} className="flex items-center gap-2 text-xs py-0.5">
              <span className="font-mono text-text">{p.name}</span>
              <span className="text-muted">{p.type}</span>
              {p.required && <span className="text-danger">*</span>}
              {p.default !== undefined && <span className="text-muted">= {JSON.stringify(p.default)}</span>}
            </div>
          ))}
        </PreviewSection>
      )}

      {(def.preconditions?.length ?? 0) > 0 && (
        <PreviewSection title="Preconditions" count={def.preconditions!.length}>
          {def.preconditions!.map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-xs py-0.5">
              <span className="font-mono">{c.check}</span>
              {c.fatal && <span className="badge border-danger/40 text-danger text-[10px]">fatal</span>}
            </div>
          ))}
        </PreviewSection>
      )}

      {(def.steps?.length ?? 0) > 0 && (
        <PreviewSection title="Steps" count={def.steps!.length}>
          {def.steps!.map((s, i) => {
            const ex = explainOp(s.op);
            return (
              <div key={i} className="flex items-start gap-2 text-xs py-1">
                <span className="font-mono text-muted w-5 text-right shrink-0">{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono text-accent">{s.op}</span>
                    {s.on_failure && <span className="text-[10px] text-muted">on_failure={s.on_failure}</span>}
                  </div>
                  <div className="text-[11px] text-muted truncate" title={ex.description}>{ex.title}</div>
                </div>
              </div>
            );
          })}
        </PreviewSection>
      )}

      {(def.rollback?.length ?? 0) > 0 && (
        <PreviewSection title="Rollback" count={def.rollback!.length}>
          {def.rollback!.map((s, i) => (
            <div key={i} className="text-xs py-0.5">
              <span className="font-mono text-warning">{s.op}</span>
            </div>
          ))}
        </PreviewSection>
      )}

      {(def.postchecks?.length ?? 0) > 0 && (
        <PreviewSection title="Postchecks" count={def.postchecks!.length}>
          {def.postchecks!.map((c, i) => (
            <div key={i} className="text-xs py-0.5">
              <span className="font-mono">{c.check}</span>
              {c.fatal && <span className="badge border-danger/40 text-danger text-[10px] ml-2">fatal</span>}
            </div>
          ))}
        </PreviewSection>
      )}
    </div>
  );
}

function PreviewSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted/70 mb-1">
        {title} <span className="text-muted">· {count}</span>
      </div>
      <div className="pl-1 border-l border-border space-y-0.5 pl-3">
        {children}
      </div>
    </div>
  );
}

// ---- Op picker -----------------------------------------------------------

function OpPicker({ onPick }: { onPick: (op: string) => void }) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const all = Object.entries(OP_CATALOG);
    if (!q) return all.slice(0, 50);
    const ql = q.toLowerCase();
    return all.filter(([op, meta]) =>
      op.toLowerCase().includes(ql) ||
      meta.title?.toLowerCase().includes(ql) ||
      meta.description?.toLowerCase().includes(ql),
    ).slice(0, 50);
  }, [q]);
  return (
    <div className="border-b border-border/60 bg-panel2/40 px-4 py-3 space-y-2">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
        <input
          autoFocus
          className="input w-full pl-7 py-1 text-xs"
          placeholder="Search ops (e.g. tier, lock, audit)…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto -mx-2">
        {matches.length === 0 ? (
          <div className="text-xs text-muted text-center py-4">No matching ops.</div>
        ) : matches.map(([op, meta]) => (
          <button key={op} type="button" onClick={() => onPick(op)}
            className="w-full text-left px-3 py-1.5 hover:bg-panel2 rounded-md transition-colors">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-accent">{op}</span>
              {meta.external && <span className="badge text-[10px]">external</span>}
            </div>
            <div className="text-[11px] text-muted truncate">{meta.title}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Existing helpers ----------------------------------------------------

function Field({ label, hint, span, children }: {
  label: string; hint?: string; span?: number; children: React.ReactNode;
}) {
  const colClass = span ? `md:col-span-${span}` : "";
  return (
    <label className={`block ${colClass}`}>
      <div className="text-[11px] font-medium text-muted mb-1">
        {label}{hint && <span className="ml-2 text-muted/60 font-normal">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function ValidateBadge({ state }: { state: "idle" | "checking" | "ok" | "bad" }) {
  if (state === "checking") {
    return <span className="flex items-center gap-1 text-muted"><Loader2 size={12} className="animate-spin"/>checking</span>;
  }
  if (state === "ok") {
    return <span className="flex items-center gap-1 text-success"><CheckCircle2 size={12}/>schema ok</span>;
  }
  if (state === "bad") {
    return <span className="flex items-center gap-1 text-danger"><XCircle size={12}/>invalid</span>;
  }
  return null;
}

// ---- Templates -----------------------------------------------------------

const TEMPLATES: { name: string; doc: string; body: object }[] = [
  {
    name: "Maintenance (low risk)",
    doc: "Non-destructive maintenance: lock → execute → audit.",
    body: {
      summary: "Describe what this skill does in one line.",
      params: [
        { name: "cluster_id", type: "string", required: true },
        { name: "volume_id",  type: "int",    required: true, min: 1 },
      ],
      preconditions: [
        { check: "cluster_healthy" },
      ],
      steps: [
        { id: "lock",  op: "acquire_volume_lock", timeout_seconds: 30 },
        { id: "work",  op: "shell_volume_vacuum", timeout_seconds: 3600, on_failure: "abort" },
        { id: "audit", op: "audit_log",           args: { action: "custom_maintenance" } },
      ],
      postchecks: [],
    },
  },
  {
    name: "Tiering (medium risk)",
    doc: "Volume migration: precondition + lock + upload + verify + rollback.",
    body: {
      summary: "Move volume to a remote tier with rollback.",
      params: [
        { name: "cluster_id", type: "string", required: true },
        { name: "volume_id",  type: "int",    required: true, min: 1 },
        { name: "backend_id", type: "string", required: true },
      ],
      preconditions: [
        { check: "volume_is_readonly", fatal: true },
        { check: "backend_reachable",  fatal: true },
        { check: "in_change_window_or_emergency", fatal: true },
      ],
      steps: [
        { id: "lock",   op: "acquire_volume_lock", timeout_seconds: 30 },
        { id: "upload", op: "tier_move_dat_to_remote", timeout_seconds: 14400,
          retry: { max_attempts: 2, backoff_seconds: 30 }, on_failure: "rollback" },
        { id: "verify", op: "verify_remote_tier" },
        { id: "audit",  op: "audit_log", args: { action: "custom_tiering" } },
      ],
      postchecks: [
        { check: "volume_serves_reads" },
      ],
      rollback: [
        { op: "tier_move_dat_from_remote" },
      ],
    },
  },
  {
    name: "Audit-only (read)",
    doc: "Read-only audit that emits a report and may fire alerts.",
    body: {
      summary: "Read-only audit that emits a report.",
      params: [
        { name: "cluster_id", type: "string", required: true },
      ],
      preconditions: [
        { check: "cluster_reachable", fatal: true },
      ],
      steps: [
        { id: "scan",   op: "compute_failover_matrix", timeout_seconds: 600 },
        { id: "report", op: "emit_failover_report" },
        { id: "alert",  op: "alert_if_at_risk", args: { min_severity: "warning" }, on_failure: "continue" },
        { id: "audit",  op: "audit_log", args: { action: "custom_audit" } },
      ],
      postchecks: [],
    },
  },
];

function TemplatePicker({ onPick }: { onPick: (json: string) => void }) {
  return (
    <section className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-muted mb-3">Starter templates</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {TEMPLATES.map(t => (
          <button key={t.name} type="button"
            onClick={() => onPick(JSON.stringify(t.body, null, 2))}
            className="text-left p-3 rounded-md border border-border hover:border-accent/40 hover:bg-panel2 transition-colors">
            <div className="font-medium text-sm mb-1">{t.name}</div>
            <div className="text-[11px] text-muted">{t.doc}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
