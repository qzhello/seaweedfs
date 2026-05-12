"use client";
import { useState, useMemo } from "react";
import { useAIProviders, api } from "@/lib/api";
import {
  Sparkles, Plus, Trash2, CheckCircle2, XCircle, Loader2, Star, KeyRound,
  Zap, AlertCircle, X,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";

interface VendorTemplate {
  kind: string;
  label: string;
  doc: string;
  defaults: Record<string, unknown>;
  key_hint: string;
}

interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  secret_ref: string;
  has_encrypted_secret: boolean;
  enabled: boolean;
  is_default: boolean;
  last_test_at?: string;
  last_test_ok?: boolean;
  last_test_error?: string;
  last_test_latency_ms?: number;
  last_used_at?: string;
  updated_at: string;
}

interface ProvidersResp {
  items: ProviderRow[];
  current: string;
  vendors: string[];
  templates: VendorTemplate[];
}

type Draft = Partial<ProviderRow> & { api_key?: string; clear_secret?: boolean };

const blankRow = (tpl?: VendorTemplate): Draft => ({
  kind: tpl?.kind ?? "openai",
  name: "",
  config: tpl?.defaults ?? {},
  secret_ref: "",
  api_key: "",
  enabled: true,
  is_default: false,
});

export default function AIConfigPage() {
  const { data, mutate } = useAIProviders();
  const resp = data as ProvidersResp | undefined;
  const [editing, setEditing] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<string>("");

  const tplByKind = useMemo(() => {
    const m: Record<string, VendorTemplate> = {};
    (resp?.templates ?? []).forEach(t => { m[t.kind] = t; });
    return m;
  }, [resp?.templates]);

  const startNew  = () => setEditing(blankRow(tplByKind["openai"]));
  const startEdit = (row: ProviderRow) => setEditing({ ...row, api_key: "", clear_secret: false });

  const runTest = async (id: string) => {
    setTesting(id);
    try { await api.testAIProvider(id); }
    catch { /* outcome recorded server-side */ }
    finally { setTesting(""); await mutate(); }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-3">
            <Sparkles size={24} className="text-accent"/> AI Providers
          </h1>
          <p className="text-sm text-muted">
            Works with OpenAI, Anthropic Claude, DeepSeek, Ollama, and any OpenAI-compatible gateway.
            API keys are encrypted at rest in PostgreSQL with AES-GCM.
          </p>
          {resp?.current && (
            <p className="text-xs text-muted mt-1">
              Active: <span className="font-mono text-accent">{resp.current}</span>
            </p>
          )}
        </div>
        <button className="btn btn-primary" onClick={startNew}>
          <Plus size={14}/> Add provider
        </button>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(resp?.items ?? []).map(row => (
          <ProviderCard key={row.id} row={row} tpl={tplByKind[row.kind]}
            testing={testing === row.id}
            onTest={() => runTest(row.id)}
            onEdit={() => startEdit(row)}
            onDelete={async () => {
              if (!confirm(`Delete provider "${row.name}"?`)) return;
              await api.deleteAIProvider(row.id);
              await mutate();
            }}
            onSetDefault={async () => {
              await api.upsertAIProvider({
                id: row.id, kind: row.kind, name: row.name,
                config: row.config, secret_ref: row.secret_ref,
                enabled: row.enabled, is_default: true,
              });
              await mutate();
            }}/>
        ))}
        {(resp?.items?.length ?? 0) === 0 && (
          <div className="col-span-full">
            <EmptyState icon={Sparkles}
              title="No AI providers configured"
              hint='Click "Add provider" above to wire OpenAI, Anthropic, or another vendor.'/>
          </div>
        )}
      </section>

      {editing && resp && (
        <ProviderEditor
          draft={editing}
          templates={resp.templates}
          onChange={d => setEditing(d)}
          onClose={() => setEditing(null)}
          onSave={async d => {
            await api.upsertAIProvider({
              id: d.id || undefined,
              kind: d.kind,
              name: d.name,
              config: d.config ?? {},
              secret_ref: d.secret_ref ?? "",
              api_key: d.api_key || undefined,
              clear_secret: d.clear_secret ?? false,
              enabled: d.enabled ?? true,
              is_default: d.is_default ?? false,
            });
            setEditing(null);
            await mutate();
          }}/>
      )}
    </div>
  );
}

