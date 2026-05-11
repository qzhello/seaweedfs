"use client";
import { useConfig, useConfigHistory, api } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { useState } from "react";
import { Flame, Snowflake, History as HistoryIcon, Save, Undo2, AlertTriangle, Eye, EyeOff , Clock } from "lucide-react";
import { relTime } from "@/lib/utils";

type Entry = {
  key: string; group_name: string; value: any; value_type: string;
  is_hot: boolean; is_sensitive: boolean; description: string; impact: string;
  schema: any; updated_by: string; updated_at: string; version: number;
};

export default function SettingsPage() {
  const { data, mutate } = useConfig();
  const groups = data?.groups || {};
  const groupNames = Object.keys(groups).sort();
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted">All runtime config lives here · <Flame size={12} className="inline text-warning"/> hot-reload · <Snowflake size={12} className="inline text-muted"/> restart required</p>
        </div>
      </header>

      <div className="space-y-6">
        {groupNames.map(g => (
          <section key={g} className="card p-5">
            <h2 className="text-base font-medium mb-3 capitalize">{g}</h2>
            <div className="space-y-2">
              {(groups[g] as Entry[]).map(e => (
                <ConfigRow key={e.key} entry={e} onSaved={() => mutate()} onShowHistory={() => setHistoryKey(e.key)}/>
              ))}
            </div>
          </section>
        ))}
        {groupNames.length === 0 && <div className="text-muted text-sm">Loading…</div>}
      </div>

      {historyKey && <HistoryDrawer keyName={historyKey} onClose={() => setHistoryKey(null)} onRollback={async (id) => {
        await api.rollbackConfig(historyKey, id); await mutate(); setHistoryKey(null);
      }}/>}
    </div>
  );
}

function ConfigRow({ entry, onSaved, onShowHistory }: { entry: Entry; onSaved: () => void; onShowHistory: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => JSON.stringify(entry.value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const original = JSON.stringify(entry.value);
  const changed = draft !== original;
  const masked = entry.is_sensitive && !showSecret;

  return (
    <div className="border border-border/60 rounded-lg p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{entry.key}</span>
            {entry.is_hot
              ? <span title="hot reload" className="text-warning"><Flame size={12}/></span>
              : <span title="restart required" className="text-muted"><Snowflake size={12}/></span>}
            {entry.key === "safety.emergency_stop" &&
              <span className="badge border-danger/40 text-danger"><AlertTriangle size={10}/> CRITICAL</span>}
          </div>
          <div className="text-xs text-muted mt-1">{entry.description}</div>
          {entry.impact && <div className="text-xs text-warning/80 mt-0.5">↳ {entry.impact}</div>}
        </div>

        <div className="flex items-center gap-2 min-w-[280px]">
          {editing ? (
            <ValueEditor entry={entry} value={draft} onChange={setDraft}/>
          ) : (
            <code className="font-mono text-xs px-2 py-1 rounded bg-bg border border-border max-w-[300px] truncate">
              {masked ? "***" : original}
            </code>
          )}
          {entry.is_sensitive && !editing && (
            <button className="btn" onClick={() => setShowSecret(!showSecret)}>
              {showSecret ? <EyeOff size={12}/> : <Eye size={12}/>}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {!editing ? (
            <>
              <button className="btn" onClick={() => { setDraft(original); setEditing(true); setErr(null); }}>Edit</button>
              <button className="btn" onClick={onShowHistory}><HistoryIcon size={12}/></button>
            </>
          ) : (
            <>
              {changed && (
                <button className="btn btn-primary" disabled={saving} onClick={async () => {
                  setSaving(true); setErr(null);
                  try {
                    JSON.parse(draft); // syntax sanity
                    await api.setConfig(entry.key, {
                      value: JSON.parse(draft), expected_version: entry.version });
                    setEditing(false); onSaved();
                  } catch (e: any) {
                    setErr(e.message);
                  } finally { setSaving(false); }
                }}><Save size={12}/> Save</button>
              )}
              <button className="btn" onClick={() => { setEditing(false); setErr(null); }}>Cancel</button>
            </>
          )}
        </div>
      </div>

      {editing && changed && (
        <div className="mt-2 text-xs text-muted">
          <span className="font-mono">{original}</span> → <span className="font-mono text-warning">{draft}</span>
        </div>
      )}
      {err && <div className="mt-2 text-xs text-danger">{err}</div>}
      <div className="mt-2 text-[11px] text-muted">
        v{entry.version} · last edited by {entry.updated_by} {relTime(entry.updated_at)}
      </div>
    </div>
  );
}

function ValueEditor({ entry, value, onChange }: { entry: Entry; value: string; onChange: (s: string) => void }) {
  if (entry.value_type === "bool") {
    const v = value.trim() === "true";
    return (
      <button className={`btn ${v ? "btn-primary" : ""}`} onClick={() => onChange(v ? "false" : "true")}>
        {v ? "true" : "false"}
      </button>
    );
  }
  return <input className="input font-mono text-xs w-[300px]" value={value} onChange={e => onChange(e.target.value)}/>;
}

function HistoryDrawer({ keyName, onClose, onRollback }: { keyName: string; onClose: () => void; onRollback: (id: number) => void }) {
  const { data } = useConfigHistory(keyName);
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex justify-end" onClick={onClose}>
      <div className="w-[600px] bg-panel border-l border-border h-full p-5 overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-medium mb-3 font-mono">{keyName} — History</h3>
        <div className="space-y-2">
          {(data?.items || []).map((h: any) => (
            <div key={h.id} className="border border-border/60 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted">v{h.version} · {h.changed_by} · {relTime(h.changed_at)}</span>
                <button className="btn" onClick={() => onRollback(h.id)}><Undo2 size={12}/> Restore</button>
              </div>
              <div className="text-xs space-y-1">
                {h.old_value !== null && <div><span className="text-muted">old:</span> <code className="font-mono">{JSON.stringify(h.old_value)}</code></div>}
                <div><span className="text-muted">new:</span> <code className="font-mono">{JSON.stringify(h.new_value)}</code></div>
              </div>
            </div>
          ))}
          {(!data?.items || !data.items.length) && <EmptyState icon={Clock} title="No config history" hint="Edits to system_config appear here with version + actor."/>}
        </div>
      </div>
    </div>
  );
}
