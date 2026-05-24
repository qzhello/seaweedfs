"use client";
import { useAlertChannels, useAlertRules, useAlertEvents, useAlertTemplates, api, type AlertTemplate } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/empty-state";
import { Bell, Plus, Trash2, TestTube2, AlertTriangle, CheckCircle2 , Send , ShieldAlert, FileText, Eye } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";

const KINDS = ["wecom_robot", "dingtalk_robot", "feishu_robot", "webhook"];
const SEVS = ["info", "warning", "critical"];
const EVENT_KINDS = ["*", "health.degraded", "health.recovered", "task.failed", "workflow.anomaly", "manual.test"];

export function AlertsPanel() {
  const { t } = useT();
  const { data: channels, mutate: refetchChannels, isValidating: chanValidating } = useAlertChannels();
  const { data: rules,    mutate: refetchRules, isValidating: ruleValidating } = useAlertRules();
  const { data: events, mutate: refetchEvents, isLoading: eventsLoading, isValidating: eventsValidating } = useAlertEvents();
  const { data: templates, mutate: refetchTemplates, isValidating: tplValidating } = useAlertTemplates();
  const [tab, setTab] = useState<"events"|"channels"|"rules"|"templates">("events");
  const [editingChan, setEditingChan] = useState<any | null>(null);
  const [editingRule, setEditingRule] = useState<any | null>(null);
  const [editingTpl, setEditingTpl] = useState<Partial<AlertTemplate> | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex gap-1 items-center text-sm">
          {(["events","channels","rules","templates"] as const).map(tabKey => (
            <button key={tabKey} className={`btn ${tab===tabKey?"btn-primary":""}`} onClick={() => setTab(tabKey)}>{t(tabKey)}</button>
          ))}
          <RefreshButton
            loading={
              tab === "events" ? eventsValidating
              : tab === "channels" ? chanValidating
              : tab === "rules" ? ruleValidating
              : tplValidating
            }
            onClick={() => {
              if (tab === "events") return refetchEvents();
              if (tab === "channels") return refetchChannels();
              if (tab === "rules") return refetchRules();
              return refetchTemplates();
            }}/>
        </div>
      </div>

      {tab === "events" && (
        <>
          <AITriageCard hasEvents={(events?.items?.length || 0) > 0}/>
          <EventsTab items={events?.items || []} loading={eventsLoading && !events}/>
        </>
      )}
      {tab === "channels" && (
        <ChannelsTab items={channels?.items || []}
          onEdit={(c: any) => setEditingChan(c)}
          onAdd={() => setEditingChan({ name: "", kind: "wecom_robot", config: {}, severities: ["warning","critical"], rate_per_hour: 60, enabled: true, notes: "" })}
          onDelete={async (id: string) => { await api.deleteAlertChannel(id); refetchChannels(); }}/>
      )}
      {tab === "rules" && (
        <RulesTab items={rules?.items || []} channels={channels?.items || []}
          onEdit={(r: any) => setEditingRule(r)}
          onAdd={() => setEditingRule({ name: "", event_kind: "health.degraded", source_match: "*", severity_min: "warning", channel_ids: [], silence_sec: 600, enabled: true })}
          onDelete={async (id: string) => { await api.deleteAlertRule(id); refetchRules(); }}/>
      )}

      {tab === "templates" && (
        <TemplatesTab items={templates?.items || []}
          onEdit={(tpl) => setEditingTpl(tpl)}
          onAdd={() => setEditingTpl({ name: "", description: "", title_tmpl: "", body_tmpl: "", severity: "warning" })}
          onDelete={async (id: string) => {
            try { await api.deleteAlertTemplate(id); toast.success(t("Deleted")); refetchTemplates(); }
            catch (e) { toast.fromError(e, t("Delete failed")); }
          }}/>
      )}

      {editingChan && <ChannelModal initial={editingChan} onClose={() => setEditingChan(null)} onSaved={() => { setEditingChan(null); refetchChannels(); }}/>}
      {editingRule && <RuleModal initial={editingRule} channels={channels?.items || []} onClose={() => setEditingRule(null)} onSaved={() => { setEditingRule(null); refetchRules(); }}/>}
      {editingTpl && <TemplateModal initial={editingTpl} onClose={() => setEditingTpl(null)} onSaved={() => { setEditingTpl(null); refetchTemplates(); }}/>}
    </div>
  );
}

// ---------- Alert template tab ----------

