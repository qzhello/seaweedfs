"use client";
import { useMonitorTargets, useHealthGate, useHealthSamples, api } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { chartColors as C, tooltipStyle, legendStyle } from "@/lib/chart-theme";
import { EmptyState } from "@/components/empty-state";
import { Activity, Plus, Trash2, ShieldAlert, ShieldCheck, HelpCircle, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { relTime } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

const KINDS = ["http", "prometheus_query"];
const SEVERITIES = ["info", "warning", "critical"];

export function HealthPanel() {
  const { t } = useT();
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
      <div className="flex items-center justify-end">
        <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={14}/> {t("Add target")}</button>
      </div>

      <section className={`card p-5 flex items-center gap-3 ${gate?.ok ? "" : "border-danger/40"}`}>
        {gate?.ok
          ? <span className="text-success flex items-center gap-2"><ShieldCheck size={18}/> {t("Health gate:")} <strong>{t("OPEN")}</strong></span>
          : <span className="text-danger flex items-center gap-2"><ShieldAlert size={18}/> {t("Health gate:")} <strong>{t("CLOSED")}</strong></span>}
        <span className="text-xs text-muted">
          {gate?.ok
            ? t("Scheduler is allowed to start new migration tasks.")
            : t("Scheduler will refuse to start new tasks. Reason: {reason}").replace("{reason}", gate?.reason || t("unknown"))}
        </span>
      </section>

      <section className="card overflow-hidden">
        <table className="grid">
          <thead><tr>
            <th>{t("Name")}</th><th>{t("Kind")}</th><th>{t("State")}</th><th>{t("Failures")}</th>
            <th>{t("Latency")}</th><th>{t("Last error")}</th><th>{t("Gating")}</th><th>{t("Last check")}</th><th></th>
          </tr></thead>
          <tbody>
            {items.map((it: any) => {
              const tgt = it.target, h = it.health;
              const expanded = openTarget === tgt.id;
              return (
                <>
                  <tr key={tgt.id}>
                    <td>
                      <button onClick={() => setOpenTarget(expanded ? null : tgt.id)} className="font-medium hover:text-accent text-left">
                        {tgt.name}
                      </button>
                      <div className="text-xs text-muted truncate max-w-[260px]" title={tgt.url}>{tgt.url}</div>
                    </td>
                    <td><span className="badge">{tgt.kind}</span></td>
                    <td><StateBadge state={h?.state}/></td>
                    <td className="font-mono text-xs">
                      {h?.consecutive_failures || 0}/{tgt.fail_threshold}
                    </td>
                    <td className="font-mono text-xs">{h?.last_latency_ms ?? "—"} ms</td>
                    <td className="text-xs text-muted max-w-[260px] truncate" title={h?.last_error}>{h?.last_error || "—"}</td>
                    <td>
                      {tgt.gates_scheduler
                        ? <span className="badge border-warning/40 text-warning">{t("gates")}</span>
                        : <span className="badge">{t("info")}</span>}
                    </td>
                    <td className="text-muted text-xs">{h?.updated_at ? relTime(h.updated_at) : "—"}</td>
                    <td className="text-right space-x-1">
                      <button className="btn" onClick={() => setEditing({ ...tgt })}>{t("Edit")}</button>
                      <button className="btn btn-danger" onClick={async () => {
                        if (!(await confirmDlg.danger({ title: t("Delete target {name}?").replace("{name}", tgt.name) }))) return;
                        await api.deleteMonitorTarget(tgt.id); mutate();
                      }}><Trash2 size={12}/></button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr><td colSpan={9} className="bg-panel2/40 p-4">
                      <Sparkline targetId={tgt.id}/>
                    </td></tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={Activity} title={t("No monitor targets")} hint={t("Probes hit master / volume / s3 endpoints and gate tiering when they fail.")}/>}
      </section>

      {editing && <EditModal initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); mutate(); }}/>}
    </div>
  );
}

