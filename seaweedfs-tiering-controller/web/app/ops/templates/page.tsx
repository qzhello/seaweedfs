"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Terminal, Plus, Trash2, Edit3, Play, Sparkles, ArrowUp, ArrowDown,
  AlertTriangle, ShieldAlert, Eye, Loader2, Save, X, ChevronRight, CheckCircle2,
  History, Bell, FileCode2,
} from "lucide-react";
import {
  useShellCatalog, useOpsTemplates, useClusters, useAudit,
  useAlertChannels, useAlertTemplates, useAnalyzerScripts,
  api, authHeaders,
  type ShellCommand, type OpsTemplate, type OpsStep, type OpsVariable, type OpsCapture,
  type OpsTemplateAlerts, type AnalyzerScript,
} from "@/lib/api";
import { FlowCanvas, type FlowStepStatus, type StepRunStatus } from "@/components/ops/flow-canvas";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
// Extracted sub-components — page.tsx used to be ~2k lines; the
// editor / run dialog / approval card / history each now live in
// their own file under _components/. Keep this list import-sorted
// because every PR will touch it.
import { RISK_BADGE, RISK_ICON, stepsOf } from "./_components/shared";
import { ModalShell } from "./_components/modal-shell";
import { AlertsSection } from "./_components/alerts-section";
import { AIDraftDialog } from "./_components/ai-draft-dialog";
import { RunDialog } from "./_components/run-dialog";
import { HistoryDialog } from "./_components/history-dialog";
import { AnalyzerStepEditor } from "./_components/analyzer-step-editor";

// ---------------- page ----------------

export default function OpsTemplatesPage() {
  const { t } = useT();
  const { data: tplData, mutate: refetchTpls } = useOpsTemplates();
  const { data: catData } = useShellCatalog();
  const { clusterID } = useCluster();

  const templates: OpsTemplate[] = tplData?.items ?? [];
  const catalog: ShellCommand[] = catData?.items ?? [];

  const [editing, setEditing]   = useState<OpsTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [aiOpen, setAiOpen]     = useState(false);
  const [running, setRunning]   = useState<OpsTemplate | null>(null);
  // Template whose audit history is currently being viewed (modal).
  // Pulled out of the card because the audit query depends on tpl.id
  // and we don't want every card subscribing to its own SWR fetch.
  const [history, setHistory]   = useState<OpsTemplate | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <Terminal size={20}/> {t("Ops Templates")}
          </h1>
          <p className="text-sm text-muted">
            {t("Save and reuse multi-step weed shell playbooks. AI can draft one from a description.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/ops" className="btn">{t("Single-command console")}</Link>
          <button onClick={() => setAiOpen(true)} className="btn inline-flex items-center gap-2">
            <Sparkles size={14}/> {t("Generate with AI")}
          </button>
          <button onClick={() => setCreating(true)} className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            <Plus size={14}/> {t("New template")}
          </button>
        </div>
      </header>

      {!clusterID && (
        <div className="card p-3 text-xs text-muted">
          {t("No cluster selected in the topbar. You'll be asked to pick one when running a template.")}
        </div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.length === 0 && (
          <div className="card p-8 text-center text-sm text-muted col-span-full">
            <Terminal size={32} className="mx-auto mb-2 text-muted/50"/>
            {t("No templates yet. Create one or ask the AI to draft a sample.")}
          </div>
        )}
        {templates.map((tpl) => (
          <TemplateCard
            key={tpl.id}
            tpl={tpl}
            onEdit={() => setEditing(tpl)}
            onDelete={async () => {
              if (!confirm(t("Delete this template?"))) return;
              await api.deleteOpsTemplate(tpl.id);
              refetchTpls();
            }}
            onRun={() => setRunning(tpl)}
            onHistory={() => setHistory(tpl)}
            runDisabled={false}
          />
        ))}
      </section>

      {(creating || editing) && (
        <TemplateEditor
          initial={editing || undefined}
          catalog={catalog}
          onCancel={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refetchTpls(); }}
        />
      )}
      {aiOpen && (
        <AIDraftDialog
          onCancel={() => setAiOpen(false)}
          onAccept={(draft) => { setAiOpen(false); setEditing(draft); }}
        />
      )}
      {running && (
        <RunDialog
          template={running}
          initialClusterID={clusterID}
          onClose={() => setRunning(null)}
        />
      )}
      {history && (
        <HistoryDialog template={history} onClose={() => setHistory(null)}/>
      )}
    </div>
  );
}

// ---------------- pieces ----------------

function TemplateCard({
  tpl, onEdit, onDelete, onRun, onHistory, runDisabled,
}: {
  tpl: OpsTemplate; onEdit: () => void; onDelete: () => void;
  onRun: () => void; onHistory: () => void; runDisabled: boolean;
}) {
  const { t } = useT();
  const steps = stepsOf(tpl);
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-medium truncate">{tpl.name}</div>
          <div className="text-xs text-muted">
            <span className="badge mr-1">{tpl.category}</span>
            {steps.length} {t("steps")}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onHistory} className="p-1.5 text-muted hover:text-text" title={t("Run history")}><History size={14}/></button>
          <button onClick={onEdit} className="p-1.5 text-muted hover:text-text" title={t("Edit")}><Edit3 size={14}/></button>
          <button onClick={onDelete} className="p-1.5 text-muted hover:text-rose-300" title={t("Delete")}><Trash2 size={14}/></button>
        </div>
      </div>
      {tpl.description && (
        <p className="text-xs text-muted line-clamp-3">{tpl.description}</p>
      )}
      <ul className="space-y-1">
        {steps.slice(0, 5).map((s, i) => (
          <li key={i} className="text-[11px] font-mono text-muted truncate">
            {i + 1}. {s.command} <span className="text-muted/60">{s.args || ""}</span>
          </li>
        ))}
        {steps.length > 5 && <li className="text-[11px] text-muted/60">+ {steps.length - 5} more</li>}
      </ul>
      <button
        onClick={onRun}
        disabled={runDisabled}
        className="btn bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 mt-auto"
      >
        <Play size={14}/> {t("Run")}
      </button>
    </div>
  );
}

