"use client";
import { useAlertChannels, useAlertRules, useAlertEvents, api } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { Bell, Plus, Trash2, TestTube2, AlertTriangle, CheckCircle2 , Send , ShieldAlert } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";

const KINDS = ["wecom_robot", "dingtalk_robot", "feishu_robot", "webhook"];
const SEVS = ["info", "warning", "critical"];
const EVENT_KINDS = ["*", "health.degraded", "health.recovered", "task.failed", "workflow.anomaly", "manual.test"];

export default function AlertsPage() {
  const { data: channels, mutate: refetchChannels, isValidating: chanValidating } = useAlertChannels();
  const { data: rules,    mutate: refetchRules, isValidating: ruleValidating } = useAlertRules();
  const { data: events, mutate: refetchEvents, isLoading: eventsLoading, isValidating: eventsValidating } = useAlertEvents();
  const [tab, setTab] = useState<"events"|"channels"|"rules">("events");
  const [editingChan, setEditingChan] = useState<any | null>(null);
  const [editingRule, setEditingRule] = useState<any | null>(null);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Bell size={20}/> Alerts</h1>
        <div className="flex gap-1 items-center text-sm">
          {(["events","channels","rules"] as const).map(t => (
            <button key={t} className={`btn ${tab===t?"btn-primary":""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          <RefreshButton
            loading={tab === "events" ? eventsValidating : tab === "channels" ? chanValidating : ruleValidating}
            onClick={() => tab === "events" ? refetchEvents() : tab === "channels" ? refetchChannels() : refetchRules()}/>
        </div>
      </header>

      {tab === "events" && <EventsTab items={events?.items || []} loading={eventsLoading && !events}/>}
      {tab === "channels" && (
        <ChannelsTab items={channels?.items || []}
          onEdit={(c) => setEditingChan(c)}
          onAdd={() => setEditingChan({ name: "", kind: "wecom_robot", config: {}, severities: ["warning","critical"], rate_per_hour: 60, enabled: true, notes: "" })}
          onDelete={async (id) => { await api.deleteAlertChannel(id); refetchChannels(); }}/>
      )}
      {tab === "rules" && (
        <RulesTab items={rules?.items || []} channels={channels?.items || []}
          onEdit={(r) => setEditingRule(r)}
          onAdd={() => setEditingRule({ name: "", event_kind: "health.degraded", source_match: "*", severity_min: "warning", channel_ids: [], silence_sec: 600, enabled: true })}
          onDelete={async (id) => { await api.deleteAlertRule(id); refetchRules(); }}/>
      )}

      {editingChan && <ChannelModal initial={editingChan} onClose={() => setEditingChan(null)} onSaved={() => { setEditingChan(null); refetchChannels(); }}/>}
      {editingRule && <RuleModal initial={editingRule} channels={channels?.items || []} onClose={() => setEditingRule(null)} onSaved={() => { setEditingRule(null); refetchRules(); }}/>}
    </div>
  );
}

function EventsTab({ items, loading }: { items: any[]; loading?: boolean }) {
  const pg = usePagination(items, 20);
  if (loading) {
    return (
      <section className="card overflow-hidden">
        <TableSkeleton rows={6} headers={["Time", "Kind", "Source", "Severity", "Title", "Delivered", "Suppressed"]}/>
      </section>
    );
  }
  return (
    <section className="card overflow-hidden">
      <table className="grid">
        <thead><tr><th>Time</th><th>Kind</th><th>Source</th><th>Severity</th><th>Title</th><th>Delivered</th><th>Suppressed</th></tr></thead>
        <tbody>
          {pg.slice.map((e: any) => {
            const dels = e.deliveries || [];
            return (
              <tr key={e.id}>
                <td className="text-muted text-xs">{relTime(e.fired_at)}</td>
                <td><span className="badge">{e.event_kind}</span></td>
                <td className="font-mono text-xs">{e.source}</td>
                <td><SevBadge s={e.severity}/></td>
                <td>
                  <div className="font-medium text-sm">{e.title}</div>
                  <div className="text-xs text-muted truncate max-w-[480px]" title={e.body}>{e.body}</div>
                </td>
                <td>
                  {Array.isArray(dels) && dels.length > 0
                    ? dels.map((d: any, i: number) => (
                        <span key={i} className={`badge mr-1 ${d.ok ? "border-success/40 text-success" : "border-danger/40 text-danger"}`}>
                          {d.ok ? <CheckCircle2 size={10}/> : <AlertTriangle size={10}/>} {d.channel}
                        </span>
                      ))
                    : <span className="text-xs text-muted">—</span>}
                </td>
                <td>
                  {e.suppressed
                    ? <span className="text-xs text-muted" title={e.suppressed_reason}>yes</span>
                    : "no"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && <EmptyState icon={Bell} title="No alert events yet" hint="Recent triggers from monitoring rules will show up here."/>}
      {items.length > 0 && <Pagination {...pg}/>}
    </section>
  );
}

function ChannelsTab({ items, onEdit, onAdd, onDelete }: any) {
  const pg = usePagination<any>(items, 20);
  return (
    <>
      <div className="flex justify-end"><button className="btn btn-primary" onClick={onAdd}><Plus size={14}/> Add channel</button></div>
      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr><th>Name</th><th>Kind</th><th>Severities</th><th>Rate/hr</th><th>Enabled</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((c: any) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}<div className="text-xs text-muted">{c.notes}</div></td>
                <td><span className="badge">{c.kind}</span></td>
                <td className="text-xs">{(c.severities || []).join(", ")}</td>
                <td>{c.rate_per_hour}</td>
                <td>{c.enabled ? "yes" : "no"}</td>
                <td className="text-right space-x-1">
                  <TestButton channelName={c.name}/>
                  <button className="btn" onClick={() => onEdit(c)}>Edit</button>
                  <button className="btn btn-danger" onClick={() => confirm(`Delete ${c.name}?`) && onDelete(c.id)}><Trash2 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={Send} title="No channels configured" hint="Add a Slack / webhook / email destination so alerts have somewhere to go."/>}
        {items.length > 0 && <Pagination {...pg}/>}
      </section>
    </>
  );
}

function TestButton({ channelName }: { channelName: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        await api.testAlert({
          source: `manual:${channelName}`, severity: "warning",
          title: "Test alert", body: "Triggered from console — please confirm receipt.",
        });
        alert("Test alert queued. Check the Events tab + your channel.");
      } finally { setBusy(false); }
    }}><TestTube2 size={12}/> Test</button>
  );
}

function RulesTab({ items, channels, onEdit, onAdd, onDelete }: any) {
  const cn = new Map((channels || []).map((c: any) => [c.id, c.name]));
  const pg = usePagination<any>(items, 20);
  return (
    <>
      <div className="flex justify-end"><button className="btn btn-primary" onClick={onAdd}><Plus size={14}/> Add rule</button></div>
      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr><th>Name</th><th>Event</th><th>Source</th><th>Min sev</th><th>Channels</th><th>Silence</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((r: any) => (
              <tr key={r.id}>
                <td className="font-medium">{r.name}</td>
                <td><span className="badge">{r.event_kind}</span></td>
                <td className="font-mono text-xs">{r.source_match}</td>
                <td><SevBadge s={r.severity_min}/></td>
                <td className="text-xs">{(r.channel_ids || []).map((id: string) => cn.get(id) || id.slice(0,4)).join(", ")}</td>
                <td>{r.silence_sec}s</td>
                <td className="text-right space-x-1">
                  <button className="btn" onClick={() => onEdit(r)}>Edit</button>
                  <button className="btn btn-danger" onClick={() => confirm(`Delete ${r.name}?`) && onDelete(r.id)}><Trash2 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={ShieldAlert} title="No alert rules yet" hint="Rules turn metric thresholds into events sent to channels."/>}
        {items.length > 0 && <Pagination {...pg}/>}
      </section>
    </>
  );
}

function ChannelModal({ initial, onClose, onSaved }: any) {
  const [d, setD] = useState({
    ...initial,
    config: typeof initial.config === "string" ? initial.config : JSON.stringify(initial.config || {}, null, 2),
  });
  const [err, setErr] = useState<string | null>(null);

  const placeholder = d.kind === "wecom_robot"
    ? `{\n  "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",\n  "mention_mobiles": ["13800138000"]\n}`
    : d.kind === "dingtalk_robot"
    ? `{\n  "webhook": "https://oapi.dingtalk.com/robot/send?access_token=..."\n}`
    : d.kind === "feishu_robot"
    ? `{\n  "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/..."\n}`
    : `{\n  "url": "https://example.com/webhook",\n  "headers": {"Authorization": "Bearer x"}\n}`;

  return (
    <Modal onClose={onClose} title={initial.id ? "Edit channel" : "Add channel"}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><input className="input w-full" value={d.name} onChange={e => setD({...d, name: e.target.value})}/></Field>
        <Field label="Kind"><select className="input w-full" value={d.kind} onChange={e => setD({...d, kind: e.target.value})}>
          {KINDS.map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label="Config (JSON)" wide>
          <textarea className="input w-full font-mono text-xs h-32" placeholder={placeholder}
            value={d.config} onChange={e => setD({...d, config: e.target.value})}/>
        </Field>
        <Field label="Severities (comma)">
          <input className="input w-full" value={(d.severities || []).join(",")}
            onChange={e => setD({...d, severities: e.target.value.split(",").map(s => s.trim()).filter(Boolean)})}/>
        </Field>
        <Field label="Rate per hour (0=∞)"><input type="number" className="input w-full" value={d.rate_per_hour}
          onChange={e => setD({...d, rate_per_hour: Number(e.target.value)})}/></Field>
        <Field label="Notes" wide><input className="input w-full" value={d.notes || ""} onChange={e => setD({...d, notes: e.target.value})}/></Field>
        <label className="text-sm flex items-center gap-1 col-span-2"><input type="checkbox" checked={d.enabled}
          onChange={e => setD({...d, enabled: e.target.checked})}/> Enabled</label>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          try {
            const cfg = JSON.parse(d.config || "{}");
            await api.upsertAlertChannel({ ...d, config: cfg });
            onSaved();
          } catch (e: any) { setErr(e.message); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

function RuleModal({ initial, channels, onClose, onSaved }: any) {
  const [d, setD] = useState({ ...initial });
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: string) => {
    const arr = d.channel_ids || [];
    setD({ ...d, channel_ids: arr.includes(id) ? arr.filter((x: string) => x !== id) : [...arr, id] });
  };
  return (
    <Modal onClose={onClose} title={initial.id ? "Edit rule" : "Add rule"}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><input className="input w-full" value={d.name} onChange={e => setD({...d, name: e.target.value})}/></Field>
        <Field label="Event kind"><select className="input w-full" value={d.event_kind} onChange={e => setD({...d, event_kind: e.target.value})}>
          {EVENT_KINDS.map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label="Source match (* = all)"><input className="input w-full" value={d.source_match}
          onChange={e => setD({...d, source_match: e.target.value})}/></Field>
        <Field label="Min severity"><select className="input w-full" value={d.severity_min}
          onChange={e => setD({...d, severity_min: e.target.value})}>
          {SEVS.map(s => <option key={s}>{s}</option>)}
        </select></Field>
        <Field label="Silence (s)"><input type="number" className="input w-full" value={d.silence_sec}
          onChange={e => setD({...d, silence_sec: Number(e.target.value)})}/></Field>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={d.enabled}
          onChange={e => setD({...d, enabled: e.target.checked})}/> Enabled</label>

        <Field label="Channels" wide>
          <div className="flex flex-wrap gap-2">
            {channels.map((c: any) => (
              <button type="button" key={c.id}
                className={`btn ${(d.channel_ids || []).includes(c.id) ? "btn-primary" : ""}`}
                onClick={() => toggle(c.id)}>
                {c.name}
              </button>
            ))}
            {channels.length === 0 && <div className="text-xs text-muted">No channels yet — create one first.</div>}
          </div>
        </Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          try { await api.upsertAlertRule(d); onSaved(); }
          catch (e: any) { setErr(e.message); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="card p-6 w-[680px] max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
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

function SevBadge({ s }: { s: string }) {
  const c = s === "critical" ? "border-danger/40 text-danger" : s === "warning" ? "border-warning/40 text-warning" : "border-muted text-muted";
  return <span className={`badge ${c}`}>{s}</span>;
}