function StateBadge({ state }: { state?: string }) {
  const { t } = useT();
  if (state === "healthy") return <span className="badge border-success/40 text-success"><ShieldCheck size={10}/> {t("healthy")}</span>;
  if (state === "degraded") return <span className="badge border-danger/40 text-danger"><ShieldAlert size={10}/> {t("degraded")}</span>;
  return <span className="badge"><HelpCircle size={10}/> {state || t("unknown")}</span>;
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
        { name: "latency_ms", type: "line", smooth: true, data: lat, lineStyle: { color: "#3b9eff", width: 2 } },
        { name: "ok",        type: "bar",  yAxisIndex: 1, data: ok, itemStyle: { color: (p: any) => p.value ? "#22c55e" : "#ef4444" } },
      ],
    }}/>
  );
}

function EditModal({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [d, setD] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="card p-6 w-[640px] max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-medium mb-4">{initial.id ? t("Edit target") : t("Add target")}</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Name")}><input className="input w-full" value={d.name}
            onChange={e => setD({ ...d, name: e.target.value })}/></Field>
          <Field label={t("Kind")}><select className="input w-full" value={d.kind}
            onChange={e => setD({ ...d, kind: e.target.value })}>
            {KINDS.map(k => <option key={k}>{k}</option>)}
          </select></Field>

          <Field label={t("URL")} wide><input className="input w-full font-mono text-xs"
            value={d.url} onChange={e => setD({ ...d, url: e.target.value })}/></Field>

          {d.kind === "prometheus_query" && (
            <>
              <Field label={t("PromQL query")} wide><input className="input w-full font-mono text-xs"
                placeholder="up{job=&quot;node&quot;} == 1"
                value={d.query} onChange={e => setD({ ...d, query: e.target.value })}/></Field>
              <Field label={t("Threshold op")}><select className="input w-full" value={d.threshold_op}
                onChange={e => setD({ ...d, threshold_op: e.target.value })}>
                <option value="">—</option>
                {[">", "<", ">=", "<=", "==", "!="].map(o => <option key={o}>{o}</option>)}
              </select></Field>
              <Field label={t("Threshold value")}><input type="number" className="input w-full" step="any"
                value={d.threshold_value ?? ""} onChange={e => setD({ ...d, threshold_value: e.target.value === "" ? null : Number(e.target.value) })}/></Field>
            </>
          )}

          <Field label={t("Severity")}><select className="input w-full" value={d.severity}
            onChange={e => setD({ ...d, severity: e.target.value })}>
            {SEVERITIES.map(s => <option key={s}>{s}</option>)}
          </select></Field>
          <Field label={t("Interval (s)")}><input type="number" className="input w-full" min={5}
            value={d.interval_sec} onChange={e => setD({ ...d, interval_sec: Number(e.target.value) })}/></Field>
          <Field label={t("Timeout (s)")}><input type="number" className="input w-full" min={1}
            value={d.timeout_sec} onChange={e => setD({ ...d, timeout_sec: Number(e.target.value) })}/></Field>
          <Field label={t("Fail threshold")}><input type="number" className="input w-full" min={1}
            value={d.fail_threshold} onChange={e => setD({ ...d, fail_threshold: Number(e.target.value) })}/></Field>
          <Field label={t("Recover threshold")}><input type="number" className="input w-full" min={1}
            value={d.recover_threshold} onChange={e => setD({ ...d, recover_threshold: Number(e.target.value) })}/></Field>

          <Field label={t("Notes")} wide><input className="input w-full" value={d.notes}
            onChange={e => setD({ ...d, notes: e.target.value })}/></Field>

          <div className="flex items-center gap-4 col-span-2 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={d.gates_scheduler}
              onChange={e => setD({ ...d, gates_scheduler: e.target.checked })}/>
              {t("Gates scheduler")}
              <span title={t("When ON, this target's degraded state will pause the scheduler.")}>
                <AlertTriangle size={12} className="text-warning"/>
              </span>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={d.enabled}
              onChange={e => setD({ ...d, enabled: e.target.checked })}/> {t("Enabled")}</label>
          </div>
        </div>
        {err && <div className="text-danger text-sm mt-3">{err}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={async () => {
            setSaving(true); setErr(null);
            try { await api.upsertMonitorTarget(d); onSaved(); }
            catch (e: any) { setErr(e.message); } finally { setSaving(false); }
          }}>{t("Save")}</button>
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
