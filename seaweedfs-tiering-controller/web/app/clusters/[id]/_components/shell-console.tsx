"use client";

import { useState } from "react";
import { Terminal, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

const SHELL_PRESETS: { label: string; command: string; args: string; mutating: boolean; help: string }[] = [
  { label: "volume.list", command: "volume.list", args: "", mutating: false, help: "Dump all volumes per data-center / rack / node." },
  { label: "cluster.check", command: "cluster.check", args: "", mutating: false, help: "Master / volume server / filer reachability check." },
  { label: "cluster.ps", command: "cluster.ps", args: "", mutating: false, help: "List running shell sessions / locks." },
];

export function ShellConsole({ clusterId, binPath }: { clusterId: string; binPath?: string }) {
  const [preset, setPreset] = useState<typeof SHELL_PRESETS[number] | null>(null);
  const [args, setArgs] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const applyPreset = (nextPreset: typeof SHELL_PRESETS[number]) => {
    setPreset(nextPreset);
    setArgs(nextPreset.args);
    setError("");
    setSuccess("");
  };

  const run = async () => {
    if (!preset) return;
    setBusy(true);
    setOutput("");
    setError("");
    setSuccess("");
    try {
      const response = await api.runClusterShell(clusterId, { command: preset.command, args, reason });
      const data = response as { output?: string; error?: string };
      if (data?.error) setError(data.error);
      else if (data?.output) setOutput(data.output);
      else setSuccess("Command completed successfully with no output.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5">
      <header className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Terminal size={14}/> Shell console
          <span className="text-xs text-muted font-normal">- allowlisted weed shell commands</span>
        </h2>
        <span className="text-[11px] text-muted font-mono truncate max-w-[280px]" title={binPath || "global"}>
          weed: {binPath || "global"}
        </span>
      </header>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {SHELL_PRESETS.map((item) => (
          <button
            key={item.label}
            onClick={() => applyPreset(item)}
            className={`text-xs px-2 py-1 rounded-md border transition-colors ${preset?.label === item.label ? "bg-accent/15 border-accent/40 text-accent" : item.mutating ? "border-warning/30 text-warning hover:bg-warning/5" : "border-border text-muted hover:text-text"}`}
            title={item.help}
          >
            {item.label}
          </button>
        ))}
      </div>

      {preset && (
        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-xs text-muted">{preset.help}</p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Args (verbatim, passed after the command name)</span>
              <input className="input w-full font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)}/>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Reason {preset.mutating && <span className="text-warning">(required)</span>}</span>
              <input
                className="input w-full text-xs"
                placeholder="why is this run needed"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          <div className="font-mono text-xs bg-bg/60 border border-border rounded px-2 py-1.5 text-muted">
            $ weed shell -master={"<this cluster>"} : <span className="text-text">{preset.command} {args}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={run}>
              {busy ? <><Loader2 size={12} className="animate-spin"/> running...</> : "Run"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-danger border border-danger/30 bg-danger/5 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-3 text-xs text-success border border-success/30 bg-success/5 rounded px-2 py-1.5">
          {success}
        </div>
      )}
      {output && (
        <pre className="mt-3 font-mono text-[11px] bg-bg/60 border border-border rounded p-3 whitespace-pre-wrap max-h-[420px] overflow-auto">{output}</pre>
      )}
    </section>
  );
}
