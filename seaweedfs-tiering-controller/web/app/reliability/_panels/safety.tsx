"use client";
import { useSafetyStatus, useBlocklist, useMaintenance, api } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { ShieldAlert, ShieldCheck, AlertTriangle, Plus, Trash2, Lock, Unlock, Clock, ListChecks } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { useT } from "@/lib/i18n";

export function SafetyPanel() {
  const { t } = useT();
  const { data: status, mutate: refetchStatus } = useSafetyStatus();
  const { data: blocklist, mutate: refetchBL } = useBlocklist();
  const { data: maint, mutate: refetchMaint }   = useMaintenance();
  const [stopBusy, setStopBusy] = useState(false);

  const engaged = status?.safety_code === "emergency_stop";

  return (
    <div className="space-y-6">
      {/* ---- Big Red Button ---- */}
      <section className={`card p-6 ${engaged ? "border-danger/60 bg-danger/5" : "border-border"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium flex items-center gap-2">
              {engaged
                ? <span className="text-danger">🛑 {t("Emergency stop ENGAGED")}</span>
                : <span className="text-success flex items-center gap-2"><ShieldCheck size={18}/> {t("Normal operation")}</span>}
            </h2>
            <p className="text-sm text-muted mt-1">
              {engaged
                ? t("All auto migrations are paused globally. Manual task runs from /tasks are also blocked by the scheduler.")
                : t("Press to immediately freeze every auto and manual migration across all clusters.")}
            </p>
            {!status?.overall_allowed && (
              <p className="text-xs text-warning mt-2">
                {t("Overall verdict:")} <strong>{status?.safety_code}</strong> — {status?.safety_reason || status?.health_reason}
              </p>
            )}
          </div>
          <button
            disabled={stopBusy}
            className={`btn ${engaged ? "btn-primary" : "btn-danger"} text-base px-6 py-3`}
            onClick={async () => {
              const note = prompt(engaged ? t("Why are you releasing the stop?") : t("Why are you engaging the stop?")) || "";
              if (!(await confirmDlg.danger({ title: engaged ? t("Release emergency stop?") : t("ENGAGE emergency stop?") }))) return;
              setStopBusy(true);
              try {
                await api.emergencyStop(!engaged, note);
                await refetchStatus();
              } finally { setStopBusy(false); }
            }}>
            {engaged ? <><Unlock size={16}/> {t("Release")}</> : <><Lock size={16}/> {t("Engage stop")}</>}
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
  const { t } = useT();
  const [editing, setEditing] = useState<any | null>(null);
  const blank = {
    scope_kind: "collection", scope_value: "", actions: [] as string[],
    mode: "deny", reason: "", expires_at: null,
  };
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium flex items-center gap-2"><AlertTriangle size={16}/> {t("Blocklist")}</h2>
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> {t("Add")}</button>
      </div>
      <p className="text-xs text-muted">{t("Resources permanently blocked from migration (finance / compliance / live drills). Match: exact or * prefix/suffix wildcard.")}</p>
      <table className="grid">
        <thead><tr><th>{t("Scope")}</th><th>{t("Pattern")}</th><th>{t("Actions")}</th><th>{t("Reason")}</th><th>{t("Expires")}</th><th></th></tr></thead>
        <tbody>
          {items.map((b: any) => (
            <tr key={b.id}>
              <td><span className="badge">{b.scope_kind}</span></td>
              <td className="font-mono text-xs">{b.scope_value}</td>
              <td className="text-xs">{b.actions?.length ? b.actions.join(", ") : <span className="text-muted">{t("all")}</span>}</td>
              <td className="text-xs text-muted">{b.reason}</td>
              <td className="text-xs text-muted">{b.expires_at ? relTime(b.expires_at) : t("never")}</td>
              <td className="text-right">
                <button className="btn btn-danger" onClick={async () => {
                  if (!(await confirmDlg.danger({ title: t("Delete {kind}={value}?").replace("{kind}", b.scope_kind).replace("{value}", b.scope_value) }))) return;
                  await api.deleteBlocklist(b.id); refetch();
                }}><Trash2 size={12}/></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && (
        <EmptyState icon={Lock} size="sm"
          title={t("No blocklist entries")}
          hint={t("Block specific collections, buckets, or volumes from automated actions.")}/>
      )}
      {editing && <BlocklistModal initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refetch(); }}/>}
    </section>
  );
}

function BlocklistModal({ initial, onClose, onSaved }: any) {
  const { t } = useT();
  const [d, setD] = useState({ ...initial, actions_csv: (initial.actions || []).join(",") });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={initial.id ? t("Edit block") : t("Add block")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Scope kind")}><select className="input w-full" value={d.scope_kind}
          onChange={e => setD({ ...d, scope_kind: e.target.value })}>
          {["collection", "bucket", "volume_id", "cluster"].map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label={t("Pattern (* allowed)")}><input className="input w-full font-mono text-xs"
          value={d.scope_value} onChange={e => setD({ ...d, scope_value: e.target.value })}/></Field>
        <Field label={t("Actions (comma; empty=all)")} wide><input className="input w-full font-mono text-xs"
          placeholder="tier_upload,ec_encode,tier_move"
          value={d.actions_csv} onChange={e => setD({ ...d, actions_csv: e.target.value })}/></Field>
        <Field label={t("Reason")} wide><input className="input w-full"
          value={d.reason} onChange={e => setD({ ...d, reason: e.target.value })}/></Field>
        <Field label={t("Expires (ISO, blank=never)")} wide><input className="input w-full font-mono text-xs"
          placeholder="2026-12-31T23:59:00Z"
          value={d.expires_at || ""} onChange={e => setD({ ...d, expires_at: e.target.value || null })}/></Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>{t("Cancel")}</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          const actions = d.actions_csv.split(",").map((s: string) => s.trim()).filter(Boolean);
          try { await api.upsertBlocklist({ ...d, actions }); onSaved(); }
          catch (e: any) { setErr(e.message); }
        }}>{t("Save")}</button>
      </div>
    </Modal>
  );
}

function MaintenancePanel({ items, refetch }: { items: any[]; refetch: () => void }) {
  const { t } = useT();
  const [editing, setEditing] = useState<any | null>(null);
  const blank = { name: "", starts_at: "", ends_at: "", reason: "", cluster_id: null };
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium flex items-center gap-2"><Clock size={16}/> {t("Maintenance windows")}</h2>
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> {t("Add")}</button>
      </div>
      <p className="text-xs text-muted">{t("Scheduled maintenance windows. The scheduler refuses to run during these.")}</p>
      <table className="grid">
        <thead><tr><th>{t("Name")}</th><th>{t("Cluster")}</th><th>{t("Starts")}</th><th>{t("Ends")}</th><th>{t("Reason")}</th><th></th></tr></thead>
        <tbody>
          {items.map((m: any) => {
            const active = new Date(m.starts_at) <= new Date() && new Date() <= new Date(m.ends_at);
            return (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {active && <span className="badge border-warning/40 text-warning ml-2">{t("ACTIVE")}</span>}
                </td>
                <td className="text-muted text-xs">{m.cluster_id || t("global")}</td>
                <td className="text-xs">{new Date(m.starts_at).toLocaleString()}</td>
                <td className="text-xs">{new Date(m.ends_at).toLocaleString()}</td>
                <td className="text-xs text-muted">{m.reason}</td>
                <td className="text-right">
                  <button className="btn btn-danger" onClick={async () => {
                    if (!(await confirmDlg.danger({ title: t("Delete {name}?").replace("{name}", m.name) }))) return;
                    await api.deleteMaintenance(m.id); refetch();
                  }}><Trash2 size={12}/></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && (
        <EmptyState icon={Clock} size="sm"
          title={t("No maintenance windows")}
          hint={t("Schedule windows when the controller should hold back automated work.")}/>
      )}
      {editing && <MaintModal initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refetch(); }}/>}
    </section>
  );
}

function MaintModal({ initial, onClose, onSaved }: any) {
  const { t } = useT();
  const [d, setD] = useState({ ...initial });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={initial.id ? t("Edit window") : t("Add window")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Name")} wide><input className="input w-full"
          value={d.name} onChange={e => setD({ ...d, name: e.target.value })}/></Field>
        <Field label={t("Starts at")}><input type="datetime-local" className="input w-full"
          value={d.starts_at} onChange={e => setD({ ...d, starts_at: e.target.value })}/></Field>
        <Field label={t("Ends at")}><input type="datetime-local" className="input w-full"
          value={d.ends_at} onChange={e => setD({ ...d, ends_at: e.target.value })}/></Field>
        <Field label={t("Cluster ID (blank=global)")} wide><input className="input w-full font-mono text-xs"
          value={d.cluster_id || ""} onChange={e => setD({ ...d, cluster_id: e.target.value || null })}/></Field>
        <Field label={t("Reason")} wide><input className="input w-full"
          value={d.reason} onChange={e => setD({ ...d, reason: e.target.value })}/></Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>{t("Cancel")}</button>
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
        }}>{t("Save")}</button>
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