// ---------------- editor ----------------

function TemplateEditor({
  initial, catalog, onCancel, onSaved,
}: {
  initial?: OpsTemplate;
  catalog: ShellCommand[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory]       = useState(initial?.category ?? "general");
  // Backfill missing IDs at load so the editor can address every step
  // by ID from the start. Server-side normalization will reassign at
  // save if needed, but we want stable client-side identity for
  // selection + drag operations.
  const [steps, setSteps]             = useState<OpsStep[]>(() => {
    const arr = stepsOf(initial);
    const taken = new Set(arr.map(s => s.id).filter(Boolean));
    let nextN = 1;
    return arr.map(s => {
      if (s.id) return s;
      while (taken.has(`s${nextN}`)) nextN++;
      const id = `s${nextN++}`;
      taken.add(id);
      return { ...s, id };
    });
  });
  const [variables, setVariables]     = useState<OpsVariable[]>(() => initial?.variables ?? []);
  // AI safety advisor toggle. Default on for new templates; on edit,
  // preserve whatever was persisted (treat missing as true for legacy
  // rows that pre-date the column).
  const [aiPrecheck, setAIPrecheck]   = useState<boolean>(initial?.ai_precheck ?? true);
  // Alerts config. null on the wire = "no notifications"; the
  // operator clicks "Enable alerts" to materialise a default object
  // and pick channels. Empty channel_ids round-trips back to null
  // server-side, so toggling off doesn't accumulate stale rows.
  const [alerts, setAlerts] = useState<OpsTemplateAlerts | null>(initial?.alerts ?? null);
  const { data: channelsResp } = useAlertChannels();
  const { data: tplsResp } = useAlertTemplates();
  const availableChannels = (channelsResp?.items ?? []) as { id: string; name: string; kind: string; enabled: boolean }[];
  const availableTpls = (tplsResp?.items ?? []) as { id: string; name: string }[];
  const { data: analyzerResp } = useAnalyzerScripts();
  const analyzerScripts = (analyzerResp?.items ?? []) as AnalyzerScript[];
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState("");
  // The flow-canvas node currently in focus; its detail panel hangs
  // below the canvas. Null = nothing selected, show a hint instead.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const catByName = useMemo(() => {
    const m: Record<string, ShellCommand> = {};
    for (const c of catalog) m[c.name] = c;
    return m;
  }, [catalog]);

  // Generate a fresh slug like "s7" that doesn't collide with any
  // existing step ID. Matches the server-side numbering convention.
  function freshId(existing: OpsStep[]): string {
    let n = existing.length + 1;
    const taken = new Set(existing.map(x => x.id).filter(Boolean));
    while (taken.has(`s${n}`)) n++;
    return `s${n}`;
  }
  // New steps default to depending on the last-added step (linear
  // chain feels right when authoring; the operator can rewire by
  // dragging edges).
  function addStep(kind: "shell" | "analyzer" = "shell") {
    setSteps((arr) => {
      const id = freshId(arr);
      const prev = arr.length > 0 ? arr[arr.length - 1].id : undefined;
      const base: OpsStep = {
        id,
        kind,
        command: "",
        args: "",
        reason: "",
        pause_on_error: false,
        capture: [],
        depends_on: prev ? [prev] : [],
      };
      if (kind === "analyzer") {
        base.analyzer = { script_name: "", from_step: prev, params: {} };
        base.command = "analyzer:";
      }
      return [...arr, base];
    });
    // Auto-select the new step so the right panel jumps straight to
    // configuring it.
    setTimeout(() => {
      setSteps(current => {
        const last = current[current.length - 1];
        if (last?.id) setSelectedStepId(last.id);
        return current;
      });
    }, 0);
  }
  // Step lookup is by ID now, not source-array index — flow-canvas
  // edits arrive keyed on ID.
  function updateStepById(id: string, patch: Partial<OpsStep>) {
    setSteps((arr) => arr.map(x => (x.id === id ? { ...x, ...patch } : x)));
  }
  function removeStepById(id: string) {
    setSteps((arr) => {
      const next = arr.filter(x => x.id !== id);
      // Cascade: drop dangling depends_on references so the graph
      // never carries broken edges.
      return next.map(x => ({
        ...x,
        depends_on: (x.depends_on ?? []).filter(d => d !== id),
      }));
    });
  }
  // FlowCanvas hands back the whole array on drag/connect/disconnect.
  // We accept it wholesale — the canvas is the source of truth for
  // graph structure during the editor lifetime.
  function applyGraphChange(next: OpsStep[]) {
    setSteps(next);
  }
  // Compatibility wrappers: the inline detail-panel JSX still uses
  // index-based updateStep / removeStep. Map them through to the
  // ID-based ops so we don't have to rewrite every input handler.
  function updateStep(idx: number, patch: Partial<OpsStep>) {
    const id = steps[idx]?.id;
    if (!id) return;
    updateStepById(id, patch);
  }
  function removeStep(idx: number) {
    const id = steps[idx]?.id;
    if (!id) return;
    removeStepById(id);
  }

  function addVar() {
    setVariables((vs) => [...vs, { key: "", label: "", required: false, default: "" }]);
  }
  function updateVar(idx: number, patch: Partial<OpsVariable>) {
    setVariables((vs) => vs.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function removeVar(idx: number) {
    setVariables((vs) => vs.filter((_, i) => i !== idx));
  }

  // Placeholder palette: every {{name}} the operator could reference
  // from a step's args, derived from declared variables + every prior
  // step's output + captures. Surfacing it as clickable chips means
  // the operator doesn't have to remember the syntax.
  function palettesFor(stepIdx: number): string[] {
    const out: string[] = variables.filter(v => v.key).map(v => `{{${v.key}}}`);
    for (let i = 0; i < stepIdx; i++) {
      out.push(`{{step${i + 1}.output}}`);
      for (const cap of steps[i].capture ?? []) {
        if (cap.as) out.push(`{{step${i + 1}.capture.${cap.as}}}`);
      }
    }
    return out;
  }

  async function save() {
    setError("");
    if (!name.trim()) { setError(t("Name required.")); return; }
    if (steps.length === 0) { setError(t("Add at least one step.")); return; }
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].command) { setError(t("Step {n}: pick a command.").replace("{n}", String(i + 1))); return; }
    }
    for (const v of variables) {
      if (!v.key.trim()) { setError(t("Variable key is required.")); return; }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
        setError(t("Variable key must be a snake_case identifier: {key}").replace("{key}", v.key));
        return;
      }
    }
    setSaving(true);
    try {
      await api.upsertOpsTemplate({
        id: initial?.id,
        name: name.trim(),
        description: description.trim(),
        category: category.trim() || "general",
        steps,
        variables,
        ai_precheck: aiPrecheck,
        // Send alerts only when at least one channel is selected;
        // otherwise the server clears the row, which matches the
        // "alerts off" UX of unchecking the enable toggle.
        alerts: alerts && alerts.channel_ids.length > 0 ? alerts : null,
      } as unknown as { name: string; steps: OpsStep[] });
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const selectedStep = selectedStepId ? steps.find(x => x.id === selectedStepId) : null;
  const selectedStepIdx = selectedStepId ? steps.findIndex(x => x.id === selectedStepId) : -1;

  return (
    <ModalShell onClose={onCancel} title={initial ? t("Edit template") : t("New template")} xlarge>
      {/* Workbench layout: canvas left, form right, footer pinned.
          Right panel is the only scroll region for the form fields;
          the flow canvas lives full-height on the left so operators
          have real space to lay out big DAGs. */}
      <div className="flex flex-col h-full min-h-0">
        <div className="flex-1 flex min-h-0 overflow-hidden">

          {/* ============ LEFT: flow canvas ============ */}
          <div className="flex-1 min-w-0 flex flex-col bg-panel2/30">
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/60 shrink-0">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wider text-muted/70">{t("Flow")}</div>
                <div className="text-[11px] text-muted/70 truncate">
                  {t("drag nodes to reposition · drag from a node's right edge to another's left to link · sibling roots run in parallel")}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => addStep("shell")} className="btn btn-primary inline-flex items-center gap-1 text-xs">
                  <Plus size={12}/> {t("Add step")}
                </button>
                <button
                  onClick={() => addStep("analyzer")}
                  className="btn inline-flex items-center gap-1 text-xs"
                  title={t("Insert a Python analyzer step that post-processes a prior step's stdout.")}
                >
                  <FileCode2 size={12}/> {t("Add analyzer")}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 p-3">
              {/* Pass "100%" so FlowCanvas's outer div fills the
                  flex wrapper. The wrapper is the flex child that
                  grows, so the canvas always sizes to the available
                  room. FlowCanvasProps.height accepts number | string. */}
              <div className="h-full">
                <FlowCanvas
                  steps={steps}
                  editable
                  selectedId={selectedStepId ?? undefined}
                  onSelect={setSelectedStepId}
                  onChange={applyGraphChange}
                  height="100%"
                />
              </div>
            </div>
            {steps.length === 0 && (
              <div className="text-xs text-muted text-center pb-3">
                {t("No steps yet. Click 'Add step' to create one.")}
              </div>
            )}
          </div>

          {/* ============ RIGHT: form panel ============ */}
          <aside className="w-[440px] shrink-0 border-l border-border bg-panel/50 overflow-y-auto">
            <div className="p-4 space-y-4">

              {/* Metadata */}
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted/70 pb-1 border-b border-border/40">
                  {t("Template")}
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted">{t("Name")}</label>
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
                    placeholder="e.g. create-tenant-bucket"/>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted">{t("Category")}</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm">
                    {["general","bucket","iam","volume","tier","cluster","fs","mq"].map((x) => (
                      <option key={x} value={x}>{x}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted">{t("Description")}</label>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                    className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
                    placeholder={t("What does this playbook do and when should an operator run it?")}/>
                </div>
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none pt-1">
                  <input type="checkbox" checked={aiPrecheck}
                    onChange={(e) => setAIPrecheck(e.target.checked)}/>
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles size={11} className="text-amber-300"/>
                    {t("Auto-ask AI for risk/rollback advice before mutating steps")}
                  </span>
                </label>
              </div>

              {/* Alerts */}
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted/70 pb-1 border-b border-border/40">
                  {t("Alerts")}
                </div>
                <AlertsSection
                  alerts={alerts}
                  onChange={setAlerts}
                  channels={availableChannels}
                  templates={availableTpls}
                />
              </div>

              {/* Variables */}
              <div className="space-y-2">
                <div className="flex items-center justify-between pb-1 border-b border-border/40">
                  <span className="text-[10px] uppercase tracking-wider text-muted/70">{t("Variables")}</span>
                  <button onClick={addVar} className="text-[11px] text-muted hover:text-accent inline-flex items-center gap-1">
                    <Plus size={11}/> {t("Add variable")}
                  </button>
                </div>
                {variables.length === 0 && (
                  <p className="text-[11px] text-muted">
                    {t("Declare named inputs the operator fills in at run time, then reference them in step args as ")}
                    <code className="text-text">{"{{name}}"}</code>.
                  </p>
                )}
                {variables.map((v, i) => (
                  <div key={i} className="card p-2 bg-panel/40 space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        value={v.key} onChange={(e) => updateVar(i, { key: e.target.value })}
                        placeholder="bucket_name"
                        className="bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                      />
                      <input
                        value={v.label ?? ""} onChange={(e) => updateVar(i, { label: e.target.value })}
                        placeholder={t("Display label")}
                        className="bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
                      />
                    </div>
                    <input
                      value={v.default ?? ""} onChange={(e) => updateVar(i, { default: e.target.value })}
                      placeholder={t("Default (optional)")}
                      className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                    />
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] text-muted inline-flex items-center gap-1">
                        <input type="checkbox"
                          checked={!!v.required}
                          onChange={(e) => updateVar(i, { required: e.target.checked })}/>
                        {t("Required")}
                      </label>
                      <button onClick={() => removeVar(i)} className="p-1 text-muted hover:text-rose-300">
                        <Trash2 size={12}/>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Selected step detail */}
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted/70 pb-1 border-b border-border/40 inline-flex items-center gap-1.5">
                  {t("Selected step")}
                  {selectedStep && (
                    <span className="font-mono normal-case tracking-normal text-accent">{selectedStep.id}</span>
                  )}
                </div>
                {!selectedStep && (
                  <p className="text-[11px] text-muted italic">
                    {steps.length > 0
                      ? t("Click a node on the left to edit its command, args, AI inference, captures, and approval rule.")
                      : t("Add a step to start authoring the flow.")}
                  </p>
                )}
                {selectedStep && selectedStep.kind === "analyzer" && (() => {
                  const s = selectedStep;
                  const i = selectedStepIdx;
                  return (
                    <AnalyzerStepEditor
                      step={s}
                      stepIdx={i}
                      allSteps={steps}
                      analyzerScripts={analyzerScripts}
                      onChange={(patch) => updateStep(i, patch)}
                      onRemove={() => removeStep(i)}
                    />
                  );
                })()}
                {selectedStep && selectedStep.kind !== "analyzer" && (() => {
                  const s = selectedStep;
                  const i = selectedStepIdx;
                  const cat = catByName[s.command];
                  return (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={s.command}
                          onChange={(e) => updateStep(i, { command: e.target.value })}
                          className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm font-mono min-w-0"
                        >
                          <option value="">{t("— pick a command —")}</option>
                          {catalog.map((c) => (
                            <option key={c.name} value={c.name}>{c.name}  ({c.category}, {c.risk})</option>
                          ))}
                        </select>
                        <button onClick={() => removeStep(i)} className="p-1.5 text-muted hover:text-rose-300 shrink-0" title={t("Delete step")}>
                          <Trash2 size={14}/>
                        </button>
                      </div>
                      {cat && (
                        <div className="flex items-center gap-1.5">
                          <span className={RISK_BADGE[cat.risk]}>
                            <span className="inline-flex items-center gap-1">{RISK_ICON[cat.risk]} {t(cat.risk)}</span>
                          </span>
                          {cat.summary && <span className="text-[11px] text-muted truncate" title={cat.summary}>{cat.summary}</span>}
                        </div>
                      )}
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted">{t("Args")}</label>
                        <input
                          value={s.args ?? ""}
                          onChange={(e) => updateStep(i, { args: e.target.value })}
                          placeholder='-flag=value ...'
                          className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                        />
                      </div>
                      {/* Placeholder palette */}
                      {(() => {
                        const palette = palettesFor(i);
                        if (palette.length === 0) return null;
                        return (
                          <div className="flex items-center flex-wrap gap-1">
                            <span className="text-[10px] text-muted/60">{t("Insert:")}</span>
                            {palette.map((p) => (
                              <button
                                key={p} type="button"
                                onClick={() => updateStep(i, { args: `${s.args ?? ""}${(s.args ?? "").endsWith(" ") || !s.args ? "" : " "}${p}` })}
                                className="text-[10px] font-mono rounded border border-border bg-panel2 px-1.5 py-0.5 hover:border-accent/50 hover:text-accent"
                              >
                                {p}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <label className="text-[11px] text-muted flex items-center gap-1.5"
                          title={t("Pause the interactive runner before this step. The operator sees the rendered command and must approve.")}>
                          <input type="checkbox"
                            checked={!!s.confirm_before}
                            onChange={(e) => updateStep(i, { confirm_before: e.target.checked })}/>
                          {t("Require approval")}
                        </label>
                        <label className="text-[11px] text-muted flex items-center gap-1.5">
                          <input type="checkbox"
                            checked={!!s.pause_on_error}
                            onChange={(e) => updateStep(i, { pause_on_error: e.target.checked })}/>
                          {t("Continue on error")}
                        </label>
                      </div>
                      {cat && (cat.risk === "mutate" || cat.risk === "destructive") && (
                        <div className="space-y-1">
                          <label className="text-[11px] text-muted">{t("Reason (recorded in audit)")}</label>
                          <input
                            value={s.reason ?? ""}
                            onChange={(e) => updateStep(i, { reason: e.target.value })}
                            placeholder={t("Reason (recorded in audit)")}
                            className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
                          />
                        </div>
                      )}
                      {/* AI inference block */}
                      <details open={(s.infer_vars?.length ?? 0) > 0} className="border-t border-border/40 pt-2">
                        <summary className="text-[11px] text-muted cursor-pointer">
                          {t("AI infers variables from prior steps")}
                          {(s.infer_vars?.length ?? 0) > 0 && <span className="text-amber-300"> ({s.infer_vars!.length})</span>}
                        </summary>
                        <div className="space-y-1.5 mt-2">
                          {(s.infer_vars ?? []).map((iv, ii) => (
                            <div key={ii} className="card p-2 bg-panel/40 space-y-1.5">
                              <div className="grid grid-cols-12 gap-1.5">
                                <input
                                  value={iv.var}
                                  onChange={(e) => {
                                    const next = [...(s.infer_vars ?? [])];
                                    next[ii] = { ...next[ii], var: e.target.value };
                                    updateStep(i, { infer_vars: next });
                                  }}
                                  placeholder={t("variable name")}
                                  className="col-span-7 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
                                />
                                <input
                                  type="number" min={0} max={i}
                                  value={iv.from_step ?? 0}
                                  onChange={(e) => {
                                    const next = [...(s.infer_vars ?? [])];
                                    next[ii] = { ...next[ii], from_step: Number(e.target.value) };
                                    updateStep(i, { infer_vars: next });
                                  }}
                                  placeholder="step #"
                                  title={t("Step number to analyze (0 = any prior step)")}
                                  className="col-span-4 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px]"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = [...(s.infer_vars ?? [])];
                                    next.splice(ii, 1);
                                    updateStep(i, { infer_vars: next });
                                  }}
                                  className="col-span-1 text-muted hover:text-rose-300 justify-self-end"
                                >
                                  <Trash2 size={11}/>
                                </button>
                              </div>
                              <input
                                value={iv.hint}
                                onChange={(e) => {
                                  const next = [...(s.infer_vars ?? [])];
                                  next[ii] = { ...next[ii], hint: e.target.value };
                                  updateStep(i, { infer_vars: next });
                                }}
                                placeholder={t("Hint, e.g. 'the server with the most volumes'")}
                                className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-[11px]"
                              />
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => updateStep(i, {
                              infer_vars: [...(s.infer_vars ?? []), { var: "", from_step: Math.max(0, i), hint: "" }],
                            })}
                            className="text-[11px] text-muted hover:text-accent inline-flex items-center gap-1"
                          >
                            <Plus size={11}/> {t("Add inference")}
                          </button>
                        </div>
                      </details>
                      {/* Capture editor */}
                      <details className="border-t border-border/40 pt-2">
                        <summary className="text-[11px] text-muted cursor-pointer">
                          {t("Capture from output")} {(s.capture?.length ?? 0) > 0 && <span className="text-accent">({s.capture!.length})</span>}
                        </summary>
                        <div className="space-y-1.5 mt-2">
                          {(s.capture ?? []).map((cap, ci) => (
                            <div key={ci} className="grid grid-cols-12 gap-1.5">
                              <input
                                value={cap.as}
                                onChange={(e) => {
                                  const next: OpsCapture[] = [...(s.capture ?? [])];
                                  next[ci] = { ...next[ci], as: e.target.value };
                                  updateStep(i, { capture: next });
                                }}
                                placeholder={t("alias")}
                                className="col-span-4 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
                              />
                              <input
                                value={cap.regex}
                                onChange={(e) => {
                                  const next: OpsCapture[] = [...(s.capture ?? [])];
                                  next[ci] = { ...next[ci], regex: e.target.value };
                                  updateStep(i, { capture: next });
                                }}
                                placeholder={'owner:"([^"]+)"'}
                                className="col-span-7 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
                              />
                              <button onClick={() => {
                                const next = (s.capture ?? []).filter((_, j) => j !== ci);
                                updateStep(i, { capture: next });
                              }} className="col-span-1 p-1 text-muted hover:text-rose-300 justify-self-end">
                                <Trash2 size={12}/>
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => updateStep(i, { capture: [...(s.capture ?? []), { as: "", regex: "" }] })}
                            className="text-[11px] text-muted hover:text-text inline-flex items-center gap-1"
                          >
                            <Plus size={10}/> {t("Add capture")}
                          </button>
                        </div>
                      </details>
                    </div>
                  );
                })()}
              </div>
            </div>
          </aside>
        </div>

        {/* Pinned footer — error + Save/Cancel always visible regardless
            of how far the right panel is scrolled. */}
        <div className="shrink-0 border-t border-border bg-panel/80 backdrop-blur px-4 py-3 flex items-center gap-3">
          {error && (
            <div className="flex-1 text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-1.5">
              {error}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onCancel} className="btn">{t("Cancel")}</button>
            <button onClick={save} disabled={saving}
              className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
              {saving ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

