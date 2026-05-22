"use client";

// Analyzer Scripts page — operator-curated library of Python
// post-processors. List shows every script; click "Edit" to open the
// editor with a built-in sandbox (paste sample input → run → see
// result). System scripts are protected (no delete, edits flagged).

import { useMemo, useState } from "react";
import {
  Plus, Trash2, Edit3, FileCode2, Lock, Play, Loader2, CheckCircle2,
  Tag, Terminal, Eye, Sparkles, History, RotateCcw,
} from "lucide-react";
import {
  useAnalyzerScripts, useAnalyzerVersions, api,
  type AnalyzerScript, type AnalyzerRunResult,
} from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { toast } from "@/lib/toast";
import { useT } from "@/lib/i18n";

export default function ScriptsPage() {
  const { t } = useT();
  const { data, mutate, isLoading, isValidating, error } = useAnalyzerScripts();
  const [editing, setEditing] = useState<Partial<AnalyzerScript> | null>(null);
  const [filter, setFilter] = useState("");

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q)) ||
      s.for_commands.some(c => c.toLowerCase().includes(q))
    );
  }, [items, filter]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <FileCode2 size={20}/> {t("Analyzer scripts")}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            {t("Python scripts that parse shell-command output deterministically. Templates can plug a script between two shell steps to extract sorted lists, filter by collection, find max/min nodes, etc. — no LLM guesswork on the math.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={t("filter by name / tag / command")}
            className="bg-panel2 border border-border rounded-md px-2 py-1 text-xs w-64"
          />
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <button
            className="btn btn-primary inline-flex items-center gap-1.5"
            onClick={() => setEditing({
              name: "", title: "", description: "",
              for_commands: [], tags: [], params: [],
              body: defaultScriptBody(),
              sample_input: "",
              enabled: true,
            })}
          >
            <Plus size={14}/> {t("New script")}
          </button>
        </div>
      </header>

      {error && <ErrorPanel error={error}/>}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={6} headers={[t("Name"), t("For"), t("Tags"), t("Origin"), ""]}/>
        </section>
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileCode2} title={t("No scripts")} hint={
          filter ? t("No matches for current filter.") : t("Click 'New script' to author one, or run a migration to seed the system library.")
        }/>
      ) : (
        <section className="card overflow-hidden">
          <table className="grid">
            <thead><tr>
              <th>{t("Name")}</th>
              <th>{t("For commands")}</th>
              <th>{t("Tags")}</th>
              <th>{t("Origin")}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="font-mono text-xs">{s.name}</div>
                    <div className="text-[11px] text-muted truncate max-w-[360px]" title={s.description}>
                      {s.title}
                    </div>
                  </td>
                  <td>
                    {s.for_commands.length === 0
                      ? <span className="text-[11px] text-muted">{t("(any)")}</span>
                      : <div className="flex flex-wrap gap-1">
                          {s.for_commands.map(c => (
                            <span key={c} className="badge border-accent/30 text-accent text-[10px] inline-flex items-center gap-1">
                              <Terminal size={9}/>{c}
                            </span>
                          ))}
                        </div>}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {s.tags.slice(0, 3).map(tag => (
                        <span key={tag} className="badge text-[10px] inline-flex items-center gap-1">
                          <Tag size={9}/>{tag}
                        </span>
                      ))}
                      {s.tags.length > 3 && <span className="text-[10px] text-muted">+{s.tags.length - 3}</span>}
                    </div>
                  </td>
                  <td>
                    {s.origin === "system"
                      ? <span className="badge border-amber-400/40 text-amber-300 inline-flex items-center gap-1 text-[10px]">
                          <Lock size={10}/> {t("system")}
                        </span>
                      : <span className="badge text-[10px]">{t("user")}</span>}
                    {!s.enabled && <span className="ml-1 badge border-muted/40 text-muted text-[10px]">{t("off")}</span>}
                  </td>
                  <td>
                    <div className="flex gap-1 justify-end">
                      <button className="btn text-xs inline-flex items-center gap-1" onClick={() => setEditing(s)}>
                        <Edit3 size={11}/> {t("Edit")}
                      </button>
                      {s.origin !== "system" && (
                        <button
                          className="btn text-xs inline-flex items-center"
                          title={t("Delete script")}
                          onClick={async () => {
                            if (!confirm(t('Delete script "{name}"?').replace("{name}", s.name))) return;
                            try {
                              await api.deleteAnalyzerScript(s.id);
                              toast.success(t("Deleted"));
                              mutate();
                            } catch (e) { toast.fromError(e, t("Delete failed")); }
                          }}
                        >
                          <Trash2 size={11}/>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <ScriptEditorModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); mutate(); }}
        />
      )}
    </div>
  );
}

