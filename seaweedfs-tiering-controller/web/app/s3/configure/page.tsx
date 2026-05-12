"use client";

// S3 Identities — manages access keys and per-bucket permissions
// via `weed shell s3.configure`. Operators add/edit identities
// without touching the underlying identities.json directly.
//
// Each identity has: name, optional credentials, action list.
// Actions are strings like "Read", "Write", "List", "Tagging",
// "Admin" — or scoped form like "Read:bucket-name" to limit to one
// bucket. We render the actions as tag chips with type-to-add.

import { useEffect, useState } from "react";
import useSWR from "swr";
import { UserCog, Plus, Trash2, Save, AlertTriangle, Loader2, Eye, EyeOff, KeyRound, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

type Cred = { accessKey: string; secretKey: string };
type Ident = { name: string; credentials?: Cred[]; actions?: string[] };

const COMMON_ACTIONS = ["Read", "Write", "List", "Tagging", "Admin"];

export default function ConfigurePage() {
  const { t } = useT();
  return (
    <Can cap="s3.configure" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const swrKey = clusterID ? `s3-identities:${clusterID}` : null;
  const { data, mutate, isLoading, error } = useSWR(swrKey, () => api.s3ListIdentities(clusterID));
  const [editing, setEditing] = useState<Ident | null>(null);

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const identities = data?.identities || [];

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <UserCog size={16}/> {t("S3 Identities")}
          </h1>
          <p className="text-xs text-muted mt-1">{t("Access keys and per-bucket permissions. Backed by weed shell s3.configure.")}</p>
        </div>
        <button className="btn inline-flex items-center gap-1.5" onClick={() => setEditing({ name: "", actions: ["Read"] })}>
          <Plus size={14}/> {t("New identity")}
        </button>
      </header>

      {error && (
        <div className="card p-3 text-xs text-rose-300 border-rose-400/30 bg-rose-400/10 inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {String(error)}
        </div>
      )}
      {data?.parse_error && (
        <div className="card p-3 text-xs text-amber-300 border-amber-400/30 bg-amber-400/10 inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {t("Could not parse identities; showing empty list.")} <code className="font-mono">{data.parse_error}</code>
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading
          ? <div className="p-8 text-center text-sm text-muted"><Loader2 size={14} className="animate-spin inline mr-2"/>{t("Loading…")}</div>
          : identities.length === 0
            ? <div className="p-10 text-center text-sm text-muted">{t("No identities yet. Click 'New identity' above to create one.")}</div>
            : (
              <table className="grid w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">{t("Name")}</th>
                    <th className="text-left">{t("Access keys")}</th>
                    <th className="text-left">{t("Actions")}</th>
                    <th className="text-right">{t("Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {identities.map(i => (
                    <tr key={i.name}>
                      <td className="font-mono">{i.name}</td>
                      <td className="font-mono text-muted">{i.credentials?.length || 0}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {(i.actions || []).map(a => <span key={a} className="badge text-[10px]">{a}</span>)}
                        </div>
                      </td>
                      <td className="text-right space-x-2">
                        <button className="btn text-xs" onClick={() => setEditing(i)}>{t("Edit")}</button>
                        <button className="btn text-xs bg-rose-400/15 text-rose-300 border-rose-400/40"
                                onClick={async () => {
                                  if (!confirm(t("Delete identity {n}?").replace("{n}", i.name))) return;
                                  try { await api.s3DeleteIdentity(clusterID, i.name); await mutate(); }
                                  catch (e) { alert((e as Error).message); }
                                }}>
                          <Trash2 size={12}/>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </section>

      {editing && (
        <EditDialog
          identity={editing}
          clusterID={clusterID}
          onClose={async (didChange) => { setEditing(null); if (didChange) await mutate(); }}
        />
      )}
    </div>
  );
}

function EditDialog({
  identity, clusterID, onClose,
}: { identity: Ident; clusterID: string; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  const isNew = !identity.name;
  const [name, setName] = useState(identity.name);
  const [accessKey, setAccessKey] = useState(identity.credentials?.[0]?.accessKey || "");
  const [secretKey, setSecretKey] = useState("");
  const [actions, setActions] = useState<string[]>(identity.actions || []);
  const [revealSecret, setRevealSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionInput, setActionInput] = useState("");

  const addAction = (a: string) => {
    const v = a.trim();
    if (!v) return;
    setActions(s => s.includes(v) ? s : [...s, v]);
    setActionInput("");
  };
  const removeAction = (a: string) => setActions(s => s.filter(x => x !== a));

  const save = async () => {
    if (!name.trim()) { setError(t("Name required")); return; }
    setBusy(true); setError("");
    try {
      const body: { user: string; access_key?: string; secret_key?: string; actions?: string[] } = {
        user: name.trim(),
        actions,
      };
      if (accessKey) body.access_key = accessKey;
      if (secretKey) body.secret_key = secretKey;
      await api.s3UpsertIdentity(clusterID, body);
      onClose(true);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !busy && onClose(false)}>
      <div className="card p-5 w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium inline-flex items-center gap-2">
            <UserCog size={16}/> {isNew ? t("New identity") : t("Edit identity")} {!isNew && <span className="text-muted font-mono text-xs">· {identity.name}</span>}
          </h2>
          <button onClick={() => onClose(false)} className="p-1 text-muted hover:text-text"><X size={16}/></button>
        </div>

        <div className="space-y-3">
          <Field label={t("Name")} required>
            <input value={name} onChange={e => setName(e.target.value)} disabled={!isNew} placeholder="my-app" className="input w-full font-mono"/>
          </Field>
          <Field label={t("Access key")} hint={t("Optional. Leave blank if no key auth is needed.")}>
            <input value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder="AKIA..." className="input w-full font-mono"/>
          </Field>
          <Field label={t("Secret key")} hint={t("Only sent when set; previous secret stays untouched if left blank.")}>
            <div className="relative">
              <input
                type={revealSecret ? "text" : "password"}
                value={secretKey}
                onChange={e => setSecretKey(e.target.value)}
                placeholder="••••••"
                className="input w-full font-mono pr-9"
              />
              <button type="button" onClick={() => setRevealSecret(s => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text" title={revealSecret ? "Hide" : "Show"}>
                {revealSecret ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
          </Field>
          <Field label={t("Actions")} hint={t("Add bare verbs (Read/Write/List/Tagging/Admin) or scope to a bucket with Read:bucket-name.")}>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {actions.map(a => (
                <span key={a} className="badge inline-flex items-center gap-1 text-[11px] cursor-pointer hover:bg-rose-400/15 hover:text-rose-300 hover:border-rose-400/40" onClick={() => removeAction(a)}>
                  {a} <X size={10}/>
                </span>
              ))}
            </div>
            <div className="flex gap-2 mb-2">
              <input value={actionInput} onChange={e => setActionInput(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addAction(actionInput))}
                placeholder="Read:my-bucket" className="input flex-1 font-mono"/>
              <button type="button" onClick={() => addAction(actionInput)} className="btn">{t("Add")}</button>
            </div>
            <div className="flex flex-wrap gap-1">
              {COMMON_ACTIONS.filter(a => !actions.includes(a)).map(a => (
                <button key={a} type="button" className="badge text-[10px] hover:bg-accent/15 hover:text-accent hover:border-accent/40" onClick={() => addAction(a)}>+ {a}</button>
              ))}
            </div>
          </Field>

          {error && <div className="text-xs text-rose-300 inline-flex items-center gap-1"><AlertTriangle size={12}/> {error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn" onClick={() => onClose(false)} disabled={busy}>{t("Cancel")}</button>
            <button className="btn bg-accent/15 text-accent border-accent/40 inline-flex items-center gap-1.5" onClick={save} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}{required && <span className="text-rose-400 ml-1">*</span>}</label>
      {children}
      {hint && <p className="text-[10px] text-muted/80">{hint}</p>}
    </div>
  );
}
