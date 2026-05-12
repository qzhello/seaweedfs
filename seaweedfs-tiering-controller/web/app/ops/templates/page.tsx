"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Terminal, Plus, Trash2, Edit3, Play, Sparkles, ArrowUp, ArrowDown,
  AlertTriangle, ShieldAlert, Eye, Loader2, Save, X, ChevronRight,
} from "lucide-react";
import {
  useShellCatalog, useOpsTemplates,
  api, getToken,
  type ShellCommand, type OpsTemplate, type OpsStep, type OpsVariable, type OpsCapture,
} from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";

// ---------------- helpers ----------------

const RISK_BADGE = {
  read:        "badge border-emerald-400/40 text-emerald-300",
  mutate:      "badge border-amber-400/40 text-amber-300",
  destructive: "badge border-rose-400/40 text-rose-300",
} as const;

const RISK_ICON = {
  read:        <Eye size={12} />,
  mutate:      <AlertTriangle size={12} />,
  destructive: <ShieldAlert size={12} />,
} as const;

// stepsOf flattens whatever the server returned for `steps` into an
// OpsStep[]. The Go side serialises jsonb as embedded JSON — pgx returns
// it as a JSON-encoded string, so we may receive either an array or its
// string form. Normalise both shapes here so callers don't care.
function stepsOf(t: OpsTemplate | null | undefined): OpsStep[] {
  if (!t) return [];
  if (Array.isArray(t.steps)) return t.steps;
  try { return JSON.parse(String(t.steps)) as OpsStep[]; } catch { return []; }
}

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
          {t("Pick a cluster in the topbar to run a template.")}
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
            runDisabled={!clusterID}
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
      {running && clusterID && (
        <RunDialog
          template={running}
          clusterID={clusterID}
          onClose={() => setRunning(null)}
        />
      )}
    </div>
  );
}

// ---------------- pieces ----------------

