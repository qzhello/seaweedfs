"use client";

// S3 Circuit Breaker — thin form over `s3.circuitBreaker`. The shell
// command supports enable/disable globally and per-bucket thresholds
// (type=Count|MB and value=threshold). We keep the UI simple:
// enable/disable toggle + a "list current settings" action +
// optional set-threshold form.

import { useState } from "react";
import { Zap, Loader2, AlertTriangle, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";

const TYPES = ["Count", "MB"];

export default function Page() {
  const { t } = useT();
  return (
    <Can cap="s3.circuit-breaker" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [type, setType] = useState("Count");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async (action: string, body: { action: string; type?: string; value?: string }) => {
    setBusy(action); setError(""); setOutput("");
    try {
      const r = await api.s3CircuitBreaker(clusterID, body);
      setOutput(r.output || t("Done — command finished with no output."));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <Zap size={16}/> {t("S3 Circuit Breaker")}
        </h1>
        <p className="text-xs text-muted mt-1">{t("Throttles S3 requests when a bucket or the whole gateway hits the configured limit.")}</p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button className="card p-4 text-left hover:bg-panel2/50 transition" onClick={() => run("list", { action: "list" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("List current")}</div>
          <div className="text-sm">{t("Show what is configured right now.")}</div>
        </button>
        <button className="card p-4 text-left border-emerald-400/30 hover:bg-emerald-400/5 transition" onClick={() => run("enable", { action: "enable" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-emerald-300 mb-1">{t("Enable")}</div>
          <div className="text-sm">{t("Turn the circuit breaker on globally.")}</div>
        </button>
        <button className="card p-4 text-left border-rose-400/30 hover:bg-rose-400/5 transition" onClick={() => run("disable", { action: "disable" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-rose-300 mb-1">{t("Disable")}</div>
          <div className="text-sm">{t("Turn it off. Use only when you know why.")}</div>
        </button>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium">{t("Set a threshold")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Type")}</label>
            <select className="select w-full" value={type} onChange={e => setType(e.target.value)}>
              {TYPES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Value")} <span className="text-rose-400">*</span></label>
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="1000" className="input w-full font-mono"/>
          </div>
          <div className="flex items-end">
            <button className="btn w-full inline-flex items-center justify-center gap-1.5 bg-accent/15 text-accent border-accent/40"
                    onClick={() => run("set", { action: "set", type, value })} disabled={!!busy || !value.trim()}>
              {busy === "set" ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} {t("Apply")}
            </button>
          </div>
        </div>
      </section>

      {error && <div className="card p-3 text-xs text-rose-300 border-rose-400/30 bg-rose-400/10 inline-flex items-center gap-2"><AlertTriangle size={14}/> {error}</div>}
      {output && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{output}</pre>
        </section>
      )}
    </div>
  );
}
