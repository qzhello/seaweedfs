"use client";
// Guided wizard for authoring SOPs (Skills). Walks the operator through five
// validated steps — Identity, Inputs, Execute, Safety, Review — so they
// never have to remember the JSON schema. The wizard mutates the same
// `definition` JSON the JSON / Paste modes operate on, so users can flip
// between modes without losing work.

import { useEffect, useMemo, useState } from "react";
import {
  Check, ChevronLeft, ChevronRight, Plus, Trash2, Sparkles, Loader2, XCircle, AlertCircle,
  CheckCircle2, FileCode2, GitBranch, ShieldCheck, ListChecks, BookOpen,
} from "lucide-react";
import { api } from "@/lib/api";
import { OP_CATALOG, explainOp } from "@/lib/op-catalog";

// ---- Shared draft types --------------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SkillParam {
  name: string;
  type: "string" | "int" | "bool" | "float";
  required?: boolean;
  default?: string | number | boolean | null;
  doc?: string;
}
export interface SkillCheck { check: string; fatal?: boolean; doc?: string }
export interface SkillStep {
  id?: string;
  op: string;
  timeout_seconds?: number;
  on_failure?: "abort" | "continue" | "rollback";
  retry?: { max_attempts: number; backoff_seconds: number };
  args?: Record<string, unknown>;
}
export interface SkillDefinition {
  summary?: string;
  description?: string;
  params?: SkillParam[];
  preconditions?: SkillCheck[];
  steps?: SkillStep[];
  rollback?: SkillStep[];
  postchecks?: SkillCheck[];
}
export interface SkillMeta {
  key: string;
  name: string;
  category: string;
  risk_level: RiskLevel;
  change_note: string;
}

export interface WizardDraft {
  meta: SkillMeta;
  definition: SkillDefinition;
}

// Round-trip with the SOPEditor (which works on a string blob).
export function draftToString(d: WizardDraft): string {
  return JSON.stringify(d.definition, null, 2);
}
export function tryParseDraft(meta: SkillMeta, defJson: string): WizardDraft {
  try {
    return { meta, definition: JSON.parse(defJson) as SkillDefinition };
  } catch {
    return { meta, definition: {} };
  }
}

// ---- Constants -----------------------------------------------------------

const CATEGORIES = ["tiering", "ec", "topology", "maintenance", "recovery", "integrity", "general"];
const RISK_OPTIONS: RiskLevel[] = ["low", "medium", "high", "critical"];
const RISK_STYLES: Record<RiskLevel, string> = {
  low:      "bg-success/15 text-success border-success/30",
  medium:   "bg-warning/15 text-warning border-warning/30",
  high:     "bg-danger/15 text-danger border-danger/40",
  critical: "bg-danger/25 text-danger border-danger/60",
};
const RISK_HINTS: Record<RiskLevel, string> = {
  low:      "Read-only / audit-only. Safe to auto-approve.",
  medium:   "Mutates state but bounded (one volume, idempotent). Needs review on touchy clusters.",
  high:     "Destructive or affects multiple volumes. Always needs human sign-off.",
  critical: "Cluster-wide impact (e.g. failover, mass delete). Two reviewers + change window.",
};

// Curated known checks. Operators can still type any string; this list just
// powers an autocomplete and prevents typos on the common ones.
const COMMON_CHECKS = [
  "cluster_healthy", "cluster_reachable", "volume_is_readonly", "volume_serves_reads",
  "backend_reachable", "replicas_present", "in_change_window_or_emergency",
  "cluster_admin_lock_acquirable", "no_active_repair", "free_disk_above_threshold",
];

const ON_FAILURE: SkillStep["on_failure"][] = ["abort", "continue", "rollback"];

// ---- Step registry -------------------------------------------------------

const STEPS = [
  { id: "identity", label: "Identity",  icon: BookOpen },
  { id: "inputs",   label: "Inputs",    icon: GitBranch },
  { id: "execute",  label: "Execute",   icon: ListChecks },
  { id: "safety",   label: "Safety",    icon: ShieldCheck },
  { id: "review",   label: "Review",    icon: CheckCircle2 },
] as const;
type StepID = typeof STEPS[number]["id"];

// ---- Main component ------------------------------------------------------

interface SkillWizardProps {
  initial: WizardDraft;
  isEdit: boolean;
  onSave: (draft: WizardDraft) => Promise<void>;
  // Optional escape hatch — Wizard renders a link in each step's header to
  // jump to raw-JSON mode if the operator prefers.
  onSwitchToJSON?: () => void;
}

