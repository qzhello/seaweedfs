"use client";

// Volume Grow — pre-allocate N volumes for a collection. Shows the
// current per-node volume count so the operator can pick a DC/rack
// that needs capacity.

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Plus, Loader2, AlertTriangle } from "lucide-react";
import { api, useVolumes } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { chartColors as C } from "@/lib/chart-theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export default function GrowPage() {
  const { t } = useT();
  return (
    <Can cap="volume.grow" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <GrowInner/>
    </Can>
  );
}

function GrowInner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: vd } = useVolumes(clusterID);

  const [form, setForm] = useState({ collection: "", replication: "", data_center: "", rack: "", count: 1 });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  // Collection drop-down values come from the existing volumes data —
  // anything else would be a phantom collection.
  const collections = useMemo(() => {
    const s = new Set<string>();
    for (const v of vd?.items || []) if (v.Collection) s.add(v.Collection);
    return [...s].sort();
  }, [vd]);

  const byNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vd?.items || []) m.set(v.Server, (m.get(v.Server) || 0) + 1);
    return m;
  }, [vd]);

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async () => {
    setBusy(true); setError(""); setResult("");
    try {
      const r = await api.volumeGrow(clusterID, form);
      setResult(r.output || t("Done — command finished with no output."));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <Plus size={16}/> {t("Volume Grow")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Pre-allocate new volumes for a collection. The master picks placement.")}</p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-4">
        <div className="card p-4 space-y-3">
          <Select label={t("Collection")} value={form.collection} onChange={v => setForm(s => ({ ...s, collection: v }))} options={["", ...collections]} required/>
          <Input  label={t("Replication (e.g. 001)")} value={form.replication} onChange={v => setForm(s => ({ ...s, replication: v }))} placeholder="000"/>
          <Input  label={t("Data center")} value={form.data_center} onChange={v => setForm(s => ({ ...s, data_center: v }))} placeholder="(any)"/>
          <Input  label={t("Rack")} value={form.rack} onChange={v => setForm(s => ({ ...s, rack: v }))} placeholder="(any)"/>
          <Input  label={t("Count")} type="number" value={String(form.count)} onChange={v => setForm(s => ({ ...s, count: Math.max(1, Math.min(100, Number(v) || 1)) }))}/>
          <button className="btn w-full inline-flex items-center justify-center gap-1.5 bg-accent/15 text-accent border-accent/40" onClick={run} disabled={busy || !form.collection}>
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Plus size={14}/>} {t("Grow")}
          </button>
          {error && <div className="text-xs text-rose-300 inline-flex items-center gap-1"><AlertTriangle size={12}/> {error}</div>}
        </div>

        <div className="card flex flex-col">
          <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted">
            {t("Per-node volume count (current)")}
          </header>
          {byNode.size === 0
            ? <div className="p-8 text-center text-sm text-muted">{t("No data.")}</div>
            : <ReactECharts style={{ height: 360 }} option={nodeBarOption(byNode)}/>}
        </div>
      </section>

      {result && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{result}</pre>
        </section>
      )}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="input w-full"/>
    </div>
  );
}

function Select({ label, value, onChange, options, required }: { label: string; value: string; onChange: (v: string) => void; options: string[]; required?: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}{required && <span className="text-rose-400 ml-1">*</span>}</label>
      <select className="select w-full" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o} value={o}>{o || "—"}</option>)}
      </select>
    </div>
  );
}

function nodeBarOption(byNode: Map<string, number>) {
  const nodes = [...byNode.entries()].sort((a, b) => b[1] - a[1]);
  return {
    backgroundColor: "transparent",
    grid: { left: 110, right: 12, top: 8, bottom: 8 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, textStyle: { color: C.text } },
    xAxis: { type: "value", axisLabel: { color: C.textMuted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
    yAxis: { type: "category", data: nodes.map(([n]) => n), inverse: true,
             axisLabel: { color: C.textMuted, fontSize: 11, formatter: (v: string) => v.length > 22 ? "…" + v.slice(-21) : v } },
    series: [{ type: "bar", data: nodes.map(([, n]) => n), itemStyle: { color: C.accent }, barMaxWidth: 14 }],
  };
}
