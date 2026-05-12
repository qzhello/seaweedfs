"use client";

// Clean unfinished multipart uploads. The shell command takes a
// duration like "24h" / "7d" — anything older is aborted. We show
// presets for the common windows plus a custom input.

import { useState } from "react";
import { Eraser, Loader2, AlertTriangle, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

const PRESETS = ["1h", "24h", "72h", "168h"]; // 1h / 1d / 3d / 7d

export default function Page() {
  const { t } = useT();
  return (
    <Can cap="s3.clean-uploads" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [timeAgo, setTimeAgo] = useState("24h");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState("");
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async () => {
    if (!timeAgo.trim()) return;
    if (!confirm(t("Abort all multipart uploads older than {t}?").replace("{t}", timeAgo))) return;
    setBusy(true); setError(""); setOut("");
    try {
      const r = await api.s3CleanUploads(clusterID, timeAgo.trim());
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
          <Eraser size={16}/> {t("Clean S3 multipart uploads")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Abort multipart uploads older than the selected window. Frees the temporary parts.")}</p>
      </header>

      <section className="card p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button key={p}
                    onClick={() => setTimeAgo(p)}
                    className={`btn text-xs ${timeAgo === p ? "bg-accent/15 text-accent border-accent/40" : ""}`}>
              {p}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted">{t("Custom window (e.g. 24h, 7d)")}</label>
          <input value={timeAgo} onChange={e => setTimeAgo(e.target.value)} className="input w-48 font-mono"/>
        </div>
        <button className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40" onClick={run} disabled={busy || !timeAgo.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} {t("Run")}
        </button>
      </section>

      {error && <div className="card p-3 text-xs text-rose-300 border-rose-400/30 bg-rose-400/10 inline-flex items-center gap-2"><AlertTriangle size={14}/> {error}</div>}
      {out && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{out}</pre>
        </section>
      )}
    </div>
  );
}