export function SkillWizard({ initial, isEdit, onSave, onSwitchToJSON }: SkillWizardProps) {
  const [draft, setDraft] = useState<WizardDraft>(initial);
  const [active, setActive] = useState<StepID>("identity");
  const [validateState, setValidateState] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [validateErr, setValidateErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  // Reset when parent swaps initial (e.g. fork / import).
  useEffect(() => { setDraft(initial); }, [initial]);

  // Debounced schema check against /skills/validate. Same as SOPEditor but
  // runs from the wizard's structured definition (always valid JSON).
  useEffect(() => {
    setValidateState("checking");
    const t = setTimeout(async () => {
      try {
        const res = await api.validateSkill(draft.definition);
        if (res?.ok) { setValidateState("ok"); setValidateErr(""); }
        else { setValidateState("bad"); setValidateErr(res?.error ?? "schema validation failed"); }
      } catch (e) {
        setValidateState("bad");
        setValidateErr(e instanceof Error ? e.message : "request failed");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [draft.definition]);

  const stepIndex = STEPS.findIndex(s => s.id === active);
  const isFirst = stepIndex === 0;
  const isLast  = stepIndex === STEPS.length - 1;
  const goPrev = () => !isFirst && setActive(STEPS[stepIndex - 1].id);
  const goNext = () => !isLast  && setActive(STEPS[stepIndex + 1].id);

  // Per-step completion heuristic for the rail indicators. Best-effort; the
  // schema validator is the source of truth for "can save".
  const completed = useMemo(() => ({
    identity: !!(draft.meta.key && draft.meta.name && draft.definition.summary),
    inputs:   true,                                                                  // optional
    execute:  (draft.definition.steps?.length ?? 0) > 0,
    safety:   true,                                                                  // optional
    review:   validateState === "ok",
  }), [draft, validateState]);

  const canSave = validateState === "ok" && !!draft.meta.key && !!draft.meta.name && !saving;
  const submit = async () => {
    if (!canSave) return;
    setSaving(true); setSaveErr("");
    try { await onSave(draft); }
    catch (e) { setSaveErr(e instanceof Error ? e.message : "save failed"); }
    finally { setSaving(false); }
  };

  const update = (m: Partial<SkillMeta>) => setDraft(d => ({ ...d, meta: { ...d.meta, ...m } }));
  const updateDef = (fn: (def: SkillDefinition) => SkillDefinition) =>
    setDraft(d => ({ ...d, definition: fn(d.definition) }));

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] min-h-[560px]">
        {/* ----- Step rail ----- */}
        <aside className="border-b md:border-b-0 md:border-r border-border/60 bg-panel2/30 p-3 md:p-4">
          <ol className="space-y-1">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const isActive = s.id === active;
              const isDone = completed[s.id] && !isActive;
              return (
                <li key={s.id}>
                  <button onClick={() => setActive(s.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-left ${
                      isActive
                        ? "bg-accent/15 text-accent"
                        : isDone
                          ? "text-text hover:bg-panel2"
                          : "text-muted hover:bg-panel2 hover:text-text"
                    }`}>
                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-mono shrink-0 ${
                      isActive ? "border-accent text-accent"
                        : isDone ? "border-success/60 bg-success/15 text-success"
                        : "border-border text-muted"
                    }`}>
                      {isDone ? <Check size={10}/> : i + 1}
                    </span>
                    <Icon size={14} className="shrink-0"/>
                    <span>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Schema status pinned bottom of rail */}
          <div className="mt-6 pt-4 border-t border-border/60">
            <div className="text-[10px] uppercase tracking-wider text-muted/70 mb-2">Schema</div>
            <ValidateBadge state={validateState}/>
            {validateState === "bad" && validateErr && (
              <div className="mt-1 text-[11px] text-danger break-words font-mono">{validateErr}</div>
            )}
          </div>
        </aside>

        {/* ----- Active pane ----- */}
        <main className="flex flex-col">
          <header className="px-6 py-4 border-b border-border/60 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted/70">
                Step {stepIndex + 1} of {STEPS.length}
              </div>
              <h2 className="text-lg font-semibold mt-0.5">{STEP_TITLES[active]}</h2>
              <p className="text-xs text-muted mt-1 max-w-2xl">{STEP_SUBTITLES[active]}</p>
            </div>
            {onSwitchToJSON && active !== "review" && (
              <button onClick={onSwitchToJSON}
                className="text-xs text-muted hover:text-accent inline-flex items-center gap-1 shrink-0"
                title="Edit the raw JSON instead of using the wizard">
                <FileCode2 size={12}/> Skip to raw JSON
              </button>
            )}
          </header>

          <div className="flex-1 p-6 overflow-y-auto">
            {active === "identity" && <StepIdentity draft={draft} update={update} updateDef={updateDef} isEdit={isEdit}/>}
            {active === "inputs"   && <StepInputs   draft={draft} updateDef={updateDef}/>}
            {active === "execute"  && <StepExecute  draft={draft} updateDef={updateDef}/>}
            {active === "safety"   && <StepSafety   draft={draft} updateDef={updateDef}/>}
            {active === "review"   && <StepReview   draft={draft} update={update} validateState={validateState}/>}
          </div>

          <footer className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-3 bg-panel2/20">
            <button onClick={goPrev} disabled={isFirst}
              className="btn btn-ghost text-sm">
              <ChevronLeft size={14}/> Previous
            </button>
            <div className="flex items-center gap-3">
              {saveErr && <span className="text-xs text-danger max-w-md truncate" title={saveErr}>{saveErr}</span>}
              {isLast ? (
                <button onClick={submit} disabled={!canSave} className="btn btn-primary">
                  {saving ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
                  {isEdit ? "Save new version" : "Create skill"}
                </button>
              ) : (
                <button onClick={goNext} className="btn btn-primary">
                  Next <ChevronRight size={14}/>
                </button>
              )}
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

const STEP_TITLES: Record<StepID, string> = {
  identity: "What is this Skill?",
  inputs:   "What does the caller pass in?",
  execute:  "What does the Skill do?",
  safety:   "What protects the cluster?",
  review:   "Review & save",
};
const STEP_SUBTITLES: Record<StepID, string> = {
  identity: "Give the Skill a stable identifier, a one-line purpose, and the right category and risk so it gets the right review path.",
  inputs:   "Parameters are validated before any side effect runs. Most volume-level skills only need cluster_id and volume_id.",
  execute:  "Each step calls a registered op. Order matters. The engine acquires locks, writes a log line, retries on transient failures, and rolls back on configured failures.",
  safety:   "Preconditions abort before side effects. Rollback runs after a failed destructive step. Postchecks confirm the change actually stuck.",
  review:   "Cross-check the structured preview against the JSON. Add a change note and save — every save creates a new immutable version.",
};

// ============================================================
// Step 1 — Identity
// ============================================================

function StepIdentity({
  draft, update, updateDef, isEdit,
}: {
  draft: WizardDraft;
  update: (m: Partial<SkillMeta>) => void;
  updateDef: (fn: (def: SkillDefinition) => SkillDefinition) => void;
  isEdit: boolean;
}) {
  const { meta, definition } = draft;
  return (
    <div className="space-y-5 max-w-3xl">
      <Guidance>
        <p>A Skill is a versioned, schema-validated procedure run by the controller.</p>
        <ul className="list-disc pl-5 space-y-0.5 mt-1">
          <li>Pick a stable <b className="text-text">key</b> — lowercase dotted. Prefix custom skills with <code>custom.</code>.</li>
          <li>The <b className="text-text">summary</b> is the one line that shows up in audit logs and task tooltips.</li>
          <li><b className="text-text">Risk level</b> drives which review path it takes — see right column.</li>
        </ul>
      </Guidance>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Key" hint="lowercase.dotted">
          <input className="input font-mono" disabled={isEdit}
            placeholder="custom.shrink_volume"
            value={meta.key} onChange={e => update({ key: e.target.value })}/>
        </Field>
        <Field label="Display name" hint="what operators see">
          <input className="input"
            placeholder="Shrink large volumes"
            value={meta.name} onChange={e => update({ name: e.target.value })}/>
        </Field>
      </div>

      <Field label="Summary" hint="ONE sentence — appears in audit logs and tooltips">
        <input className="input"
          placeholder="Shrink a read-only volume's slot footprint without data loss."
          value={definition.summary ?? ""}
          onChange={e => updateDef(d => ({ ...d, summary: e.target.value }))}/>
      </Field>

      <Field label="Description" hint="optional · 2–4 sentences · plain markdown">
        <textarea className="textarea h-28"
          placeholder="When and why to run this. Any operator caveats. Citations to runbooks if relevant."
          value={definition.description ?? ""}
          onChange={e => updateDef(d => ({ ...d, description: e.target.value }))}/>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Category">
          <select className="select" value={meta.category} onChange={e => update({ category: e.target.value })}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Risk level">
          <div className="inline-flex rounded-md border border-border overflow-hidden w-full">
            {RISK_OPTIONS.map(r => (
              <button key={r} type="button" onClick={() => update({ risk_level: r })}
                className={`flex-1 px-3 py-1.5 text-xs font-medium border-r border-border last:border-r-0 transition-colors ${
                  meta.risk_level === r ? RISK_STYLES[r] : "text-muted hover:bg-panel2 hover:text-text"
                }`}>
                {r}
              </button>
            ))}
          </div>
          <p className="field-helper">{RISK_HINTS[meta.risk_level]}</p>
        </Field>
      </div>
    </div>
  );
}

// ============================================================
// Step 2 — Inputs (params)
// ============================================================

function StepInputs({
  draft, updateDef,
}: {
  draft: WizardDraft;
  updateDef: (fn: (def: SkillDefinition) => SkillDefinition) => void;
}) {
  const params = draft.definition.params ?? [];
  const setParams = (next: SkillParam[]) => updateDef(d => ({ ...d, params: next }));
  const addParam = (p: SkillParam) => setParams([...params, p]);
  const updateParam = (i: number, patch: Partial<SkillParam>) =>
    setParams(params.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  const removeParam = (i: number) => setParams(params.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-5 max-w-4xl">
      <Guidance>
        <p>Parameters are validated <b className="text-text">before any side effect runs</b>. Bad input fails fast with no rollback needed.</p>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          <li>Most volume-level skills only need <code>cluster_id</code> and <code>volume_id</code>.</li>
          <li>Use <code>required: true</code> for anything without a sensible default.</li>
          <li>Don't put secrets here — wire those through the backend cred store.</li>
        </ul>
      </Guidance>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted">Quick-add:</span>
        {[
          { name: "cluster_id", type: "string" as const, required: true,  doc: "Target cluster UUID." },
          { name: "volume_id",  type: "int"    as const, required: true,  doc: "Target volume id." },
          { name: "backend_id", type: "string" as const, required: true,  doc: "Destination backend." },
          { name: "force",      type: "bool"   as const, required: false, default: false, doc: "Skip non-fatal preconditions." },
        ].map(p => {
          const exists = params.some(x => x.name === p.name);
          return (
            <button key={p.name} type="button" disabled={exists}
              onClick={() => addParam(p)}
              className="badge text-xs hover:border-accent/40 hover:text-accent disabled:opacity-50">
              <Plus size={10}/> {p.name}
            </button>
          );
        })}
      </div>

      {params.length === 0 ? (
        <EmptyRow icon={GitBranch} hint="No params yet. Skills that don't take input are valid — but most do. Use Quick-add or the New button."/>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_120px_90px_140px_1fr_36px] gap-2 text-[11px] uppercase tracking-wider text-muted/70 px-1">
            <span>Name</span><span>Type</span><span>Required</span><span>Default</span><span>Doc</span><span/>
          </div>
          {params.map((p, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_90px_140px_1fr_36px] gap-2 items-center">
              <input className="input font-mono" placeholder="volume_id"
                value={p.name} onChange={e => updateParam(i, { name: e.target.value })}/>
              <select className="select"
                value={p.type} onChange={e => updateParam(i, { type: e.target.value as SkillParam["type"] })}>
                {(["string", "int", "bool", "float"] as const).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={!!p.required}
                  onChange={e => updateParam(i, { required: e.target.checked })}/>
                <span>required</span>
              </label>
              <input className="input font-mono text-xs" placeholder="(none)"
                value={p.default == null ? "" : String(p.default)}
                onChange={e => updateParam(i, { default: e.target.value === "" ? null : e.target.value })}/>
              <input className="input text-xs" placeholder="What this param means"
                value={p.doc ?? ""} onChange={e => updateParam(i, { doc: e.target.value })}/>
              <button type="button" aria-label="Remove param" onClick={() => removeParam(i)}
                className="btn btn-ghost p-1.5 text-muted hover:text-danger"><Trash2 size={14}/></button>
            </div>
          ))}
        </div>
      )}

      <button type="button"
        onClick={() => addParam({ name: "", type: "string", required: false })}
        className="btn btn-ghost text-xs"><Plus size={12}/> New param</button>
    </div>
  );
}

// ============================================================
// Step 3 — Execute (steps)
// ============================================================

function StepExecute({
  draft, updateDef,
}: {
  draft: WizardDraft;
  updateDef: (fn: (def: SkillDefinition) => SkillDefinition) => void;
}) {
  const steps = draft.definition.steps ?? [];
  const setSteps = (next: SkillStep[]) => updateDef(d => ({ ...d, steps: next }));
  const addStep    = (s: SkillStep) => setSteps([...steps, s]);
  const updateStep = (i: number, patch: Partial<SkillStep>) =>
    setSteps(steps.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  const removeStep = (i: number) => setSteps(steps.filter((_, idx) => idx !== i));
  const moveStep   = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };

  const hasAudit = steps.some(s => s.op === "audit_log");

  return (
    <div className="space-y-5">
      <Guidance>
        <p>Each step calls a registered op. Order matters. The engine writes a log line for every step, acquires locks where required, and retries transient failures.</p>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          <li>Start with locks (<code>acquire_*_lock</code>) to prevent concurrent runs on the same target.</li>
          <li>Use <code>on_failure: rollback</code> on the destructive step so the rollback block runs.</li>
          <li>Always end with <code>audit_log</code> so the action shows up in the audit trail.</li>
        </ul>
      </Guidance>

      {!hasAudit && steps.length > 0 && (
        <Note tone="warning">
          The last step is not <code>audit_log</code>. Add an audit step or operators won't be able to see this Skill ran.
        </Note>
      )}

      {steps.length === 0 ? (
        <EmptyRow icon={ListChecks}
          hint="No steps yet. Pick an op below to add your first step. Most skills end with audit_log."/>
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <StepRow key={i} idx={i} step={s} total={steps.length}
              onChange={patch => updateStep(i, patch)}
              onRemove={() => removeStep(i)}
              onMove={dir => moveStep(i, dir)}/>
          ))}
        </ol>
      )}

      <OpPicker onPick={op => addStep({ id: shortId(op), op, on_failure: "abort" })}/>

      {steps.length > 0 && !hasAudit && (
        <button type="button"
          onClick={() => addStep({ id: "audit", op: "audit_log", args: { action: "custom" } })}
          className="btn text-xs"><Plus size={12}/> Append audit_log</button>
      )}
    </div>
  );
}

function shortId(op: string): string {
  const m = op.match(/[a-z]+(?:_[a-z]+)?$/);
  return (m ? m[0] : op).slice(0, 12);
}

function StepRow({
  idx, step, total, onChange, onRemove, onMove,
}: {
  idx: number; step: SkillStep; total: number;
  onChange: (patch: Partial<SkillStep>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const ex = explainOp(step.op);
  const [argsText, setArgsText] = useState(() => step.args ? JSON.stringify(step.args, null, 2) : "");
  const [argsErr, setArgsErr]   = useState("");

  useEffect(() => {
    setArgsText(step.args ? JSON.stringify(step.args, null, 2) : "");
  }, [step.args]);

  const commitArgs = (t: string) => {
    setArgsText(t);
    if (!t.trim()) {
      setArgsErr("");
      onChange({ args: undefined });
      return;
    }
    try {
      const v = JSON.parse(t);
      if (typeof v !== "object" || Array.isArray(v) || v == null) {
        setArgsErr("args must be a JSON object");
        return;
      }
      setArgsErr("");
      onChange({ args: v as Record<string, unknown> });
    } catch (e) {
      setArgsErr(e instanceof Error ? e.message : "invalid JSON");
    }
  };

  return (
    <li className="rounded-md border border-border bg-panel2/30 p-3 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-0.5 mt-1">
          <button type="button" onClick={() => onMove(-1)} disabled={idx === 0}
            className="text-muted hover:text-text disabled:opacity-30" aria-label="Move up">
            <ChevronLeft size={12} className="rotate-90"/>
          </button>
          <span className="text-[10px] font-mono text-muted">{idx + 1}</span>
          <button type="button" onClick={() => onMove(1)} disabled={idx === total - 1}
            className="text-muted hover:text-text disabled:opacity-30" aria-label="Move down">
            <ChevronRight size={12} className="rotate-90"/>
          </button>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="grid grid-cols-[120px_1fr_120px_140px_36px] gap-2 items-center">
            <input className="input font-mono text-xs" placeholder="id"
              value={step.id ?? ""} onChange={e => onChange({ id: e.target.value })}/>
            <input className="input font-mono text-xs" placeholder="op"
              value={step.op} onChange={e => onChange({ op: e.target.value })}/>
            <select className="select text-xs"
              value={step.on_failure ?? "abort"}
              onChange={e => onChange({ on_failure: e.target.value as SkillStep["on_failure"] })}>
              {ON_FAILURE.map(v => <option key={v} value={v}>on_failure={v}</option>)}
            </select>
            <input className="input font-mono text-xs" placeholder="timeout (s)"
              type="number"
              value={step.timeout_seconds ?? ""}
              onChange={e => onChange({ timeout_seconds: e.target.value ? Number(e.target.value) : undefined })}/>
            <button type="button" aria-label="Remove step" onClick={onRemove}
              className="btn btn-ghost p-1.5 text-muted hover:text-danger"><Trash2 size={14}/></button>
          </div>
          <div className="text-xs text-muted truncate" title={ex.description}>
            <span className="text-accent">{ex.title}</span>
            {step.op !== ex.title && <span className="ml-2 text-muted/70">/ {ex.command}</span>}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted hover:text-text inline-flex items-center gap-1">
              <FileCode2 size={11}/> args (JSON object)
            </summary>
            <textarea className="textarea h-20 mt-1.5 text-[11px]"
              placeholder='{"action": "shrink"}'
              value={argsText}
              onChange={e => commitArgs(e.target.value)}/>
            {argsErr && <div className="text-[11px] text-danger mt-0.5">{argsErr}</div>}
          </details>
        </div>
      </div>
    </li>
  );
}

function OpPicker({ onPick }: { onPick: (op: string) => void }) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const all = Object.entries(OP_CATALOG);
    if (!q) return all.slice(0, 30);
    const ql = q.toLowerCase();
    return all.filter(([op, meta]) =>
      op.toLowerCase().includes(ql) || meta.title?.toLowerCase().includes(ql),
    ).slice(0, 30);
  }, [q]);
  return (
    <div className="rounded-md border border-border bg-panel2/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Add a step from the op catalog</h3>
        <input className="input w-64 py-1 text-xs" placeholder="search: tier, lock, audit…"
          value={q} onChange={e => setQ(e.target.value)}/>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-1 max-h-56 overflow-y-auto">
        {matches.map(([op, meta]) => (
          <button key={op} type="button" onClick={() => onPick(op)}
            className="text-left px-2.5 py-1.5 rounded-md hover:bg-panel2 transition-colors">
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

// ============================================================
// Step 4 — Safety (preconditions + rollback + postchecks)
// ============================================================

function StepSafety({
  draft, updateDef,
}: {
  draft: WizardDraft;
  updateDef: (fn: (def: SkillDefinition) => SkillDefinition) => void;
}) {
  const pre   = draft.definition.preconditions ?? [];
  const post  = draft.definition.postchecks    ?? [];
  const roll  = draft.definition.rollback      ?? [];
  const needsRollback = (draft.definition.steps ?? []).some(s => s.on_failure === "rollback");

  return (
    <div className="space-y-6">
      <Guidance>
        <p>The engine has three protections you can wire up:</p>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          <li><b className="text-text">Preconditions</b> abort the run before any side effects. Mark anything critical as <code>fatal</code>.</li>
          <li><b className="text-text">Rollback</b> steps run when a step with <code>on_failure: rollback</code> fails.</li>
          <li><b className="text-text">Postchecks</b> run after success and flag a regression in the audit log.</li>
        </ul>
      </Guidance>

      <CheckList
        title="Preconditions"
        helper="Run before any step. Fatal failures stop the Skill."
        items={pre}
        onChange={next => updateDef(d => ({ ...d, preconditions: next }))}
        suggest={COMMON_CHECKS}
      />

      <section className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Rollback steps</h3>
            <p className="text-[11px] text-muted/70 mt-0.5">
              Only runs when a step has <code>on_failure: rollback</code>.
              {needsRollback ? null : " You don't have any rollback-on-failure steps yet."}
            </p>
          </div>
          <button type="button"
            onClick={() => updateDef(d => ({ ...d, rollback: [...(d.rollback ?? []), { op: "tier_move_dat_from_remote" }] }))}
            className="btn btn-ghost text-xs"><Plus size={12}/> Add rollback step</button>
        </div>
        {roll.length === 0 ? (
          <EmptyRow icon={GitBranch} small hint="No rollback steps. That's fine for read-only / append-only skills."/>
        ) : (
          <ol className="space-y-2">
            {roll.map((s, i) => (
              <li key={i} className="grid grid-cols-[120px_1fr_36px] gap-2 items-center">
                <input className="input font-mono text-xs" placeholder="id"
                  value={s.id ?? ""}
                  onChange={e => updateDef(d => ({ ...d, rollback: roll.map((x, idx) => idx === i ? { ...x, id: e.target.value } : x) }))}/>
                <input className="input font-mono text-xs" placeholder="op"
                  value={s.op}
                  onChange={e => updateDef(d => ({ ...d, rollback: roll.map((x, idx) => idx === i ? { ...x, op: e.target.value } : x) }))}/>
                <button type="button" aria-label="Remove"
                  onClick={() => updateDef(d => ({ ...d, rollback: roll.filter((_, idx) => idx !== i) }))}
                  className="btn btn-ghost p-1.5 text-muted hover:text-danger"><Trash2 size={14}/></button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <CheckList
        title="Postchecks"
        helper="Run after success. Used to detect regressions or unexpected state."
        items={post}
        onChange={next => updateDef(d => ({ ...d, postchecks: next }))}
        suggest={["volume_serves_reads", "replicas_present", "cluster_healthy"]}
      />
    </div>
  );
}

function CheckList({
  title, helper, items, onChange, suggest,
}: {
  title: string; helper: string;
  items: SkillCheck[];
  onChange: (next: SkillCheck[]) => void;
  suggest: string[];
}) {
  const add = (c: SkillCheck) => onChange([...items, c]);
  const update = (i: number, patch: Partial<SkillCheck>) =>
    onChange(items.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">{title}</h3>
        <p className="text-[11px] text-muted/70 mt-0.5">{helper}</p>
      </div>
      {items.length === 0 ? (
        <EmptyRow icon={ShieldCheck} small hint={`No ${title.toLowerCase()} yet.`}/>
      ) : (
        <ol className="space-y-1.5">
          {items.map((c, i) => (
            <li key={i} className="grid grid-cols-[1fr_90px_1fr_36px] gap-2 items-center">
              <input className="input font-mono text-xs" placeholder="check name"
                value={c.check} onChange={e => update(i, { check: e.target.value })} list="known-checks"/>
              <label className="inline-flex items-center gap-1.5 text-xs px-2">
                <input type="checkbox" checked={!!c.fatal} onChange={e => update(i, { fatal: e.target.checked })}/>
                <span>fatal</span>
              </label>
              <input className="input text-xs" placeholder="why this check exists (optional)"
                value={c.doc ?? ""} onChange={e => update(i, { doc: e.target.value })}/>
              <button type="button" aria-label="Remove"
                onClick={() => remove(i)}
                className="btn btn-ghost p-1.5 text-muted hover:text-danger"><Trash2 size={14}/></button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {suggest.map(c => {
          const exists = items.some(x => x.check === c);
          return (
            <button key={c} type="button" disabled={exists}
              onClick={() => add({ check: c, fatal: title === "Preconditions" })}
              className="badge text-xs hover:border-accent/40 hover:text-accent disabled:opacity-50">
              <Plus size={10}/> {c}
            </button>
          );
        })}
        <button type="button"
          onClick={() => add({ check: "" })}
          className="btn btn-ghost text-xs"><Plus size={12}/> Custom check</button>
      </div>
      <datalist id="known-checks">
        {COMMON_CHECKS.map(c => <option key={c} value={c}/>)}
      </datalist>
    </section>
  );
}

// ============================================================
// Step 5 — Review
// ============================================================

function StepReview({
  draft, update, validateState,
}: {
  draft: WizardDraft;
  update: (m: Partial<SkillMeta>) => void;
  validateState: "idle" | "checking" | "ok" | "bad";
}) {
  const [showJson, setShowJson] = useState(false);
  const d = draft.definition;
  return (
    <div className="space-y-5">
      {validateState !== "ok" && (
        <Note tone="danger">
          The current draft fails schema validation. Go back and fix the highlighted step before saving.
        </Note>
      )}

      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${RISK_STYLES[draft.meta.risk_level]}`}>
            {draft.meta.risk_level}
          </span>
          <span className="text-xs text-muted">{draft.meta.category}</span>
          <span className="text-xs text-muted">·</span>
          <span className="font-mono text-sm text-text">{draft.meta.key || "(no key)"}</span>
        </div>
        <div className="text-lg font-semibold">{draft.meta.name || "(unnamed)"}</div>
        {d.summary && <p className="text-sm text-text">{d.summary}</p>}
        {d.description && <p className="text-xs text-muted whitespace-pre-line">{d.description}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PreviewCard title="Inputs" count={d.params?.length ?? 0}>
          {(d.params ?? []).map(p => (
            <div key={p.name} className="flex items-center gap-2 text-xs">
              <span className="font-mono">{p.name}</span>
              <span className="text-muted">{p.type}</span>
              {p.required && <span className="text-danger">*</span>}
            </div>
          ))}
        </PreviewCard>

        <PreviewCard title="Preconditions" count={d.preconditions?.length ?? 0}>
          {(d.preconditions ?? []).map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="font-mono">{c.check}</span>
              {c.fatal && <span className="badge border-danger/40 text-danger text-[10px]">fatal</span>}
            </div>
          ))}
        </PreviewCard>

        <PreviewCard title="Steps" count={d.steps?.length ?? 0} span={2}>
          {(d.steps ?? []).map((s, i) => (
            <div key={i} className="text-xs flex items-baseline gap-2 py-0.5">
              <span className="font-mono text-muted w-4 text-right">{i + 1}.</span>
              <span className="font-mono text-accent">{s.op}</span>
              {s.on_failure && <span className="text-[10px] text-muted">on_failure={s.on_failure}</span>}
              <span className="text-muted truncate">{explainOp(s.op).title}</span>
            </div>
          ))}
        </PreviewCard>

        <PreviewCard title="Rollback" count={d.rollback?.length ?? 0}>
          {(d.rollback ?? []).map((s, i) => (
            <div key={i} className="text-xs"><span className="font-mono text-warning">{s.op}</span></div>
          ))}
        </PreviewCard>

        <PreviewCard title="Postchecks" count={d.postchecks?.length ?? 0}>
          {(d.postchecks ?? []).map((c, i) => (
            <div key={i} className="text-xs"><span className="font-mono">{c.check}</span></div>
          ))}
        </PreviewCard>
      </div>

      <Field label="Change note" hint="What changed in this version? Visible in audit log.">
        <input className="input"
          placeholder={draft.meta.change_note ? "" : "Initial version / fixed precondition / etc."}
          value={draft.meta.change_note}
          onChange={e => update({ change_note: e.target.value })}/>
      </Field>

      <details className="card p-3" open={showJson} onToggle={e => setShowJson((e.target as HTMLDetailsElement).open)}>
        <summary className="text-xs font-medium uppercase tracking-wider text-muted cursor-pointer flex items-center gap-1.5">
          <FileCode2 size={12}/> Raw definition (JSON)
        </summary>
        <pre className="mt-3 font-mono text-[11px] bg-bg p-3 rounded border border-border max-h-[420px] overflow-auto whitespace-pre-wrap">
{JSON.stringify(draft.definition, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function PreviewCard({ title, count, span, children }: {
  title: string; count: number; span?: 1 | 2; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border border-border bg-panel2/30 p-3 ${span === 2 ? "md:col-span-2" : ""}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted/70 mb-2">
        {title} <span className="text-muted">· {count}</span>
      </div>
      {count === 0 ? (
        <div className="text-xs text-muted/60 italic">none</div>
      ) : (
        <div className="space-y-0.5">{children}</div>
      )}
    </div>
  );
}

// ---- Shared helpers ------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium text-muted mb-1">
        {label}{hint && <span className="ml-2 text-muted/60 font-normal">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function Guidance({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-accent/20 bg-accent/5 px-4 py-3 text-xs text-muted space-y-1">
      {children}
    </div>
  );
}

function Note({ tone, children }: { tone: "warning" | "danger"; children: React.ReactNode }) {
  const cls = tone === "warning"
    ? "border-warning/40 bg-warning/5 text-warning"
    : "border-danger/40 bg-danger/5 text-danger";
  const Icon = tone === "warning" ? AlertCircle : XCircle;
  return (
    <div className={`rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${cls}`}>
      <Icon size={14} className="mt-0.5 shrink-0"/>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function EmptyRow({ icon: Icon, hint, small }: { icon: typeof GitBranch; hint: string; small?: boolean }) {
  return (
    <div className={`rounded-md border border-dashed border-border ${small ? "py-4" : "py-6"} px-4 text-center`}>
      <Icon size={small ? 16 : 20} className="mx-auto text-muted/60 mb-1.5"/>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  );
}

function ValidateBadge({ state }: { state: "idle" | "checking" | "ok" | "bad" }) {
  if (state === "checking")
    return <span className="text-xs text-muted inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin"/>checking…</span>;
  if (state === "ok")
    return <span className="text-xs text-success inline-flex items-center gap-1"><CheckCircle2 size={11}/>schema ok</span>;
  if (state === "bad")
    return <span className="text-xs text-danger inline-flex items-center gap-1"><XCircle size={11}/>invalid</span>;
  return null;
}