function ProviderCard({
  row, tpl, testing, onTest, onEdit, onDelete, onSetDefault,
}: {
  row: ProviderRow; tpl?: VendorTemplate; testing: boolean;
  onTest: () => void; onEdit: () => void; onDelete: () => void; onSetDefault: () => void;
}) {
  const testTone =
    !row.last_test_at ? "text-muted" :
    row.last_test_ok  ? "text-success" : "text-danger";
  return (
    <div className={`card p-5 space-y-3 ${row.is_default ? "border-accent/40 bg-accent/5" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold truncate">{row.name}</span>
            {row.is_default && (
              <span className="text-accent flex items-center gap-0.5 text-xs">
                <Star size={12} fill="currentColor"/> default
              </span>
            )}
            {!row.enabled && <span className="text-xs text-muted">(disabled)</span>}
          </div>
          <div className="text-xs text-muted">
            <span className="badge mr-2">{tpl?.label ?? row.kind}</span>
            <span className="font-mono">{(row.config?.model as string) || "—"}</span>
          </div>
          {row.config?.base_url && (
            <div className="text-xs text-muted font-mono truncate mt-1">
              {String(row.config.base_url)}
            </div>
          )}
        </div>
        <div className="shrink-0"><SecretBadge row={row}/></div>
      </div>

      <div className={`text-xs ${testTone} flex items-center gap-1.5`}>
        {row.last_test_at == null && <span>not tested</span>}
        {row.last_test_ok && <CheckCircle2 size={12}/>}
        {row.last_test_ok === false && <XCircle size={12}/>}
        {row.last_test_at && (
          <>
            <span>{row.last_test_ok ? "OK" : "FAIL"}</span>
            {row.last_test_latency_ms != null && row.last_test_ok && (
              <span className="text-muted">· {row.last_test_latency_ms}ms</span>
            )}
            <span className="text-muted">· {new Date(row.last_test_at).toLocaleString("zh-CN")}</span>
          </>
        )}
      </div>
      {row.last_test_error && (
        <div className="text-xs text-danger flex items-start gap-1 font-mono">
          <AlertCircle size={12} className="mt-0.5 shrink-0"/>
          <span className="break-all">{row.last_test_error}</span>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs pt-2 border-t border-border">
        <button onClick={onTest} disabled={testing} className="btn flex-1 text-xs disabled:opacity-50">
          {testing ? <Loader2 size={12} className="animate-spin"/> : <Zap size={12}/>}
          Test connection
        </button>
        <button onClick={onEdit} className="btn text-xs">Edit</button>
        {!row.is_default && (
          <button onClick={onSetDefault} className="btn text-xs">Set as default</button>
        )}
        <button onClick={onDelete} className="btn text-xs text-danger hover:bg-danger/10">
          <Trash2 size={12}/>
        </button>
      </div>
    </div>
  );
}

function SecretBadge({ row }: { row: ProviderRow }) {
  if (row.has_encrypted_secret) {
    return (
      <span title="API key stored encrypted"
        className="px-2 py-0.5 rounded-md border border-success/40 text-success text-[11px] flex items-center gap-1">
        <KeyRound size={10}/> encrypted
      </span>
    );
  }
  if (row.secret_ref) {
    return (
      <span title={`Read from env var ${row.secret_ref}`}
        className="px-2 py-0.5 rounded-md border border-warning/40 text-warning text-[11px] flex items-center gap-1">
        <KeyRound size={10}/> env
      </span>
    );
  }
  if (row.kind === "rule") return <span className="text-[11px] text-muted">no credentials</span>;
  return (
    <span className="px-2 py-0.5 rounded-md border border-danger/40 text-danger text-[11px]">
      Not configured
    </span>
  );
}

function ProviderEditor({
  draft, templates, onChange, onClose, onSave,
}: {
  draft: Draft;
  templates: VendorTemplate[];
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>("");
  const isEdit = !!draft.id;
  const tpl = templates.find(t => t.kind === draft.kind);
  const config = (draft.config ?? {}) as Record<string, unknown>;

  const updateConfig = (k: string, v: unknown) =>
    onChange({ ...draft, config: { ...config, [k]: v } });

  const switchKind = (newKind: string) => {
    const t = templates.find(x => x.kind === newKind);
    onChange({ ...draft, kind: newKind, config: t?.defaults ?? {} });
  };

  const submit = async () => {
    setSaving(true); setErr("");
    try { await onSave(draft); }
    catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 overflow-auto">
      <div className="bg-panel border border-border rounded-xl w-full max-w-2xl shadow-2xl">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-medium">{isEdit ? "Edit provider" : "New provider"}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-text"><X size={16}/></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <div className="text-xs text-muted mb-2">Vendor</div>
            <div className="grid grid-cols-3 gap-2">
              {templates.map(t => (
                <button key={t.kind} type="button" onClick={() => switchKind(t.kind)}
                  className={`text-left p-3 rounded-md border transition-colors ${
                    draft.kind === t.kind ? "border-accent/50 bg-accent/10" : "border-border hover:bg-panel2"
                  }`}>
                  <div className="font-medium text-sm">{t.label}</div>
                  <div className="text-xs text-muted line-clamp-2 mt-0.5">{t.doc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Name">
              <input className="input" value={draft.name ?? ""}
                onChange={e => onChange({ ...draft, name: e.target.value })}/>
            </Field>
            {draft.kind !== "rule" && (
              <Field label="Model">
                <input className="input font-mono" value={(config.model as string) ?? ""}
                  onChange={e => updateConfig("model", e.target.value)}/>
              </Field>
            )}
            {draft.kind !== "rule" && (
              <Field label="Base URL" full>
                <input className="input font-mono" value={(config.base_url as string) ?? ""}
                  placeholder={draft.kind === "anthropic" ? "https://api.anthropic.com (blank = official endpoint)" : ""}
                  onChange={e => updateConfig("base_url", e.target.value)}/>
              </Field>
            )}
            {draft.kind !== "rule" && (
              <Field label={`API key${tpl?.key_hint ? ` (e.g. ${tpl.key_hint})` : ""}`} full>
                <input className="input font-mono" type="password"
                  placeholder={isEdit && draft.has_encrypted_secret ? "Stored — blank keeps it, fill to replace" : "Paste API key"}
                  value={draft.api_key ?? ""}
                  onChange={e => onChange({ ...draft, api_key: e.target.value, clear_secret: false })}/>
                <div className="text-[11px] text-muted mt-1">
                  Encrypted at rest with AES-GCM; never visible to the UI again. Or use an env var ↓
                </div>
              </Field>
            )}
            {draft.kind !== "rule" && (
              <Field label="Or: env var name" full>
                <input className="input font-mono" placeholder="env:CUSTOM_AI_KEY"
                  value={draft.secret_ref ?? ""}
                  onChange={e => onChange({ ...draft, secret_ref: e.target.value })}/>
              </Field>
            )}
            {isEdit && draft.has_encrypted_secret && (
              <label className="text-xs text-warning col-span-2 flex items-center gap-2">
                <input type="checkbox" checked={draft.clear_secret ?? false}
                  onChange={e => onChange({ ...draft, clear_secret: e.target.checked, api_key: "" })}/>
                Clear the stored encrypted key, fall back to env var
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.enabled ?? true}
                onChange={e => onChange({ ...draft, enabled: e.target.checked })}/>
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.is_default ?? false}
                onChange={e => onChange({ ...draft, is_default: e.target.checked })}/>
              Set as default
            </label>
          </div>

          {err && <div className="text-xs text-danger break-all">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn">Cancel</button>
          <button onClick={submit} className="btn btn-primary" disabled={saving || !draft.name}>
            {saving ? <Loader2 size={14} className="animate-spin"/> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={`text-sm ${full ? "col-span-2" : ""}`}>
      <div className="text-xs text-muted mb-1">{label}</div>
      {children}
    </label>
  );
}
