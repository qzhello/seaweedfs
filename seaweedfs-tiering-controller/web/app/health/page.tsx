"use client";
import { useMonitorTargets, useHealthGate, useHealthSamples, api } from "@/lib/api";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { EmptyState } from "@/components/empty-state";
import { Activity, Plus, Trash2, ShieldAlert, ShieldCheck, HelpCircle, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

const KINDS = ["http", "prometheus_query"];
const SEVERITIES = ["info", "warning", "critical"];

export default function HealthPage() {
  const { data: targetsData, mutate } = useMonitorTargets();
  const { data: gate } = useHealthGate();
  const [editing, setEditing] = useState<any | null>(null);
  const [openTarget, setOpenTarget] = useState<string | null>(null);

  const items = targetsData?.items || [];
  const blank = {
    name: "", kind: "http", url: "", query: "", threshold_op: "", threshold_value: null,
    severity: "warning", interval_sec: 30, timeout_sec: 5,
    fail_threshold: 3, recover_threshold: 3, gates_scheduler: true, enabled: true, notes: "",
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Activity size={20}/> Health Monitoring
        </h1>
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> Add target</button>
      </header>

      <section className={`card p-5 flex items-center gap-3 ${gate?.ok ? "" : "border-danger/40"}`}>
        {gate?.ok
          ? <span className="text-success flex items-center gap-2"><ShieldCheck size={18}/> Health gate: <strong>OPEN</strong></span>
          : <span className="text-danger flex items-center gap-2"><ShieldAlert size={18}/> Health gate: <strong>CLOSED</strong></span>}
        <span className="text-xs text-muted">
          {gate?.ok
            ? "Scheduler is allowed to start new migration tasks."
            : `Scheduler will refuse to start new tasks. Reason: ${gate?.reason || "unknown"}`}
        </span>
      </section>

      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr>
            <th>Name</th><th>Kind</th><th>State</th><th>Failures</th>
            <th>Latency</th><th>Last error</th><th>Gating</th><th>Last check</th><th></th>
          </tr></thead>
          <tbody>
            {items.map((it: any) => {
              const t = it.target, h = it.health;
              const expanded = openTarget === t.id;
              return (
                <>
                  <tr key={t.id}>
                    <td>
                      <button onClick={() => setOpenTarget(expanded ? null : t.id)} className="font-medium hover:text-accent text-left">
                        {t.name}
                      </button>
                      <div className="text-xs text-muted truncate max-w-[260px]" title={t.url}>{t.url}</div>
                    </td>
                    <td><span className="badge">{t.kind}</span></td>
                    <td><StateBadge state={h?.state}/></td>
                    <td className="font-mono text-xs">
                      {h?.consecutive_failures || 0}/{t.fail_threshold}
                    </td>
                    <td className="font-mono text-xs">{h?.last_latency_ms ?? "—"} ms</td>
                    <td className="text-xs text-muted max-w-[260px] truncate" title={h?.last_error}>{h?.last_error || "—"}</td>
                    <td>
                      {t.gates_scheduler
                        ? <span className="badge border-warning/40 text-warning">gates</span>
                        : <span className="badge">info</span>}
                    </td>
                    <td className="text-muted text-xs">{h?.updated_at ? relTime(h.updated_at) : "—"}</td>
                    <td className="text-right space-x-1">
                      <button className="btn" onClick={() => setEditing({ ...t })}>Edit</button>
                      <button className="btn btn-danger" onClick={async () => {
                        if (confirm(`Delete target ${t.name}?`)) {
                          await api.deleteMonitorTarget(t.id); mutate();
                        }
                      }}><Trash2 size={12}/></button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr><td colSpan={9} className="bg-panel2/40 p-4">
                      <Sparkline targetId={t.id}/>
                    </td></tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={Activity} title="No monitor targets" hint="Probes hit master / volume / s3 endpoints and gate tiering when they fail."/>}
      </section>

      {editing && <EditModal initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); mutate(); }}/>}
    </div>
  );
}

function StateBadge({ state }: { state?: string }) {
  if (state === "healthy") return <span className="badge border-success/40 text-success"><ShieldCheck size={10}/> healthy</span>;
  if (state === "degraded") return <span className="badge border-danger/40 text-danger"><ShieldAlert size={10}/> degraded</span>;
  return <span className="badge"><HelpCircle size={10}/> {state || "unknown"}</span>;
}

function Sparkline({ targetId }: { targetId: string }) {
  const { data } = useHealthSamples(targetId);
  const items = data?.items || [];
  const xs = items.map((s: any) => new Date(s.sample_at).toLocaleTimeString());
  const lat = items.map((s: any) => s.latency_ms);
  const ok = items.map((s: any) => (s.ok ? 1 : 0));
  return (
    <ReactECharts style={{ height: 180 }} option={{
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" },
      legend: { data: ["latency_ms", "ok"], textStyle: { color: C.textMuted } },
      grid: { top: 30, left: 50, right: 30, bottom: 30 },
      xAxis: { type: "category", data: xs, axisLabel: { color: C.textMuted, fontSize: 10 } },
      yAxis: [
        { type: "value", name: "ms", axisLabel: { color: C.textMuted }, splitLine: { lineStyle: { color: "#222" } } },
        { type: "value", min: 0, max: 1, axisLabel: { color: C.textMuted }, splitLine: { show: false } },
      ],
      series: [
        { name: "latency_ms", type: "line", smooth: true, data: lat, lineStyle: { color: "oklch(74% 0.18 230)", width: 2 } },
        { name: "ok",        type: "bar",  yAxisIndex: 1, data: ok, itemStyle: { color: (p: any) => p.value ? "oklch(76% 0.18 150)" : "oklch(68% 0.22 20)" } },
      ],
    }}/>
  );
}

function EditModal({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="card p-6 w-[640px] max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-medium mb-4">{initial.id ? "Edit target" : "Add target"}</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input w-full" value={d.name}
            onChange={e => setD({ ...d, name: e.target.value })}/></Field>
          <Field label="Kind"><select className="input w-full" value={d.kind}
            onChange={e => setD({ ...d, kind: e.target.value })}>
            {KINDS.map(k => <option key={k}>{k}</option>)}
          </select></Field>

          <Field label="URL" wide><input className="input w-full font-mono text-xs"
            value={d.url} onChange={e => setD({ ...d, url: e.target.value })}/></Field>

          {d.kind === "prometheus_query" && (
            <>
              <Field label="PromQL query" wide><input className="input w-full font-mono text-xs"
                placeholder="up{job=&quot;node&quot;} == 1"
                value={d.query} onChange={e => setD({ ...d, query: e.target.value })}/></Field>
              <Field label="Threshold op"><select className="input w-full" value={d.threshold_op}
                onChange={e => setD({ ...d, threshold_op: e.target.value })}>
                <option value="">—</option>
                {[">", "<", ">=", "<=", "==", "!="].map(o => <option key={o}>{o}</option>)}
              </select></Field>
              <Field label="Threshold value"><input type="number" className="input w-full" step="any"
                value={d.threshold_value ?? ""} onChange={e => setD({ ...d, threshold_value: e.target.value === "" ? null : Number(e.target.value) })}/></Field>
            </>
          )}

          <Field label="Severity"><select className="input w-full" value={d.severity}
            onChange={e => setD({ ...d, severity: e.target.value })}>
            {SEVERITIES.map(s => <option key={s}>{s}</option>)}
          </select></Field>
          <Field label="Interval (s)"><input type="number" className="input w-full" min={5}
            value={d.interval_sec} onChange={e => setD({ ...d, interval_sec: Number(e.target.value) })}/></Field>
          <Field label="Timeout (s)"><input type="number" className="input w-full" min={1}
            value={d.timeout_sec} onChange={e => setD({ ...d, timeout_sec: Number(e.target.value) })}/></Field>
          <Field label="Fail threshold"><input type="number" className="input w-full" min={1}
            value={d.fail_threshold} onChange={e => setD({ ...d, fail_threshold: Number(e.target.value) })}/></Field>
          <Field label="Recover threshold"><input type="number" className="input w-full" min={1}
            value={d.recover_threshold} onChange={e => setD({ ...d, recover_threshold: Number(e.target.value) })}/></Field>

          <Field label="Notes" wide><input className="input w-full" value={d.notes}
            onChange={e => setD({ ...d, notes: e.target.value })}/></Field>

          <div className="flex items-center gap-4 col-span-2 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={d.gates_scheduler}
              onChange={e => setD({ ...d, gates_scheduler: e.target.checked })}/>
              Gates scheduler
              <span title="When ON, this target's degraded state will pause the scheduler.">
                <AlertTriangle size={12} className="text-warning"/>
              </span>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={d.enabled}
              onChange={e => setD({ ...d, enabled: e.target.checked })}/> Enabled</label>
          </div>
        </div>
        {err && <div className="text-danger text-sm mt-3">{err}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={async () => {
            setSaving(true); setErr(null);
            try { await api.upsertMonitorTarget(d); onSaved(); }
            catch (e: any) { setErr(e.message); } finally { setSaving(false); }
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
    <span className="text-xs text-muted">{label}</span>{children}
  </label>;
}