function TemplateCard({
  tpl, onEdit, onDelete, onRun, runDisabled,
}: { tpl: OpsTemplate; onEdit: () => void; onDelete: () => void; onRun: () => void; runDisabled: boolean; }) {
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
  const [steps, setSteps]             = useState<OpsStep[]>(() => stepsOf(initial));
  const [variables, setVariables]     = useState<OpsVariable[]>(() => initial?.variables ?? []);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState("");

  const catByName = useMemo(() => {
    const m: Record<string, ShellCommand> = {};
    for (const c of catalog) m[c.name] = c;
    return m;
  }, [catalog]);

  function addStep() {
    setSteps((s) => [...s, { command: "", args: "", reason: "", pause_on_error: false, capture: [] }]);
  }
  function updateStep(idx: number, patch: Partial<OpsStep>) {
    setSteps((s) => s.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function moveStep(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    setSteps(next);
  }
  function removeStep(idx: number) {
    setSteps((s) => s.filter((_, i) => i !== idx));
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
      } as unknown as { name: string; steps: OpsStep[] });
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell onClose={onCancel} title={initial ? t("Edit template") : t("New template")}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1">
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
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted">{t("Description")}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
            className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
            placeholder={t("What does this playbook do and when should an operator run it?")}/>
        </div>

        {/* ---------- Variables ----------------------------------- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-muted/70">{t("Variables")}</span>
            <button onClick={addVar} className="btn inline-flex items-center gap-1 text-xs">
              <Plus size={12}/> {t("Add variable")}
            </button>
          </div>
          {variables.length === 0 && (
            <p className="text-[11px] text-muted">
              {t("Declare named inputs the operator fills in at run time, then reference them in step args as ")}
              <code className="text-text">{"{{name}}"}</code>.
            </p>
          )}
          {variables.map((v, i) => (
            <div key={i} className="card p-2 bg-panel/40 grid grid-cols-12 gap-2 items-center">
              <input
                value={v.key} onChange={(e) => updateVar(i, { key: e.target.value })}
                placeholder="bucket_name"
                className="col-span-3 bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
              />
              <input
                value={v.label ?? ""} onChange={(e) => updateVar(i, { label: e.target.value })}
                placeholder={t("Display label")}
                className="col-span-3 bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
              />
              <input
                value={v.default ?? ""} onChange={(e) => updateVar(i, { default: e.target.value })}
                placeholder={t("Default (optional)")}
                className="col-span-3 bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
              />
              <label className="col-span-2 text-[11px] text-muted inline-flex items-center gap-1">
                <input type="checkbox"
                  checked={!!v.required}
                  onChange={(e) => updateVar(i, { required: e.target.checked })}/>
                {t("Required")}
              </label>
              <button onClick={() => removeVar(i)} className="col-span-1 p-1 text-muted hover:text-rose-300 justify-self-end">
                <Trash2 size={14}/>
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-muted/70">{t("Steps")}</span>
            <button onClick={addStep} className="btn inline-flex items-center gap-1 text-xs">
              <Plus size={12}/> {t("Add step")}
            </button>
          </div>
          {steps.map((s, i) => {
            const cat = catByName[s.command];
            return (
              <div key={i} className="card p-3 space-y-2 bg-panel/40">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted font-mono w-6">{i + 1}.</span>
                  <select
                    value={s.command}
                    onChange={(e) => updateStep(i, { command: e.target.value })}
                    className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1 text-sm font-mono"
                  >
                    <option value="">{t("— pick a command —")}</option>
                    {catalog.map((c) => (
                      <option key={c.name} value={c.name}>{c.name}  ({c.category}, {c.risk})</option>
                    ))}
                  </select>
                  {cat && (
                    <span className={RISK_BADGE[cat.risk]}>
                      <span className="inline-flex items-center gap-1">{RISK_ICON[cat.risk]} {t(cat.risk)}</span>
                    </span>
                  )}
                  <button onClick={() => moveStep(i, -1)} disabled={i === 0}
                    className="p-1 text-muted hover:text-text disabled:opacity-30"><ArrowUp size={14}/></button>
                  <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1}
                    className="p-1 text-muted hover:text-text disabled:opacity-30"><ArrowDown size={14}/></button>
                  <button onClick={() => removeStep(i)} className="p-1 text-muted hover:text-rose-300">
                    <Trash2 size={14}/>
                  </button>
                </div>
                {cat && cat.summary && (
                  <p className="text-[11px] text-muted ml-8">{cat.summary}</p>
                )}
                <div className="grid grid-cols-3 gap-2 ml-8">
                  <input
                    value={s.args ?? ""}
                    onChange={(e) => updateStep(i, { args: e.target.value })}
                    placeholder='-flag=value ...'
                    className="col-span-2 bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                  />
                  <label className="text-[11px] text-muted flex items-center gap-1">
                    <input type="checkbox"
                      checked={!!s.pause_on_error}
                      onChange={(e) => updateStep(i, { pause_on_error: e.target.checked })}/>
                    {t("Continue on error")}
                  </label>
                </div>
                {/* Placeholder palette: click to append into args. */}
                {(() => {
                  const palette = palettesFor(i);
                  if (palette.length === 0) return null;
                  return (
                    <div className="ml-8 flex items-center flex-wrap gap-1">
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
                {cat && (cat.risk === "mutate" || cat.risk === "destructive") && (
                  <input
                    value={s.reason ?? ""}
                    onChange={(e) => updateStep(i, { reason: e.target.value })}
                    placeholder={t("Reason (recorded in audit)")}
                    className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs ml-8"
                    style={{ width: "calc(100% - 2rem)" }}
                  />
                )}
                {/* Capture editor: regex → alias. Surfaces this step's
                    stdout to subsequent steps as {{stepN.capture.alias}}. */}
                <details className="ml-8">
                  <summary className="text-[11px] text-muted cursor-pointer">
                    {t("Capture from output")} {(s.capture?.length ?? 0) > 0 && <span className="text-accent">({s.capture!.length})</span>}
                  </summary>
                  <div className="space-y-1 mt-2">
                    {(s.capture ?? []).map((cap, ci) => (
                      <div key={ci} className="grid grid-cols-12 gap-2">
                        <input
                          value={cap.as}
                          onChange={(e) => {
                            const next: OpsCapture[] = [...(s.capture ?? [])];
                            next[ci] = { ...next[ci], as: e.target.value };
                            updateStep(i, { capture: next });
                          }}
                          placeholder={t("alias")}
                          className="col-span-3 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
                        />
                        <input
                          value={cap.regex}
                          onChange={(e) => {
                            const next: OpsCapture[] = [...(s.capture ?? [])];
                            next[ci] = { ...next[ci], regex: e.target.value };
                            updateStep(i, { capture: next });
                          }}
                          placeholder={'owner:"([^"]+)"'}
                          className="col-span-8 bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
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
          })}
          {steps.length === 0 && (
            <div className="text-xs text-muted text-center py-4">{t("No steps yet.")}</div>
          )}
        </div>

        {error && (
          <div className="text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} className="btn">{t("Cancel")}</button>
          <button onClick={save} disabled={saving}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            {saving ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
            {t("Save")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------- AI draft ----------------

function AIDraftDialog({
  onCancel, onAccept,
}: {
  onCancel: () => void;
  onAccept: (draft: OpsTemplate) => void;
}) {
  const { t } = useT();
  const [text, setText]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [raw, setRaw]         = useState("");

  async function draft() {
    setError(""); setRaw(""); setLoading(true);
    try {
      const r = await api.draftOpsTemplate(text);
      if (!r.ok) {
        setError(r.error || t("AI returned no usable draft."));
        if (r.raw) setRaw(r.raw);
        return;
      }
      // Server returns a draft envelope; coerce into OpsTemplate so the
      // editor can open with it pre-filled.
      const d = r.draft as unknown as OpsTemplate;
      onAccept({
        id: "",
        name: d.name,
        description: d.description,
        category: d.category,
        steps: Array.isArray(d.steps) ? d.steps : [],
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalShell onClose={onCancel} title={t("Draft a template with AI")}>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          {t("Describe what you want the playbook to do, in your own words. The AI will pick commands from the catalog and propose a draft you can review and edit before saving.")}
        </p>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder={t("e.g. Create an S3 bucket called acme-logs for tenant Acme, give it a 50GB quota, enable versioning, then create a service account scoped to it.")}
          className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm"
        />
        {error && (
          <div className="text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-2 space-y-2">
            <div>{error}</div>
            {raw && (
              <details>
                <summary className="cursor-pointer text-muted">{t("Show raw AI response")}</summary>
                <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all">{raw}</pre>
              </details>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn">{t("Cancel")}</button>
          <button onClick={draft} disabled={loading || !text.trim()}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            {loading ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
            {t("Draft")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------- run dialog ----------------

type StepStatus = "pending" | "running" | "done" | "error";

function RunDialog({
  template, clusterID, onClose,
}: { template: OpsTemplate; clusterID: string; onClose: () => void; }) {
  const { t } = useT();
  const steps = stepsOf(template);
  const vars  = template.variables ?? [];
  const [statuses, setStatuses] = useState<StepStatus[]>(() => steps.map(() => "pending"));
  const [outputs, setOutputs]   = useState<string[]>(() => steps.map(() => ""));
  const [errors, setErrors]     = useState<string[]>(() => steps.map(() => ""));
  // Server-side rendered args (placeholders → values) per step, so the
  // operator can see exactly what was about to fire.
  const [resolved, setResolved] = useState<string[]>(() => steps.map(() => ""));
  const [running, setRunning]   = useState(false);
  const [done, setDone]         = useState(false);
  const [continueOnError, setContinueOnError] = useState(false);
  // Variable values come from the operator before the run starts.
  // Initialize from each variable's declared default so common values
  // are one click away.
  const [varInputs, setVarInputs] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const x of vars) v[x.key] = x.default ?? "";
    return v;
  });

  // Required variables must all be filled before we let the operator
  // hit Run. Computed every render so the button state is always live.
  const missingRequired = vars
    .filter(v => v.required && !(varInputs[v.key] ?? "").trim())
    .map(v => v.key);

  async function run() {
    if (running) return;
    if (missingRequired.length > 0) return;
    setRunning(true); setDone(false);
    setStatuses(steps.map(() => "pending"));
    setOutputs(steps.map(() => ""));
    setErrors(steps.map(() => ""));
    setResolved(steps.map(() => ""));

    const qs = new URLSearchParams();
    if (continueOnError) qs.set("continue_on_error", "true");
    for (const v of vars) {
      const val = varInputs[v.key];
      if (val !== undefined && val !== "") qs.set(`var.${v.key}`, val);
    }
    const url = `/api/v1/clusters/${clusterID}/ops/templates/${template.id}/run`
              + (qs.toString() ? `?${qs.toString()}` : "");
    const headers: Record<string, string> = {};
    const tok = getToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    try {
      const r = await fetch(url, { headers });
      if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let event = "line";
      let currentIdx = -1;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.startsWith("event: ")) {
            event = raw.slice(7).trim();
          } else if (raw.startsWith("data: ")) {
            const payload = raw.slice(6);
            if (event === "step_start") {
              try {
                const { index, args } = JSON.parse(payload) as { index: number; args?: string };
                currentIdx = index;
                setStatuses((s) => s.map((x, i) => (i === index ? "running" : x)));
                if (args !== undefined) {
                  setResolved((r) => r.map((x, i) => (i === index ? args : x)));
                }
              } catch { /* ignore */ }
            } else if (event === "line") {
              if (currentIdx >= 0) {
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
            } else if (event === "done") {
              setDone(true);
            }
          }
        }
      }
    } catch (e: unknown) {
      // Surface fetch-level errors on the first non-done step so they're
      // visible without us inventing a separate "global error" slot.
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
    }
  }

  return (
    <ModalShell onClose={onClose} title={`${t("Run")}: ${template.name}`} wide>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted">{template.description}</p>
          <label className="text-xs text-muted inline-flex items-center gap-2">
            <input
              type="checkbox" checked={continueOnError}
              onChange={(e) => setContinueOnError(e.target.checked)}
              disabled={running}
            />
            {t("Continue on error")}
          </label>
        </div>

        {vars.length > 0 && (
          <div className="card p-3 space-y-2 bg-panel/40">
            <div className="text-xs uppercase tracking-wider text-muted/70">{t("Inputs")}</div>
            {vars.map((v) => (
              <div key={v.key} className="grid grid-cols-12 gap-2 items-center">
                <label className="col-span-3 text-xs text-muted">
                  {v.label || v.key}
                  {v.required && <span className="text-rose-400 ml-1">*</span>}
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
        )}

        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {steps.map((s, i) => (
            <StepRow
              key={i}
              idx={i}
              step={s}
              status={statuses[i]}
              output={outputs[i]}
              error={errors[i]}
              resolvedArgs={resolved[i]}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn">{done ? t("Close") : t("Cancel")}</button>
          {missingRequired.length > 0 && (
            <span className="text-[11px] text-rose-300 self-center mr-2">
              {t("Missing required input(s): {keys}").replace("{keys}", missingRequired.join(", "))}
            </span>
          )}
          <button onClick={run} disabled={running || missingRequired.length > 0}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            {running ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
            {done && !running ? t("Run again") : t("Run")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function StepRow({
  idx, step, status, output, error, resolvedArgs,
}: { idx: number; step: OpsStep; status: StepStatus; output: string; error: string; resolvedArgs?: string; }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const statusBadge: Record<StepStatus, string> = {
    pending: "border-muted text-muted",
    running: "border-amber-400/40 text-amber-300",
    done:    "border-emerald-400/40 text-emerald-300",
    error:   "border-rose-400/40 text-rose-300",
  };
  return (
    <div className="card p-3 bg-panel/40">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 text-left">
        <span className="text-xs font-mono w-6 text-muted">{idx + 1}.</span>
        <span className="flex-1 font-mono text-xs truncate">
          {step.command} <span className="text-muted">{step.args || ""}</span>
        </span>
        <span className={`badge ${statusBadge[status]}`}>
          {status === "running" && <Loader2 size={11} className="animate-spin inline mr-1"/>}
          {t(status)}
        </span>
        <ChevronRight size={14} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`}/>
      </button>
      {open && (
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
            <pre className="text-[11px] font-mono text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md p-2 whitespace-pre-wrap break-all">
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
        </div>
      )}
    </div>
  );
}

// ---------------- modal shell ----------------

function ModalShell({
  children, onClose, title, wide,
}: { children: React.ReactNode; onClose: () => void; title: string; wide?: boolean; }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`card p-5 w-full ${wide ? "max-w-3xl" : "max-w-2xl"} max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">{title}</h2>
          <button onClick={onClose} className="p-1 text-muted hover:text-text"><X size={16}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}
