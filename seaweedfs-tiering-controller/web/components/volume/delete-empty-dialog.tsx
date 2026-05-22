"use client";

// Bulk-delete empty volume replicas. Source data is the existing
// volume list filtered to Size === 0. Each row maps to one shell
// invocation (`volume.delete -volumeId=N -node=host:port`), serialised
// so the per-replica audit stays clean.

import { useMemo, useState } from "react";
import { Trash2, X, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api, type Volume } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { CommandPreview } from "@/components/cli/command-preview";
import {
  usePreflightLockProbe, PreflightProbeBanner, preflightButtonLabel,
} from "@/components/preflight-lock-probe";

interface Props {
  clusterID: string;
  allVolumes: Volume[];
  onClose: () => void;
  onDone?: () => void;
}

type RowState = "idle" | "running" | "done" | "error";

export function VolumeDeleteEmptyDialog({ clusterID, allVolumes, onClose, onDone }: Props) {
  const { t } = useT();

  const empties = useMemo(
    () => allVolumes.filter(v => Number(v.Size) === 0),
    [allVolumes],
  );
  const keyOf = (v: Volume) => `${v.cluster_id || clusterID}:${v.ID}:${v.Server}`;

  const [selected, setSelected] = useState<Set<string>>(() => new Set(empties.map(keyOf)));
  const [status, setStatus] = useState<Record<string, { state: RowState; msg?: string }>>({});
  const [running, setRunning] = useState(false);
  const { probe, probing, runProbe } = usePreflightLockProbe(clusterID);
  const [confirmed, setConfirmed] = useState(false);

  const allChecked = empties.length > 0 && empties.every(v => selected.has(keyOf(v)));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(empties.map(keyOf)));
  };
  const toggle = (v: Volume) => {
    const k = keyOf(v);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const selectedRows = empties.filter(v => selected.has(keyOf(v)));
  const previewMulti = useMemo<string[][]>(
    () => selectedRows.map(v => [`-volumeId=${v.ID}`, `-node=${v.Server}`]),
    [selectedRows],
  );

  const counts = useMemo(() => {
    let d = 0, e = 0;
    Object.values(status).forEach(s => {
      if (s.state === "done") d++;
      if (s.state === "error") e++;
    });
    return { done: d, err: e };
  }, [status]);

  const submit = async () => {
    if (selectedRows.length === 0) return;
    const ok = await runProbe(probe !== null);
    if (!ok) return;
    setRunning(true);
    setStatus({});
    let okCount = 0;
    let errCount = 0;
    for (const v of selectedRows) {
      const k = keyOf(v);
      setStatus(s => ({ ...s, [k]: { state: "running" } }));
      try {
        await api.volumeDeleteEmpty(clusterID, { volume_id: Number(v.ID), node: v.Server });
        setStatus(s => ({ ...s, [k]: { state: "done" } }));
        okCount++;
      } catch (e) {
        const msg = (e as Error).message;
        setStatus(s => ({ ...s, [k]: { state: "error", msg } }));
        errCount++;
      }
    }
    setRunning(false);
    // One toast summarising the whole batch — less spammy than one
    // per replica, and accurate even when a few rows fail in the
    // middle of a long list.
    if (errCount === 0) {
      toast.success(`Deleted ${okCount} empty replica(s)`);
    } else if (okCount === 0) {
      toast.error(`Delete failed for all ${errCount} replica(s)`);
    } else {
      toast.warn(`Deleted ${okCount}, ${errCount} failed`);
    }
    onDone?.();
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="card bg-panel border border-border w-full max-w-4xl max-h-[92vh] flex flex-col shadow-soft"
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
              <Trash2 size={14}/> {t("Delete empty volumes")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {t("Volumes with Size = 0. Each row deletes one replica on its server.")}
            </p>
          </div>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className="overflow-auto flex-1 px-5 py-4 space-y-3">
          {empties.length === 0 ? (
            <div className="p-10 text-center text-sm text-success inline-flex items-center justify-center gap-2 w-full">
              <CheckCircle2 size={16}/> {t("No empty volumes — nothing to do.")}
            </div>
          ) : (
            <>
              <div className="text-xs text-muted">
                <span className="text-text font-semibold tabular-nums">{empties.length}</span>{" "}
                {t("empty volume replicas")} ·{" "}
                <span className="text-text font-semibold tabular-nums">{selected.size}</span>{" "}
                {t("selected")}
                {running && (
                  <> · <span className="text-success">{counts.done} {t("done")}</span></>
                )}
                {counts.err > 0 && (
                  <> · <span className="text-danger">{counts.err} {t("failed")}</span></>
                )}
              </div>

              <div className="card overflow-hidden">
                <table className="grid w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left w-8">
                        <input type="checkbox" checked={allChecked} onChange={toggleAll}
                          disabled={running} className="accent-accent"/>
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
                          <td>
                            <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(v)}
                              disabled={running || st === "done"} className="accent-accent"/>
                          </td>
                          <td className="font-mono">#{v.ID}</td>
                          <td className="font-mono text-muted">{v.Server}</td>
                          <td>{v.Collection || <span className="text-muted">—</span>}</td>
                          <td className="text-muted">{v.Rack || "—"}</td>
                          <td>
                            {st === "running" && (
                              <span className="inline-flex items-center gap-1 text-warning">
                                <Loader2 size={12} className="animate-spin"/> {t("running")}
                              </span>
                            )}
                            {st === "done" && (
                              <span className="inline-flex items-center gap-1 text-success">
                                <CheckCircle2 size={12}/> {t("done")}
                              </span>
                            )}
                            {st === "error" && (
                              <span className="inline-flex items-center gap-1 text-danger" title={status[k]?.msg}>
                                <AlertTriangle size={12}/> {t("error")}
                              </span>
                            )}
                            {st === "idle" && <span className="text-muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {selectedRows.length > 0 && (
                <CommandPreview command="volume.delete" args={[]} multi={previewMulti}/>
              )}

              {selectedRows.length > 0 && !running && counts.done === 0 && (
                <label className="flex items-start gap-2 p-2.5 rounded border border-danger/40 bg-danger/5 cursor-pointer">
                  <input type="checkbox" className="mt-0.5 accent-danger"
                    checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>
                  <div className="text-sm">
                    <div className="font-medium text-danger inline-flex items-center gap-1.5">
                      <AlertTriangle size={12}/>
                      {t("I confirm deletion of {n} empty replica(s).").replace("{n}", String(selectedRows.length))}
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {t("Empty replicas hold no data, but the operation is irreversible at the master level.")}
                    </div>
                  </div>
                </label>
              )}
            </>
          )}
        </div>

        <PreflightProbeBanner probe={probe}/>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
          {empties.length > 0 && (
            <button
              className={`btn inline-flex items-center gap-1 ${
                running || probing || !confirmed || selectedRows.length === 0
                  ? "opacity-40 cursor-not-allowed"
                  : "bg-danger/15 text-danger border-danger/40 hover:bg-danger/25"
              }`}
              onClick={submit}
              disabled={running || probing || !confirmed || selectedRows.length === 0}>
              {(running || probing) ? <Loader2 size={12} className="animate-spin"/> : <Trash2 size={12}/>}
              {preflightButtonLabel(t, probe, probing, t("Delete selected"))}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