function defaultScriptBody(): string {
  return `import sys, json
# Input envelope: {"input": "<raw text>", "params": {...}}
io = json.load(sys.stdin)
text = io.get("input", "")
params = io.get("params") or {}

# TODO: parse text and build a result.
result = {
    "lines": len(text.splitlines()),
}

# Return envelope: {"ok": true, "result": ...} OR {"ok": false, "error": "..."}
print(json.dumps({"ok": True, "result": result}))
`;
}

// ---------- Editor + sandbox ----------

function ScriptEditorModal({
  initial, onClose, onSaved,
}: {
  initial: Partial<AnalyzerScript>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<Partial<AnalyzerScript>>(initial);
  const [saving, setSaving] = useState(false);
  const [sandboxInput, setSandboxInput] = useState(initial.sample_input ?? "");
  const [sandboxParams, setSandboxParams] = useState("{}");
  const [sandboxResult, setSandboxResult] = useState<AnalyzerRunResult | null>(null);
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [optimizeFocus, setOptimizeFocus] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeProposal, setOptimizeProposal] = useState<{
    body: string;
    rationale: string;
    sandbox_result?: AnalyzerRunResult;
  } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const isSystem = initial.origin === "system";
  const { data: versionsResp } = useAnalyzerVersions(initial.id);
  const versions = versionsResp?.items ?? [];

  const updateField = <K extends keyof AnalyzerScript>(key: K, val: AnalyzerScript[K]) => {
    setDraft(d => ({ ...d, [key]: val }));
  };

  const save = async (reason?: string) => {
    if (!draft.name?.trim() || !draft.body?.trim()) {
      toast.warn(t("Name and body are required"));
      return;
    }
    setSaving(true);
    try {
      await api.upsertAnalyzerScript(draft, reason);
      toast.success(t("Saved"));
      onSaved();
    } catch (e) {
      toast.fromError(e, t("Save failed"));
    } finally {
      setSaving(false);
    }
  };

  // Ask the AI to refactor the current body. Doesn't persist —
  // operators preview + (optionally) accept by clicking "Apply".
  const aiOptimize = async () => {
    if (!initial.id) {
      toast.warn(t("Save the script first so the AI has something to optimize"));
      return;
    }
    setOptimizing(true);
    setOptimizeProposal(null);
    try {
      const r = await api.optimizeAnalyzerScript(initial.id, {
        focus: optimizeFocus,
        sample_input: sandboxInput,
      });
      if (!r.ok || !r.body) {
        toast.error(t("AI optimize failed"), r.error ?? t("no body returned"));
        return;
      }
      setOptimizeProposal({
        body: r.body,
        rationale: r.rationale ?? "",
        sandbox_result: r.sandbox_result,
      });
    } catch (e) {
      toast.fromError(e, t("AI optimize failed"));
    } finally {
      setOptimizing(false);
    }
  };

  const acceptOptimize = () => {
    if (!optimizeProposal) return;
    updateField("body", optimizeProposal.body);
    setOptimizeProposal(null);
    toast.info(t("Applied. Click Save to persist as a new version."));
  };

  const revertTo = async (version: number) => {
    if (!initial.id) return;
    if (!confirm(t("Revert to v{n}? This creates a new version that copies the historical body.").replace("{n}", String(version)))) return;
    try {
      await api.revertAnalyzerScript(initial.id, version);
      toast.success(t("Reverted to v{n}").replace("{n}", String(version)));
      onSaved();
    } catch (e) {
      toast.fromError(e, t("Revert failed"));
    }
  };

  const runSandbox = async () => {
    setSandboxRunning(true);
    setSandboxResult(null);
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(sandboxParams || "{}"); }
    catch (e) {
      toast.error(t("Params is not valid JSON"), (e as Error).message);
      setSandboxRunning(false);
      return;
    }
    try {
      const res = await api.runAnalyzerScript({
        body: draft.body,
        input: sandboxInput,
        params,
        ephemeral: true,
      });
      setSandboxResult(res);
    } catch (e) {
      toast.fromError(e, t("Sandbox run failed"));
    } finally {
      setSandboxRunning(false);
    }
  };

  const curVersion = draft.version ?? initial.version ?? 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-[1400px] h-[90vh] flex flex-col p-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <FileCode2 size={16}/>
            {initial.id ? t("Edit script") : t("New script")}
            {isSystem && (
              <span className="badge border-amber-400/40 text-amber-300 inline-flex items-center gap-1 text-[10px]">
                <Lock size={10}/> {t("system")}
              </span>
            )}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-text" aria-label={t("Close")}>×</button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[1fr_1fr] divide-x divide-border overflow-hidden">

          {/* LEFT: metadata + body editor */}
          <div className="overflow-y-auto p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted">{t("Name")}</label>
                <input
                  value={draft.name ?? ""} onChange={(e) => updateField("name", e.target.value)}
                  className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-sm font-mono"
                  placeholder="volume.top_nodes_by_count"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted">{t("Title")}</label>
                <input
                  value={draft.title ?? ""} onChange={(e) => updateField("title", e.target.value)}
                  className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted">{t("Description")}</label>
              <textarea
                value={draft.description ?? ""} onChange={(e) => updateField("description", e.target.value)}
                rows={2}
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-sm"
                placeholder={t("What this script does and when to use it (the AI assistant uses this to pick scripts).")}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted">{t("For commands (comma separated)")}</label>
                <input
                  value={(draft.for_commands ?? []).join(", ")}
                  onChange={(e) => updateField("for_commands", e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                  className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                  placeholder="volume.list, ec.list"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted">{t("Tags (comma separated)")}</label>
                <input
                  value={(draft.tags ?? []).join(", ")}
                  onChange={(e) => updateField("tags", e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                  className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                  placeholder="sort-by-size, find-max-node"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted">{t("Params (JSON array of {name,type,required?,default?,doc?,enum?})")}</label>
              <textarea
                value={JSON.stringify(draft.params ?? [], null, 2)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value || "[]");
                    updateField("params", parsed);
                  } catch {
                    // Leave as-is — the save handler will revalidate.
                  }
                }}
                rows={4}
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-[11px] font-mono"
                placeholder='[{"name":"n","type":"int","default":5}]'
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted inline-flex items-center gap-2">
                {t("Python body")}
                <span className="text-[10px] text-muted/70 font-normal normal-case">
                  {t("· stdin = { input, params } JSON · stdout = { ok, result, error }")}
                </span>
              </label>
              <textarea
                value={draft.body ?? ""} onChange={(e) => updateField("body", e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-[12px] font-mono leading-relaxed"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-xs">
              <input type="checkbox"
                checked={draft.enabled ?? true}
                onChange={(e) => updateField("enabled", e.target.checked)}/>
              {t("Enabled (available to templates and the assistant)")}
            </label>
          </div>

          {/* RIGHT: sandbox + AI optimize + version history */}
          <div className="overflow-y-auto p-4 space-y-4 bg-panel/40">

            {/* ===== AI Optimize ===== */}
            {initial.id && (
              <section className="card p-3 border-border/60 bg-panel/40 space-y-2">
                <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
                  <Sparkles size={13} className="text-amber-300"/> {t("AI optimize")}
                </h3>
                <p className="text-[11px] text-muted">
                  {t("Asks the configured AI to refactor the body for clarity / robustness. Preview the proposal, optionally accept; saving creates a new version with reason ai-optimize.")}
                </p>
                <input
                  value={optimizeFocus}
                  onChange={(e) => setOptimizeFocus(e.target.value)}
                  placeholder={t("Focus (e.g. 'handle missing collection field', 'speed up by parsing line-by-line')")}
                  className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
                />
                <button
                  onClick={aiOptimize}
                  disabled={optimizing}
                  className="btn btn-primary inline-flex items-center gap-1.5 text-xs"
                >
                  {optimizing ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
                  {optimizing ? t("Asking AI…") : t("Ask AI to optimize")}
                </button>
                {optimizeProposal && (
                  <div className="border-t border-border/40 pt-2 space-y-2">
                    <div className="text-[11px] text-muted whitespace-pre-wrap">{optimizeProposal.rationale}</div>
                    {optimizeProposal.sandbox_result && (
                      <div className={`text-[10px] px-2 py-1 rounded ${
                        optimizeProposal.sandbox_result.ok
                          ? "bg-emerald-400/10 text-emerald-300"
                          : "bg-rose-400/10 text-rose-300"
                      }`}>
                        {t("sandbox")}: {optimizeProposal.sandbox_result.ok ? t("ok") : t("error")} · {optimizeProposal.sandbox_result.elapsed_ms}ms
                        {optimizeProposal.sandbox_result.error ? ` · ${optimizeProposal.sandbox_result.error}` : ""}
                      </div>
                    )}
                    <details>
                      <summary className="text-[11px] text-muted cursor-pointer">{t("Proposed body (diff in your head)")}</summary>
                      <pre className="text-[10px] font-mono bg-black/40 p-2 rounded mt-1 max-h-72 overflow-auto whitespace-pre-wrap">
                        {optimizeProposal.body}
                      </pre>
                    </details>
                    <div className="flex gap-2">
                      <button onClick={acceptOptimize} className="btn btn-primary text-xs inline-flex items-center gap-1">
                        <CheckCircle2 size={12}/> {t("Apply to editor")}
                      </button>
                      <button onClick={() => setOptimizeProposal(null)} className="btn text-xs">{t("Discard")}</button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* ===== Version history ===== */}
            {initial.id && versions.length > 0 && (
              <section className="card p-3 border-border/60 bg-panel/40 space-y-2">
                <button
                  className="flex items-center justify-between w-full text-sm font-semibold"
                  onClick={() => setShowVersions(v => !v)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <History size={13}/> {t("Version history")}
                    <span className="text-[10px] text-muted font-normal">
                      {t("(current: v{n})").replace("{n}", String(curVersion))}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted">{showVersions ? t("hide") : t("show {n}").replace("{n}", String(versions.length))}</span>
                </button>
                {showVersions && (
                  <ul className="divide-y divide-border/30 max-h-72 overflow-auto">
                    {versions.map(v => (
                      <li key={v.id} className="py-1.5 flex items-start gap-2 text-[11px]">
                        <span className="font-mono w-8 shrink-0 text-accent">v{v.version}</span>
                        <div className="flex-1 min-w-0">
                          <div className="truncate">
                            <span className="font-medium">{v.reason || t("edit")}</span>
                            <span className="text-muted/70 ml-1.5">{t("by")} {v.actor || "—"}</span>
                          </div>
                          <div className="text-[10px] text-muted/70">
                            {new Date(v.at).toLocaleString()}
                          </div>
                        </div>
                        <button
                          onClick={() => revertTo(v.version)}
                          className="text-muted hover:text-text inline-flex items-center gap-1 text-[10px]"
                          title={t("Revert to v{n}").replace("{n}", String(v.version))}
                          disabled={v.version === curVersion}
                        >
                          <RotateCcw size={10}/> {t("revert")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* ===== Sandbox ===== */}
            <div>
              <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
                <Eye size={13}/> {t("Sandbox")}
              </h3>
              <p className="text-[11px] text-muted">
                {t("Paste sample shell output → run the script ephemerally → inspect result. Nothing persists until you Save.")}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted">{t("Sample input (typically a `weed shell` stdout dump)")}</label>
              <textarea
                value={sandboxInput} onChange={(e) => setSandboxInput(e.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-[11px] font-mono"
                placeholder="Data Node 10.0.0.1:8080 hdd(volume:42/100 ...)&#10;  id:1 size:104857600 collection:logs ..."
              />
              <button
                className="text-[11px] text-muted hover:text-text"
                onClick={() => updateField("sample_input", sandboxInput)}
              >
                {t("Save as fixture on this script")}
              </button>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted">{t("Params (JSON object)")}</label>
              <textarea
                value={sandboxParams} onChange={(e) => setSandboxParams(e.target.value)}
                rows={3}
                spellCheck={false}
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-[11px] font-mono"
                placeholder='{"n": 5}'
              />
            </div>
            <button
              onClick={runSandbox}
              disabled={sandboxRunning || !draft.body?.trim()}
              className="btn btn-primary inline-flex items-center gap-2"
            >
              {sandboxRunning ? <Loader2 size={13} className="animate-spin"/> : <Play size={13}/>}
              {t("Run")}
            </button>
            {sandboxResult && (
              <section className={`card p-3 ${sandboxResult.ok ? "border-emerald-400/40 bg-emerald-400/5" : "border-rose-400/40 bg-rose-400/5"}`}>
                <div className="flex items-center justify-between text-xs">
                  <span className={`inline-flex items-center gap-1 ${sandboxResult.ok ? "text-emerald-300" : "text-rose-300"}`}>
                    {sandboxResult.ok ? <CheckCircle2 size={12}/> : <span>×</span>}
                    {sandboxResult.ok ? t("ok") : t("error")} · {sandboxResult.elapsed_ms}ms
                  </span>
                  <span className="text-[10px] text-muted font-mono">
                    {t("input")} {sandboxResult.input_size}B · {t("hash")} {sandboxResult.input_hash}
                  </span>
                </div>
                {sandboxResult.error && (
                  <div className="text-[11px] text-rose-300 mt-2 font-mono whitespace-pre-wrap break-words">
                    {sandboxResult.error}
                  </div>
                )}
                {sandboxResult.stderr && (
                  <details className="mt-2">
                    <summary className="text-[10px] text-muted cursor-pointer">{t("stderr")}</summary>
                    <pre className="text-[10px] font-mono mt-1 whitespace-pre-wrap break-all bg-black/40 p-2 rounded max-h-40 overflow-auto">
                      {sandboxResult.stderr}
                    </pre>
                  </details>
                )}
                {sandboxResult.result !== undefined && (
                  <div className="mt-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted/70 mb-1">{t("Result")}</div>
                    <pre className="text-[11px] font-mono bg-black/40 p-2 rounded max-h-72 overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(sandboxResult.result, null, 2)}
                    </pre>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          {initial.id && (
            <span className="text-[11px] text-muted mr-auto">
              {t("v{n} — saving creates v{next}").replace("{n}", String(curVersion)).replace("{next}", String(curVersion + 1))}
            </span>
          )}
          <button onClick={onClose} className="btn">{t("Cancel")}</button>
          <button onClick={() => save()} disabled={saving} className="btn btn-primary inline-flex items-center gap-2">
            {saving ? <Loader2 size={13} className="animate-spin"/> : null}
            {t("Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
