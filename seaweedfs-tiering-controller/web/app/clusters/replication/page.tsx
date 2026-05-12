"use client";

// Configure replication — `volume.configure.replication`.
// We aggregate the current per-collection replication policies from
// the existing /volumes endpoint (most useful read the operator
// already has) so the page shows the live state alongside the editor.

import { useMemo, useState } from "react";
import { Copy, Loader2, AlertTriangle, Save } from "lucide-react";
import { api, useVolumes, type Volume } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

const REPL_OPTIONS = ["000", "001", "010", "100", "011", "200", "020", "002"];

export default function ReplicationPage() {
  const { t } = useT();
  return (
    <Can cap="cluster.replication.configure" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: vd, mutate } = useVolumes(clusterID);
  const [form, setForm] = useState({ collection: "", replication: "001", volume_id: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  // Aggregate {collection → {volumeCount, sampleRack, sampleDC}}. We
  // don't know the per-collection replication policy directly from
  // /volumes (it isn't surfaced), but we can show volume count and
  // sample placement so the operator picks the right scope.
  const collections = useMemo(() => {
    const m = new Map<string, { count: number; sampleServer: string }>();
    for (const v of (vd?.items as Volume[] | undefined) || []) {
      const k = v.Collection || "(default)";
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { count: 1, sampleServer: v.Server });
    }
    return [...m.entries()].map(([name, info]) => ({ name, ...info })).sort((a, b) => b.count - a.count);
  }, [vd]);

  const run = async () => {
    setBusy(true); setError(""); setResult("");
    try {
      const body: { collection?: string; replication: string; volume_id?: number } = { replication: form.replication };
      if (form.collection) body.collection = form.collection;
      if (form.volume_id.trim()) body.volume_id = Number(form.volume_id.trim());
      const r = await api.clusterConfigureReplication(clusterID, body);
      setResult(r.output || t("Done — command finished with no output."));
      await mutate();
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
          <Copy size={16}/> {t("Configure replication")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Change replication for a whole collection or a single volume. Replication is a 3-digit code (dc rack node).")}</p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-4">
        <div className="card p-4 space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Collection")}</label>
            <select className="select w-full" value={form.collection} onChange={e => setForm(s => ({ ...s, collection: e.target.value }))}>
              <option value="">{t("(all)")}</option>
              {collections.map(c => <option key={c.name} value={c.name === "(default)" ? "" : c.name}>{c.name} · {c.count}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Replication")} <span className="text-rose-400">*</span></label>
            <select className="select w-full font-mono" value={form.replication} onChange={e => setForm(s => ({ ...s, replication: e.target.value }))}>
              {REPL_OPTIONS.map(r => <option key={r} value={r}>{r} — {replLabel(r)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Volume id (optional, narrows to one volume)")}</label>
            <input value={form.volume_id} onChange={e => setForm(s => ({ ...s, volume_id: e.target.value }))} placeholder="(whole collection)" className="input w-full"/>
          </div>
          <button className="btn w-full inline-flex items-center justify-center gap-1.5 bg-accent/15 text-accent border-accent/40" onClick={run} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>} {t("Apply")}
          </button>
          {error && <div className="text-xs text-rose-300 inline-flex items-center gap-1"><AlertTriangle size={12}/> {error}</div>}
        </div>

        <div className="card overflow-hidden">
          <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted">
            {t("Collections in this cluster")}
          </header>
          <div className="max-h-96 overflow-auto">
            {collections.length === 0
              ? <div className="p-6 text-center text-sm text-muted">{t("No data.")}</div>
              : (
                <table className="grid w-full text-xs">
                  <thead><tr><th className="text-left">{t("Collection")}</th><th className="text-right">{t("Volumes")}</th><th className="text-left">{t("Sample server")}</th></tr></thead>
                  <tbody>
                    {collections.map(c => (
                      <tr key={c.name} className="cursor-pointer hover:bg-panel2/50" onClick={() => setForm(s => ({ ...s, collection: c.name === "(default)" ? "" : c.name }))}>
                        <td>{c.name}</td>
                        <td className="text-right tabular-nums">{c.count}</td>
                        <td className="font-mono text-muted">{c.sampleServer}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
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

// Three digits = data centers / racks / extra nodes worth of replicas.
// Helper makes the dropdown self-explanatory instead of forcing the
// operator to recall the encoding.
function replLabel(code: string): string {
  const [dc, rack, node] = code.split("").map(Number);
  const parts: string[] = [];
  if (dc)   parts.push(`${dc} other DC`);
  if (rack) parts.push(`${rack} other rack`);
  if (node) parts.push(`${node} other node`);
  return parts.length ? parts.join(" + ") : "single replica";
}