function TemplatesTab({
  items, onEdit, onAdd, onDelete,
}: {
  items: AlertTemplate[];
  onEdit: (t: AlertTemplate) => void;
  onAdd: () => void;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <div className="p-3 border-b border-border/40 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><FileText size={14}/> {t("Alert templates")}</h2>
          <p className="text-xs text-muted mt-0.5">
            {t("Reusable subject + body templates. Reference one from an Ops flow's alert config.")}
            {" "}{t("Supports Go template syntax — vars:")} <code className="font-mono">.Template .Cluster .Status .RunID .StepID .StepIndex .Error .When</code>
          </p>
        </div>
        <button className="btn btn-primary" onClick={onAdd}><Plus size={14}/> {t("New template")}</button>
      </div>
      {items.length === 0
        ? <EmptyState icon={FileText} title={t("No templates yet")} hint={t("Built-in defaults seed on first install. Create one to customise per-flow alert bodies.")}/>
        : <table className="grid">
            <thead><tr><th>{t("Name")}</th><th>{t("Description")}</th><th>{t("Severity")}</th><th>{t("Title preview")}</th><th></th></tr></thead>
            <tbody>
              {items.map((tpl) => (
                <tr key={tpl.id}>
                  <td className="font-mono text-xs">{tpl.name}</td>
                  <td className="text-xs text-muted truncate max-w-[260px]" title={tpl.description}>{tpl.description || "—"}</td>
                  <td><SevBadge s={tpl.severity}/></td>
                  <td className="text-xs truncate max-w-[260px]" title={tpl.title_tmpl}>{tpl.title_tmpl || "—"}</td>
                  <td>
                    <div className="flex gap-1 justify-end">
                      <button className="btn" onClick={() => onEdit(tpl)}>{t("Edit")}</button>
                      <button className="btn" onClick={() => onDelete(tpl.id)} title={t("Delete")}><Trash2 size={12}/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
    </section>
  );
}

function TemplateModal({
  initial, onClose, onSaved,
}: {
  initial: Partial<AlertTemplate>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<Partial<AlertTemplate>>(initial);
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!draft.name?.trim()) { toast.warn(t("Name required")); return; }
    setSaving(true);
    try {
      await api.upsertAlertTemplate(draft);
      toast.success(t("Saved"));
      onSaved();
    } catch (e) {
      toast.fromError(e, t("Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    try {
      const r = await api.previewAlertTemplate({
        title_tmpl: draft.title_tmpl || "",
        body_tmpl: draft.body_tmpl || "",
      }) as { title: string; body: string };
      setPreview(r);
    } catch (e) {
      toast.fromError(e, t("Preview failed"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="card max-w-3xl w-full mx-4 p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-3 flex items-center gap-1.5">
          <FileText size={16}/> {initial.id ? t("Edit alert template") : t("New alert template")}
        </h3>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-xs">{t("Name")}</span>
            <input className="input font-mono" value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-xs">{t("Description")}</span>
            <input className="input" value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })}/>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-xs">{t("Severity (default — flow config may override)")}</span>
            <select className="input" value={draft.severity || "warning"} onChange={(e) => setDraft({ ...draft, severity: e.target.value as AlertTemplate["severity"] })}>
              {SEVS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-xs">{t("Title template")} <span className="text-muted/60">{t("(Go text/template)")}</span></span>
            <input className="input font-mono text-xs" placeholder="[Flow {{.Status | upper}}] {{.Template}}"
              value={draft.title_tmpl || ""} onChange={(e) => setDraft({ ...draft, title_tmpl: e.target.value })}/>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-xs">{t("Body template")} <span className="text-muted/60">{t("(markdown + Go template)")}</span></span>
            <textarea className="input font-mono text-xs min-h-[140px]"
              placeholder={"Cluster: `{{.Cluster}}`\nRun: `{{.RunID}}`\nStep: `{{.StepID}}` (#{{.StepIndex}})\n\n{{if .Error}}Error:\n```\n{{.Error}}\n```{{end}}"}
              value={draft.body_tmpl || ""} onChange={(e) => setDraft({ ...draft, body_tmpl: e.target.value })}/>
          </label>
          <div className="flex gap-2">
            <button className="btn" onClick={runPreview}><Eye size={12}/> {t("Preview with sample vars")}</button>
          </div>
          {preview && (
            <section className="card p-3 bg-panel2 border-border/40">
              <div className="text-[10px] uppercase tracking-wide text-muted/70">{t("Title")}</div>
              <div className="font-mono text-xs mt-0.5 whitespace-pre-wrap">{preview.title || <span className="text-muted">{t("(empty)")}</span>}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted/70 mt-2">{t("Body")}</div>
              <div className="font-mono text-xs mt-0.5 whitespace-pre-wrap">{preview.body || <span className="text-muted">{t("(empty)")}</span>}</div>
            </section>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? t("Saving…") : t("Save")}</button>
        </div>
      </div>
    </div>
  );
}

// ---- AI triage card ----
//
// Operator clicks "Triage with AI", picks a window + severity floor + an
// optional steering question, gets back a narrative + storm / priority
// recommendations. Read-only — silencing or investigating happens via
// the existing rule editor / runbook flow, not from this card.

function AITriageCard({ hasEvents }: { hasEvents: boolean }) {
  const { t } = useT();
  const [open, setOpen]         = useState(false);
  const [hours, setHours]       = useState(24);
  const [sev, setSev]           = useState<"info" | "warning" | "critical">("warning");
  const [question, setQuestion] = useState("");
  const [loading, setLoading]   = useState(false);
  const [data, setData]         = useState<import("@/lib/api").AlertTriageResp | null>(null);

  if (!hasEvents) return null;

  const run = async () => {
    setLoading(true);
    try {
      const { alertTriage } = await import("@/lib/api");
      const r = await alertTriage({ hours, severity_min: sev, question: question.trim() || undefined });
      setData(r);
    } catch (e) {
      setData({ ok: false, hours, row_count: 0, error: e instanceof Error ? e.message : String(e) } as import("@/lib/api").AlertTriageResp);
    } finally {
      setLoading(false);
    }
  };

  const presets = [
    { label: t("Generic"),       q: "" },
    { label: t("Storms only"),   q: "focus on storm fingerprints; what should I silence first?" },
    { label: t("Criticals"),     q: "what critical events are unique and need investigation now?" },
    { label: t("Suppressions"),  q: "any fingerprints with high suppression count that might be hiding real issues?" },
  ];

  return (
    <section className="card mb-4">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <ShieldAlert size={14} className="text-warning"/>
          {t("AI alert triage")}
          <span className="text-[11px] font-normal text-muted">{t("Read-only summary — no auto-silence.")}</span>
        </span>
        <span className="text-xs text-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-divider p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="block text-muted">{t("Window (hours)")}</span>
              <input type="number" min={1} max={720} className="input w-24"
                     value={hours} onChange={e => setHours(Math.max(1, Math.min(720, Number(e.target.value) || 24)))} disabled={loading}/>
            </label>
            <label className="text-xs">
              <span className="block text-muted">{t("Severity floor")}</span>
              <select className="input" value={sev}
                      onChange={e => setSev(e.target.value as typeof sev)} disabled={loading}>
                {SEVS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-xs flex-1 min-w-[240px]">
              <span className="block text-muted">{t("Operator focus (optional)")}</span>
              <input className="input w-full" placeholder={t("e.g. focus on filer-3, group identity alerts")}
                     value={question} onChange={e => setQuestion(e.target.value)} disabled={loading}/>
            </label>
            <button className="btn inline-flex items-center gap-1.5" onClick={run} disabled={loading}>
              {loading ? "…" : <ShieldAlert size={12}/>} {loading ? t("Triaging…") : t("Triage with AI")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {presets.map(p => (
              <button key={p.label} className="badge text-[11px]"
                      onClick={() => { setQuestion(p.q); }} disabled={loading}>{p.label}</button>
            ))}
          </div>

          {data && <TriageResult data={data}/>}
        </div>
      )}
    </section>
  );
}

function TriageResult({ data }: { data: import("@/lib/api").AlertTriageResp }) {
  const { t } = useT();
  if (data.empty) {
    return <p className="text-xs text-muted">{t("No alert events in this window. Quiet is good.")}</p>;
  }
  if (!data.ok) {
    return <p className="rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger">{data.error || t("AI call failed.")}</p>;
  }
  const s = data.summary;
  if (!s) return null;
  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="text-sm font-medium">{s.headline}</div>
        <p className="mt-1 text-muted whitespace-pre-wrap">{s.narrative}</p>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
          <span>{t("Window")}: {data.hours}h</span>
          <span>·</span>
          <span>{t("Events")}: {data.row_count}</span>
          {data.truncated && <><span>·</span><span className="text-warning inline-flex items-center gap-1"><AlertTriangle size={10}/> {t("Older events truncated")}</span></>}
          {data.provider_name && <><span>·</span><span>{data.provider_name}</span></>}
        </div>
      </div>

      {s.storms.length > 0 && (
        <section>
          <div className="mb-1 font-medium text-warning">{t("Storm candidates")}</div>
          <ul className="space-y-1">
            {s.storms.map((x, i) => (
              <li key={i} className="rounded bg-panel2 p-2">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span>{x.event_kind} · {x.source}</span>
                  <span className="text-warning">×{x.count}</span>
                </div>
                <p className="mt-1 text-muted">{x.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.priorities.length > 0 && (
        <section>
          <div className="mb-1 font-medium text-danger">{t("Investigate first")}</div>
          <ul className="space-y-1">
            {s.priorities.map((x, i) => (
              <li key={i} className="rounded bg-panel2 p-2">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span>{x.event_kind} · {x.source}</span>
                  <SevBadge s={x.severity}/>
                </div>
                <p className="mt-1 text-muted">{x.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.facets && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted">{t("Show server-side facets")}</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <TriageFacet label={t("Severity")} rows={data.facets.by_severity}/>
            <TriageFacet label={t("Kind")}     rows={data.facets.by_kind}/>
            <TriageFacet label={t("Source")}   rows={data.facets.by_source}/>
          </div>
        </details>
      )}
    </div>
  );
}

function TriageFacet({ label, rows }: { label: string; rows: { key: string; count: number }[] }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <ul className="space-y-0.5">
        {rows.map(r => (
          <li key={r.key} className="flex items-center justify-between font-mono">
            <span className="truncate">{r.key || "—"}</span>
            <span className="text-muted">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventsTab({ items, loading }: { items: any[]; loading?: boolean }) {
  const { t } = useT();
  const pg = usePagination(items, 20);
  if (loading) {
    return (
      <section className="card overflow-hidden">
        <TableSkeleton rows={6} headers={[t("Time"), t("Kind"), t("Source"), t("Severity"), t("Title"), t("Delivered"), t("Suppressed")]}/>
      </section>
    );
  }
  return (
    <section className="card overflow-hidden">
      <table className="grid">
        <thead><tr><th>{t("Time")}</th><th>{t("Kind")}</th><th>{t("Source")}</th><th>{t("Severity")}</th><th>{t("Title")}</th><th>{t("Delivered")}</th><th>{t("Suppressed")}</th></tr></thead>
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
                    ? <span className="text-xs text-muted" title={e.suppressed_reason}>{t("yes")}</span>
                    : t("no")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && <EmptyState icon={Bell} title={t("No alert events yet")} hint={t("Recent triggers from monitoring rules will show up here.")}/>}
      {items.length > 0 && <Pagination {...pg}/>}
    </section>
  );
}

function ChannelsTab({ items, onEdit, onAdd, onDelete }: any) {
  const { t } = useT();
  const pg = usePagination<any>(items, 20);
  return (
    <>
      <div className="flex justify-end"><button className="btn btn-primary" onClick={onAdd}><Plus size={14}/> {t("Add channel")}</button></div>
      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr><th>{t("Name")}</th><th>{t("Kind")}</th><th>{t("Severities")}</th><th>{t("Rate/hr")}</th><th>{t("Enabled")}</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((c: any) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}<div className="text-xs text-muted">{c.notes}</div></td>
                <td><span className="badge">{c.kind}</span></td>
                <td className="text-xs">{(c.severities || []).join(", ")}</td>
                <td>{c.rate_per_hour}</td>
                <td>{c.enabled ? t("yes") : t("no")}</td>
                <td className="text-right space-x-1">
                  <TestButton channelName={c.name}/>
                  <button className="btn" onClick={() => onEdit(c)}>{t("Edit")}</button>
                  <button className="btn btn-danger" onClick={async () => {
                    if (await confirmDlg.danger({ title: t("Delete {name}?").replace("{name}", c.name) })) onDelete(c.id);
                  }}><Trash2 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={Send} title={t("No channels configured")} hint={t("Add a Slack / webhook / email destination so alerts have somewhere to go.")}/>}
        {items.length > 0 && <Pagination {...pg}/>}
      </section>
    </>
  );
}

function TestButton({ channelName }: { channelName: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        await api.testAlert({
          source: `manual:${channelName}`, severity: "warning",
          title: t("Test alert"), body: t("Triggered from console — please confirm receipt."),
        });
        alert(t("Test alert queued. Check the Events tab + your channel."));
      } finally { setBusy(false); }
    }}><TestTube2 size={12}/> {t("Test")}</button>
  );
}

function RulesTab({ items, channels, onEdit, onAdd, onDelete }: any) {
  const { t } = useT();
  const cn = new Map((channels || []).map((c: any) => [c.id, c.name]));
  const pg = usePagination<any>(items, 20);
  return (
    <>
      <div className="flex justify-end"><button className="btn btn-primary" onClick={onAdd}><Plus size={14}/> {t("Add rule")}</button></div>
      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr><th>{t("Name")}</th><th>{t("Event")}</th><th>{t("Source")}</th><th>{t("Min sev")}</th><th>{t("Channels")}</th><th>{t("Silence")}</th><th></th></tr></thead>
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
                  <button className="btn" onClick={() => onEdit(r)}>{t("Edit")}</button>
                  <button className="btn btn-danger" onClick={async () => {
                    if (await confirmDlg.danger({ title: t("Delete {name}?").replace("{name}", r.name) })) onDelete(r.id);
                  }}><Trash2 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={ShieldAlert} title={t("No alert rules yet")} hint={t("Rules turn metric thresholds into events sent to channels.")}/>}
        {items.length > 0 && <Pagination {...pg}/>}
      </section>
    </>
  );
}

function ChannelModal({ initial, onClose, onSaved }: any) {
  const { t } = useT();
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
    <Modal onClose={onClose} title={initial.id ? t("Edit channel") : t("Add channel")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Name")}><input className="input w-full" value={d.name} onChange={e => setD({...d, name: e.target.value})}/></Field>
        <Field label={t("Kind")}><select className="input w-full" value={d.kind} onChange={e => setD({...d, kind: e.target.value})}>
          {KINDS.map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label={t("Config (JSON)")} wide>
          <textarea className="input w-full font-mono text-xs h-32" placeholder={placeholder}
            value={d.config} onChange={e => setD({...d, config: e.target.value})}/>
        </Field>
        <Field label={t("Severities (comma)")}>
          <input className="input w-full" value={(d.severities || []).join(",")}
            onChange={e => setD({...d, severities: e.target.value.split(",").map(s => s.trim()).filter(Boolean)})}/>
        </Field>
        <Field label={t("Rate per hour (0=∞)")}><input type="number" className="input w-full" value={d.rate_per_hour}
          onChange={e => setD({...d, rate_per_hour: Number(e.target.value)})}/></Field>
        <Field label={t("Notes")} wide><input className="input w-full" value={d.notes || ""} onChange={e => setD({...d, notes: e.target.value})}/></Field>
        <label className="text-sm flex items-center gap-1 col-span-2"><input type="checkbox" checked={d.enabled}
          onChange={e => setD({...d, enabled: e.target.checked})}/> {t("Enabled")}</label>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>{t("Cancel")}</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          try {
            const cfg = JSON.parse(d.config || "{}");
            await api.upsertAlertChannel({ ...d, config: cfg });
            onSaved();
          } catch (e: any) { setErr(e.message); }
        }}>{t("Save")}</button>
      </div>
    </Modal>
  );
}

function RuleModal({ initial, channels, onClose, onSaved }: any) {
  const { t } = useT();
  const [d, setD] = useState({ ...initial });
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: string) => {
    const arr = d.channel_ids || [];
    setD({ ...d, channel_ids: arr.includes(id) ? arr.filter((x: string) => x !== id) : [...arr, id] });
  };
  return (
    <Modal onClose={onClose} title={initial.id ? t("Edit rule") : t("Add rule")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Name")}><input className="input w-full" value={d.name} onChange={e => setD({...d, name: e.target.value})}/></Field>
        <Field label={t("Event kind")}><select className="input w-full" value={d.event_kind} onChange={e => setD({...d, event_kind: e.target.value})}>
          {EVENT_KINDS.map(k => <option key={k}>{k}</option>)}
        </select></Field>
        <Field label={t("Source match (* = all)")}><input className="input w-full" value={d.source_match}
          onChange={e => setD({...d, source_match: e.target.value})}/></Field>
        <Field label={t("Min severity")}><select className="input w-full" value={d.severity_min}
          onChange={e => setD({...d, severity_min: e.target.value})}>
          {SEVS.map(s => <option key={s}>{s}</option>)}
        </select></Field>
        <Field label={t("Silence (s)")}><input type="number" className="input w-full" value={d.silence_sec}
          onChange={e => setD({...d, silence_sec: Number(e.target.value)})}/></Field>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={d.enabled}
          onChange={e => setD({...d, enabled: e.target.checked})}/> {t("Enabled")}</label>

        <Field label={t("Channels")} wide>
          <div className="flex flex-wrap gap-2">
            {channels.map((c: any) => (
              <button type="button" key={c.id}
                className={`btn ${(d.channel_ids || []).includes(c.id) ? "btn-primary" : ""}`}
                onClick={() => toggle(c.id)}>
                {c.name}
              </button>
            ))}
            {channels.length === 0 && <div className="text-xs text-muted">{t("No channels yet — create one first.")}</div>}
          </div>
        </Field>
      </div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={onClose}>{t("Cancel")}</button>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null);
          try { await api.upsertAlertRule(d); onSaved(); }
          catch (e: any) { setErr(e.message); }
        }}>{t("Save")}</button>
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
