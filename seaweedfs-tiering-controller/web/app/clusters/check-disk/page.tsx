"use client";

// Cluster disk check — runs `volume.check.disk` and renders the result
// as a table grouped by OK/issue. The scan can take minutes on a big
// cluster so the button shows a spinner and we cap server-side at 10m.

import { useMemo, useState } from "react";
import { HardDriveDownload, Loader2, AlertTriangle, CheckCircle2, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

type Row = { volume_id: number; server: string; ok: boolean; message?: string };

export default function CheckDiskPage() {
  const { t } = useT();
  return (
    <Can cap="volume.check-disk" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [volumeID, setVolumeID] = useState<string>("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async () => {
    setBusy(true); setError(""); setRows(null); setRaw("");
    try {
      const body: { volume_id?: number } = {};
      if (volumeID.trim()) body.volume_id = Number(volumeID.trim());
      const r = await api.clusterCheckDisk(clusterID, body);
      setRows(r.rows); setRaw(r.output);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Pre-split rows so we can show counts in the headers without
  // re-walking the array on every render.
  const { okRows, badRows } = useMemo(() => {
    const ok: Row[] = [], bad: Row[] = [];
    for (const r of rows || []) (r.ok ? ok : bad).push(r);
    return { okRows: ok, badRows: bad };
  }, [rows]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <HardDriveDownload size={16}/> {t("Cluster disk check")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("On-disk integrity scan. Leave volume id blank to check the whole cluster.")}</p>
      </header>

      <section className="card p-4 flex items-end gap-3 flex-wrap">
        <div className="space-y-1 min-w-[160px]">
          <label className="text-[11px] text-muted">{t("Volume id (optional)")}</label>
          <input value={volumeID} onChange={e => setVolumeID(e.target.value)} placeholder="(all)" className="input w-full"/>
        </div>
        <button className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} {t("Run check")}
        </button>
        {busy && <span className="text-xs text-muted">{t("This may take several minutes on a large cluster.")}</span>}
      </section>

      {error && (
        <div className="card p-3 text-xs text-rose-300 border-rose-400/30 bg-rose-400/10 inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {error}
        </div>
      )}

      {rows !== null && (
        <>
          {badRows.length > 0 && (
            <section className="card overflow-hidden border-rose-400/30">
              <header className="px-4 py-2 border-b border-rose-400/20 bg-rose-400/5 text-xs font-medium uppercase tracking-wider text-rose-300 inline-flex items-center gap-2">
                <AlertTriangle size={12}/> {t("Issues")} · {badRows.length}
              </header>
              <RowsTable rows={badRows}/>
            </section>
          )}
          <section className="card overflow-hidden">
            <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted inline-flex items-center gap-2">
              <CheckCircle2 size={12} className="text-emerald-300"/> {t("OK")} · {okRows.length}
            </header>
            <RowsTable rows={okRows}/>
          </section>
          {raw && (
            <details className="card p-3 text-xs">
              <summary className="cursor-pointer text-muted">{t("Raw shell output")}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted max-h-72 overflow-auto">{raw}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function RowsTable({ rows }: { rows: Row[] }) {
  const { t } = useT();
  if (rows.length === 0) return <div className="p-6 text-center text-sm text-muted">—</div>;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="grid w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">{t("Volume")}</th>
            <th className="text-left">{t("Server")}</th>
            <th className="text-left">{t("Detail")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.volume_id}-${r.server}-${i}`}>
              <td className="font-mono">#{r.volume_id}</td>
              <td className="font-mono text-muted">{r.server}</td>
              <td className={r.ok ? "text-emerald-300" : "text-rose-300"}>
                {r.ok ? "ok" : (r.message || "issue")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
