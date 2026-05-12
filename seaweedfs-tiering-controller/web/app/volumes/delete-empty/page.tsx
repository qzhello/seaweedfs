"use client";

// Delete empty volumes — finds size=0 replicas and lets the operator
// bulk-remove them. Source data is the existing /volumes endpoint;
// each row deletes one replica via POST /volume/delete-empty so the
// per-replica audit trail stays clean.

import { useMemo, useState } from "react";
import { Trash2, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api, useVolumes, type Volume } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

type RowStatus = "idle" | "running" | "done" | "error";

export default function DeleteEmptyPage() {
  const { t } = useT();
  return (
    <Can cap="volume.delete-empty" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: vd, mutate } = useVolumes(clusterID);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus]     = useState<Record<string, { state: RowStatus; msg?: string }>>({});
  const [running, setRunning]   = useState(false);

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const empties = useMemo<Volume[]>(
    () => ((vd?.items as Volume[] | undefined) || []).filter(v => Number(v.Size) === 0),
    [vd],
  );
  const keyOf = (v: Volume) => `${v.cluster_id || clusterID}:${v.ID}:${v.Server}`;
  const allChecked = empties.length > 0 && empties.every(v => selected.has(keyOf(v)));

  const toggleAll = () => setSelected(prev => {
    if (allChecked) return new Set();
    return new Set(empties.map(keyOf));
  });
  const toggle = (v: Volume) => setSelected(prev => {
    const next = new Set(prev); const k = keyOf(v);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const runOne = async (v: Volume) => {
    const k = keyOf(v);
    setStatus(s => ({ ...s, [k]: { state: "running" } }));
    try {
      await api.volumeDeleteEmpty(clusterID, { volume_id: Number(v.ID), node: v.Server });
      setStatus(s => ({ ...s, [k]: { state: "done" } }));
    } catch (e: unknown) {
      setStatus(s => ({ ...s, [k]: { state: "error", msg: (e as Error).message } }));
    }
  };

  const runBatch = async () => {
    if (selected.size === 0) return;
    if (!confirm(t("Delete {n} empty volume replicas?").replace("{n}", String(selected.size)))) return;
    setRunning(true);
    const rows = empties.filter(v => selected.has(keyOf(v)));
    // Serial to keep UI readable and avoid hammering the shell.
    for (const v of rows) await runOne(v);
    setRunning(false);
    await mutate();
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <Trash2 size={16}/> {t("Delete empty volumes")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Volumes with Size = 0. Each row deletes one replica on its server.")}</p>
      </header>

      <section className="card overflow-hidden">
        <header className="flex items-center justify-between px-4 py-2 border-b border-border/60">
          <div className="text-xs text-muted">
            {empties.length} {t("empty volume replicas")} · {selected.size} {t("selected")}
          </div>
          <button
            className="btn inline-flex items-center gap-1.5 bg-rose-400/15 text-rose-300 border-rose-400/40"
            onClick={runBatch} disabled={running || selected.size === 0}
          >
            {running ? <Loader2 size={14} className="animate-spin"/> : <Trash2 size={14}/>}
            {t("Delete selected")}
          </button>
        </header>
        {empties.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted">{t("No empty volumes — nothing to do.")}</div>
        ) : (
          <table className="grid w-full text-xs">
            <thead>
              <tr>
                <th className="text-left w-8">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-accent"/>
                </th>
                <th className="text-left">{t("Volume")}</th>
                <th className="text-left">{t("Server")}</th>
                <th className="text-left">{t("Collection")}</th>
                <th className="text-left">{t("Rack")}</th>
                <th className="text-left">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {empties.map(v => {
                const k = keyOf(v);
                const st = status[k]?.state || "idle";
                return (
                  <tr key={k} className={selected.has(k) ? "bg-panel2/40" : ""}>
                    <td><input type="checkbox" checked={selected.has(k)} onChange={() => toggle(v)} disabled={st === "running" || st === "done"} className="accent-accent"/></td>
                    <td className="font-mono">#{v.ID}</td>
                    <td className="font-mono text-muted">{v.Server}</td>
                    <td>{v.Collection || "—"}</td>
                    <td>{v.Rack || "—"}</td>
                    <td>
                      {st === "running" && <span className="inline-flex items-center gap-1 text-amber-300"><Loader2 size={12} className="animate-spin"/> {t("running")}</span>}
                      {st === "done"    && <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 size={12}/> {t("done")}</span>}
                      {st === "error"   && <span className="inline-flex items-center gap-1 text-rose-300" title={status[k]?.msg}><AlertTriangle size={12}/> {t("error")}</span>}
                      {st === "idle"    && <span className="text-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
