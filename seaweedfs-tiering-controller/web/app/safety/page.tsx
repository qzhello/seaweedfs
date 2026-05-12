"use client";
import { useSafetyStatus, useBlocklist, useMaintenance, api } from "@/lib/api";
import { ShieldAlert, ShieldCheck, AlertTriangle, Plus, Trash2, Lock, Unlock, Clock } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";

export default function SafetyPage() {
  const { data: status, mutate: refetchStatus } = useSafetyStatus();
  const { data: blocklist, mutate: refetchBL } = useBlocklist();
  const { data: maint, mutate: refetchMaint }   = useMaintenance();
  const [stopBusy, setStopBusy] = useState(false);

  const engaged = status?.safety_code === "emergency_stop";

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight flex items-center gap-2">
          <ShieldAlert size={20}/> Safety
        </h1>
      </header>

      {/* ---- Big Red Button ---- */}
      <section className={`card p-6 ${engaged ? "border-danger/60 bg-danger/5" : "border-border"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium flex items-center gap-2">
              {engaged
                ? <span className="text-danger">🛑 Emergency stop ENGAGED</span>
                : <span className="text-success flex items-center gap-2"><ShieldCheck size={18}/> Normal operation</span>}
            </h2>
            <p className="text-sm text-muted mt-1">
              {engaged
                ? "All auto migrations are paused globally. Manual task runs from /tasks are also blocked by the scheduler."
                : "Press to immediately freeze every auto and manual migration across all clusters."}
            </p>
            {!status?.overall_allowed && (
              <p className="text-xs text-warning mt-2">
                Overall verdict: <strong>{status?.safety_code}</strong> — {status?.safety_reason || status?.health_reason}
              </p>
            )}
          </div>
          <button
            disabled={stopBusy}
            className={`btn ${engaged ? "btn-primary" : "btn-danger"} text-base px-6 py-3`}
            onClick={async () => {
              const note = prompt(engaged ? "Why are you releasing the stop?" : "Why are you engaging the stop?") || "";
              if (!confirm(engaged ? "Release emergency stop?" : "ENGAGE emergency stop?")) return;
              setStopBusy(true);
              try {
                await api.emergencyStop(!engaged, note);
                await refetchStatus();
              } finally { setStopBusy(false); }
            }}>
            {engaged ? <><Unlock size={16}/> Release</> : <><Lock size={16}/> Engage stop</>}
          </button>
        </div>
      </section>

      {/* ---- Blocklist ---- */}
      <BlocklistPanel items={blocklist?.items || []} refetch={refetchBL}/>

      {/* ---- Maintenance windows ---- */}
      <MaintenancePanel items={maint?.items || []} refetch={refetchMaint}/>
    </div>
  );
}

function BlocklistPanel({ items, refetch }: { items: any[]; refetch: () => void }) {
  const [editing, setEditing] = useState<any | null>(null);
  const blank = {
    scope_kind: "collection", scope_value: "", actions: [] as string[],
    mode: "deny", reason: "", expires_at: null,
  };
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium flex items-center gap-2"><AlertTriangle size={16}/> Blocklist</h2>
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> Add</button>
      </div>
      <p className="text-xs text-muted">Resources permanently blocked from migration (finance / compliance / live drills). Match: exact or <code>*</code> prefix/suffix wildcard.</p>
      <table className="grid">
        <thead><tr><th>Scope</th><th>Pattern</th><th>Actions</th><th>Reason</th><th>Expires</th><th></th></tr></thead>
        <tbody>
          {items.map((b: any) => (
            <tr key={b.id}>
              <td><span className="badge">{b.scope_kind}</span></td>
              <td className="font-mono text-xs">{b.scope_value}</td>
              <td className="text-xs">{b.actions?.length ? b.actions.join(", ") : <span className="text-muted">all</span>}</td>
              <td className="text-xs text-muted">{b.reason}</td>
              <td className="text-xs text-muted">{b.expires_at ? relTime(b.expires_at) : "never"}</td>
              <td className="text-right">
                <button className="btn btn-danger" onClick={async () => {
                  if (confirm(`Delete ${b.scope_kind}=${b.scope_value}?`)) {
                    await api.deleteBlocklist(b.id); refetch();
                  }
                }}><Trash2 size={12}/></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <div className="text-center text-sm text-muted p-6">No blocklist entries.</div>}
      {editing && <BlocklistModal initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refetch(); }}/>}
    </section>
  );
}

function BlocklistModal({ initial, onClose, onSaved }: any) {
  const [d, setD] = useState({ ...initial, actions_csv: (initial.actions || []).join(",") });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={initial.id ? "Edit block" : "Add block"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Scope kind"><select className="input w-full" value={d.scope_kind}
          onChange={e => setD({ ...d, scope_kind: e.target.value })}>
          {["collection", "bucket", "volume_id", "cluster"].map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label="Pattern (* allowed)"><input className="input w-full font-mono text-xs"
          value={d.scope_value} onChange={e => setD({ ...d, scope_value: e.target.value })}/></Field>
        <Field label="Actions (comma; empty=all)" wide><input className="input w-full font-mono text-xs"
          placeholder="tier_upload,ec_encode,tier_move"
          value={d.actions_csv} onChange={e => setD({ ...d, actions_csv: e.target.value })}/></Field>
        <Field label="Reason" wide><input className="input w-full"
          value={d.reason} onChange={e => setD({ ...d, reason: e.target.value })}/></Field>
        <Field label="Expires (ISO, blank=never)" wide><input className="input w-full font-mono text-xs"
          placeholder="2026-12-31T23:59:00Z"
          value={d.expires_at || ""} onChange={e => setD({ ...d, expires_at: e.target.value || null })}/></Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          const actions = d.actions_csv.split(",").map((s: string) => s.trim()).filter(Boolean);
          try { await api.upsertBlocklist({ ...d, actions }); onSaved(); }
          catch (e: any) { setErr(e.message); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

function MaintenancePanel({ items, refetch }: { items: any[]; refetch: () => void }) {
  const [editing, setEditing] = useState<any | null>(null);
  const blank = { name: "", starts_at: "", ends_at: "", reason: "", cluster_id: null };
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium flex items-center gap-2"><Clock size={16}/> Maintenance windows</h2>
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> Add</button>
      </div>
      <p className="text-xs text-muted">Scheduled maintenance windows. The scheduler refuses to run during these.</p>
      <table className="grid">
        <thead><tr><th>Name</th><th>Cluster</th><th>Starts</th><th>Ends</th><th>Reason</th><th></th></tr></thead>
        <tbody>
          {items.map((m: any) => {
            const active = new Date(m.starts_at) <= new Date() && new Date() <= new Date(m.ends_at);
            return (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {active && <span className="badge border-warning/40 text-warning ml-2">ACTIVE</span>}
                </td>
                <td className="text-muted text-xs">{m.cluster_id || "global"}</td>
                <td className="text-xs">{new Date(m.starts_at).toLocaleString()}</td>
                <td className="text-xs">{new Date(m.ends_at).toLocaleString()}</td>
                <td className="text-xs text-muted">{m.reason}</td>
                <td className="text-right">
                  <button className="btn btn-danger" onClick={async () => {
                    if (confirm(`Delete ${m.name}?`)) { await api.deleteMaintenance(m.id); refetch(); }
                  }}><Trash2 size={12}/></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && <div className="text-center text-sm text-muted p-6">No maintenance windows.</div>}
      {editing && <MaintModal initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refetch(); }}/>}
    </section>
  );
}

function MaintModal({ initial, onClose, onSaved }: any) {
  const [d, setD] = useState({ ...initial });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={initial.id ? "Edit window" : "Add window"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" wide><input className="input w-full"
          value={d.name} onChange={e => setD({ ...d, name: e.target.value })}/></Field>
        <Field label="Starts at"><input type="datetime-local" className="input w-full"
          value={d.starts_at} onChange={e => setD({ ...d, starts_at: e.target.value })}/></Field>
        <Field label="Ends at"><input type="datetime-local" className="input w-full"
          value={d.ends_at} onChange={e => setD({ ...d, ends_at: e.target.value })}/></Field>
        <Field label="Cluster ID (blank=global)" wide><input className="input w-full font-mono text-xs"
          value={d.cluster_id || ""} onChange={e => setD({ ...d, cluster_id: e.target.value || null })}/></Field>
        <Field label="Reason" wide><input className="input w-full"
          value={d.reason} onChange={e => setD({ ...d, reason: e.target.value })}/></Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          try {
            const body = {
              ...d,
              starts_at: new Date(d.starts_at).toISOString(),
              ends_at:   new Date(d.ends_at).toISOString(),
            };
            await api.upsertMaintenance(body); onSaved();
          } catch (e: any) { setErr(e.message); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="card p-6 w-[640px] max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-medium mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
    <span className="text-xs text-muted">{label}</span>{children}
  </label>;
}
