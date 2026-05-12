"use client";

// volumeServer.leave — gracefully drain a volume server before
// maintenance. The page lists nodes that currently hold volumes (from
// /volumes data) with their counts so the operator can see at a glance
// what they're about to migrate off.

import { useMemo, useState } from "react";
import { LogOut, Loader2, AlertTriangle, Play } from "lucide-react";
import { api, useVolumes, type Volume } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

export default function LeavePage() {
  const { t } = useT();
  return (
    <Can cap="cluster.volume-server.leave" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: vd } = useVolumes(clusterID);
  const [node, setNode] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState("");
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  // Build per-node {count, bytes} aggregate so the operator sees the
  // cost of draining each server before they pick one.
  const nodes = useMemo(() => {
    const m = new Map<string, { count: number; bytes: number; rack?: string }>();
    for (const v of (vd?.items as Volume[] | undefined) || []) {
      const e = m.get(v.Server);
      if (e) { e.count++; e.bytes += Number(v.Size) || 0; }
      else m.set(v.Server, { count: 1, bytes: Number(v.Size) || 0, rack: v.Rack });
    }
    return [...m.entries()].map(([server, info]) => ({ server, ...info })).sort((a, b) => b.count - a.count);
  }, [vd]);

  const run = async () => {
    if (!node.trim()) return;
    if (!confirm(t("Drain {node}? Volumes will migrate to other servers.").replace("{node}", node))) return;
    setBusy(true); setError(""); setOut("");
    try {
      const r = await api.clusterVolumeServerLeave(clusterID, { node: node.trim(), force });
      setOut(r.output || t("Done — command finished with no output."));
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
          <LogOut size={16}/> {t("Drain a volume server")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Run volumeServer.leave so the master migrates volumes off the node before you take it offline.")}</p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-4">
        <div className="card p-4 space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Node (host:port)")} <span className="text-rose-400">*</span></label>
            <input value={node} onChange={e => setNode(e.target.value)} placeholder="10.0.0.5:8080" className="input w-full font-mono"/>
          </div>
          <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="accent-accent"/>
            <span>{t("Force (don't wait for replicas to catch up)")}</span>
          </label>
          <button className="btn w-full inline-flex items-center justify-center gap-1.5 bg-rose-400/15 text-rose-300 border-rose-400/40" onClick={run} disabled={busy || !node.trim()}>
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} {t("Start drain")}
          </button>
          {error && <div className="text-xs text-rose-300 inline-flex items-center gap-1"><AlertTriangle size={12}/> {error}</div>}
        </div>

        <div className="card overflow-hidden">
          <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted">
            {t("Click a node to drain it")}
          </header>
          <div className="max-h-[28rem] overflow-auto">
            {nodes.length === 0 ? <div className="p-8 text-center text-sm text-muted">{t("No data.")}</div> : (
              <table className="grid w-full text-xs">
                <thead><tr><th className="text-left">{t("Server")}</th><th className="text-left">{t("Rack")}</th><th className="text-right">{t("Volumes")}</th><th className="text-right">{t("Bytes")}</th></tr></thead>
                <tbody>
                  {nodes.map(n => (
                    <tr key={n.server} className={`cursor-pointer hover:bg-panel2/50 ${node === n.server ? "bg-accent/10" : ""}`} onClick={() => setNode(n.server)}>
                      <td className="font-mono">{n.server}</td>
                      <td>{n.rack || "—"}</td>
                      <td className="text-right tabular-nums">{n.count}</td>
                      <td className="text-right tabular-nums">{fmtBytes(n.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {out && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{out}</pre>
        </section>
      )}
    </div>
  );
}

function fmtBytes(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
