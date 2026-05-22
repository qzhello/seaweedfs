"use client";

// Volume Grow dialog. Pre-allocates N volumes for a collection.
//
// volume.grow is asynchronous at the master: the gRPC call returns
// immediately, master assigns new volume IDs to volume servers, and
// the new volumes only appear in the topology after the next heartbeat
// (typically a few seconds). The previous blocking version re-fetched
// the volume list immediately and often reported "0 added".
//
// This version uses the SSE stream endpoint which:
//   - echoes the constructed `weed shell -- volume.grow ...` command
//   - streams any shell stdout (rare; mostly error messages)
//   - polls the master after the shell exits and emits `progress`
//     events as new volumes appear (0/N → 1/N → 2/N)
//   - sends a `done` event with the final before/after/added counts
//
// Layout: form on the left, command preview + live progress + per-node
// before→after stacked bars on the right once a run starts.

import { useMemo, useState } from "react";
import { Plus, X, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { authHeaders, BASE, type Volume } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { ComboInput, NumberSlider, Field } from "@/components/form/smart-inputs";
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

const REPLICATION_PRESETS = ["", "000", "001", "010", "100", "002", "020", "200", "011", "110"];

interface GrowProgress {
  before: number;
  current: number;
  target: number;
  added: number;
}

interface GrowDone {
  ok: boolean;
  error?: string;
  before?: number;
  after?: number;
  added?: number;
  target?: number;
  duration_ms?: number;
}

export function VolumeGrowDialog({ clusterID, allVolumes, onClose, onDone }: Props) {
  const { t } = useT();

  const [collection, setCollection] = useState("");
  const [replication, setReplication] = useState("");
  const [dataCenter, setDataCenter] = useState("");
  const [rack, setRack] = useState("");
  const [count, setCount] = useState<number | "">(1);

  const [running, setRunning] = useState(false);
  const { probe, probing, runProbe } = usePreflightLockProbe(clusterID);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<GrowProgress | null>(null);
  const [done, setDone] = useState<GrowDone | null>(null);
  // Snapshot per-node counts when run starts; we re-fetch when the
  // SSE `done` event arrives and diff to render the per-node bar.
  const [snapshot, setSnapshot] = useState<{ before: Map<string, number>; after: Map<string, number> } | null>(null);

  const { collections, dataCenters, racks, currentByNode } = useMemo(() => {
    const cs = new Set<string>(), dcs = new Set<string>(), rs = new Set<string>();
    const m = new Map<string, number>();
    for (const v of allVolumes) {
      if (v.Collection) cs.add(v.Collection);
      if (v.DataCenter) dcs.add(v.DataCenter);
      if (v.Rack) rs.add(v.Rack);
      m.set(v.Server, (m.get(v.Server) ?? 0) + 1);
    }
    return {
      collections: [...cs].sort(),
      dataCenters: [...dcs].sort(),
      racks: [...rs].sort(),
      currentByNode: m,
    };
  }, [allVolumes]);

  const previewArgs = useMemo<string[]>(() => {
    const a: string[] = [];
    if (collection.trim()) a.push(`-collection=${collection.trim()}`);
    if (replication.trim()) a.push(`-replication=${replication.trim()}`);
    if (dataCenter.trim()) a.push(`-dataCenter=${dataCenter.trim()}`);
    if (rack.trim()) a.push(`-rack=${rack.trim()}`);
    if (typeof count === "number") a.push(`-count=${count}`);
    return a;
  }, [collection, replication, dataCenter, rack, count]);

  const canRun = collection.trim() !== "" && typeof count === "number" && count > 0 && !running;

  const run = async () => {
    if (!canRun) return;
    const ok = await runProbe(probe !== null);
    if (!ok) return;
    setErr(null);
    setLines([]);
    setProgress(null);
    setDone(null);
    setSnapshot(null);
    setRunning(true);
    const before = new Map(currentByNode);

    try {
      const resp = await fetch(`${BASE}/clusters/${clusterID}/volume/grow/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          collection: collection.trim(),
          replication: replication.trim() || undefined,
          data_center: dataCenter.trim() || undefined,
          rack: rack.trim() || undefined,
          count: count as number,
        }),
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        throw new Error(`${resp.status} ${text || resp.statusText}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done: bodyDone } = await reader.read();
        if (bodyDone) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          parseEvent(raw);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      toast.error("Volume grow failed", msg);
    } finally {
      // Always refresh the volume list after the stream ends, even on
      // error — a partial grow may have already created some volumes.
      onDone?.();
      try {
        const fresh = await fetch(`${BASE}/volumes?cluster_id=${encodeURIComponent(clusterID)}`,
          { credentials: "include", headers: authHeaders() }).then(r => r.json());
        const after = new Map<string, number>();
        for (const v of (fresh.items as Volume[] | undefined) || []) {
          after.set(v.Server, (after.get(v.Server) ?? 0) + 1);
        }
        setSnapshot({ before, after });
      } catch {
        // ignore; the KPI strip falls back to the done event's counts.
      }
      setRunning(false);
    }
  };

  function parseEvent(raw: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const ln of raw.split("\n")) {
      if (ln.startsWith("event: ")) event = ln.slice(7).trim();
      else if (ln.startsWith("data: ")) dataLines.push(ln.slice(6));
    }
    const data = dataLines.join("\n");
    if (event === "line") {
      setLines(prev => prev.length > 200 ? [...prev.slice(-180), data] : [...prev, data]);
      return;
    }
    if (event === "progress") {
      try { setProgress(JSON.parse(data) as GrowProgress); } catch {}
      return;
    }
    if (event === "done") {
      try { setDone(JSON.parse(data) as GrowDone); } catch {}
      return;
    }
  }

  const wideMode = running || done !== null;

  // KPI numbers prefer the done event when available, fall back to the
  // most-recent progress event, then to the snapshot diff. This means
  // the strip is always populated as soon as we have any signal.
  const kpiBefore = done?.before ?? progress?.before ?? null;
  const kpiAfter  = done?.after  ?? progress?.current ?? null;
  const kpiAdded  = done?.added  ?? progress?.added ?? 0;
  const kpiTarget = done?.target ?? progress?.target ?? null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${
          wideMode ? "max-w-5xl" : "max-w-2xl"
        } max-h-[92vh] flex flex-col shadow-soft transition-[max-width]`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
              <Plus size={14}/> {t("Volume Grow")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {t("Pre-allocate new volumes for a collection. The master picks placement.")}
            </p>
          </div>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className={`overflow-auto flex-1 ${
          wideMode ? "grid grid-cols-[minmax(0,1fr)_minmax(0,440px)] gap-5 px-5 py-4" : "px-5 py-4 space-y-4"
        }`}>
          {/* ── Form (left) ── */}
          <div className={`space-y-3 ${running ? "opacity-70 pointer-events-none" : ""}`}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={<>{t("Collection")}<span className="text-danger ml-0.5">*</span></>}
                hint={t("Pick from the cluster, or type a new collection name.")}>
                <ComboInput value={collection} onChange={setCollection} options={collections} placeholder="mybucket"/>
              </Field>
              <Field label={t("Replication")}
                hint={t("Three-digit string: DC/rack/node copies. Blank = master default.")}>
                <ComboInput value={replication} onChange={setReplication} options={REPLICATION_PRESETS} placeholder="000"/>
              </Field>
              <Field label={t("Data center")} hint={t("Limit placement to this DC. Blank = any.")}>
                <ComboInput value={dataCenter} onChange={setDataCenter} options={dataCenters}/>
              </Field>
              <Field label={t("Rack")} hint={t("Limit placement to this rack. Blank = any.")}>
                <ComboInput value={rack} onChange={setRack} options={racks}/>
              </Field>
              <div className="col-span-2">
                <Field label={<>{t("Count")}<span className="text-danger ml-0.5">*</span></>}
                  hint={t("How many new volumes to pre-allocate. 1–100.")}>
                  <NumberSlider value={count === "" ? 1 : count} onChange={setCount} min={1} max={100} step={1}/>
                </Field>
              </div>
            </div>

            {err && (
              <div className="text-sm text-danger inline-flex items-center gap-2">
                <AlertTriangle size={14}/> {err}
              </div>
            )}

            <CommandPreview command="volume.grow" args={previewArgs}/>
          </div>

          {/* ── Live progress (right, when running/done) ── */}
          {wideMode && (
            <div className="space-y-3 min-w-0">
              {/* KPI strip — drives operator's eye to the delta. While
                  the master is still propagating, the "Added" tile
                  ticks up live from each `progress` event. */}
              <div className="grid grid-cols-3 gap-2">
                <Kpi label={t("Before")}
                  value={kpiBefore != null ? String(kpiBefore) : "…"}
                  tone="muted"/>
                <Kpi label={t("After")}
                  value={kpiAfter != null ? String(kpiAfter) : "…"}
                  tone="text"
                  hint={kpiTarget != null ? `${t("target")} ${kpiTarget}` : undefined}/>
                <Kpi label={t("Added")}
                  value={String(kpiAdded)}
                  tone={kpiAdded > 0 ? "success" : "muted"}
                  prefix={kpiAdded > 0 ? "+" : ""}/>
              </div>

              {/* In-flight indicator. We stay on this until the master
                  echoes the expected target back via the polling
                  goroutine, so the operator knows the grow is
                  asynchronous and that we ARE waiting on master. */}
              {running && !done && (
                <div className="card p-3 text-sm inline-flex items-center gap-2 text-warning">
                  <Loader2 size={14} className="animate-spin"/>
                  {progress
                    ? t("Waiting for master to register volumes… {cur}/{tgt}")
                        .replace("{cur}", String(progress.current))
                        .replace("{tgt}", String(progress.target))
                    : t("Asking master to allocate new volumes…")}
                </div>
              )}

              {/* Final outcome banner. Success when added >= target;
                  partial when some arrived but not all (master may
                  still be heartbeating — encourage a manual refresh). */}
              {done && done.ok && (
                <div className={`p-3 rounded border ${
                  (done.added ?? 0) > 0
                    ? "border-success/40 bg-success/5"
                    : "border-warning/40 bg-warning/5"
                }`}>
                  {(done.added ?? 0) > 0 ? (
                    <div className="text-sm text-success inline-flex items-center gap-2">
                      <CheckCircle2 size={14}/>
                      {t("Allocated {n} volume(s).").replace("{n}", String(done.added))}
                    </div>
                  ) : (
                    <div className="text-sm text-warning">
                      {t("Master accepted volume.grow but no new volumes appeared within 20s. They may still arrive — refresh in a moment.")}
                    </div>
                  )}
                </div>
              )}

              {/* Shell output tail. volume.grow is normally silent but
                  any error / "collection not found" lands here. */}
              {(lines.length > 0 || running) && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
                    {t("Shell output")}
                  </div>
                  <pre className="font-mono text-[11px] p-2 rounded bg-bg border border-border overflow-auto max-h-[24vh] whitespace-pre-wrap break-all">
                    {lines.length === 0 ? t("(waiting for output…)") : lines.join("\n")}
                  </pre>
                </div>
              )}

              {/* Per-node before → after stacked bars. Renders once the
                  post-run snapshot is available; sorts changed rows to
                  the top so the operator sees where master placed
                  the new volumes. */}
              {snapshot && (
                <div className="card p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted">
                      {t("Per-node volume count")}
                    </div>
                    <div className="text-[11px] text-muted inline-flex items-center gap-2">
                      <LegendDot tone="muted"/>{t("Before")}
                      <LegendDot tone="success"/>{t("Added")}
                    </div>
                  </div>
                  <NodeDiffBars before={snapshot.before} after={snapshot.after}/>
                </div>
              )}
            </div>
          )}
        </div>

        <PreflightProbeBanner probe={probe}/>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
          {!running && (
            <button
              className={`btn btn-primary inline-flex items-center gap-1 ${canRun && !probing ? "" : "opacity-40 cursor-not-allowed"}`}
              onClick={run}
              disabled={!canRun || probing}>
              {probing ? <Loader2 size={12} className="animate-spin"/> : <Plus size={12}/>}
              {preflightButtonLabel(t, probe, probing, done ? t("Grow again") : t("Grow"))}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, prefix, hint }: {
  label: string; value: string; tone: "muted" | "text" | "success"; prefix?: string; hint?: string;
}) {
  const toneText =
    tone === "success" ? "text-success"
    : tone === "muted" ? "text-muted"
    : "text-text";
  const toneBorder =
    tone === "success" ? "border-success/40 bg-success/5"
    : "border-border/60 bg-bg/30";
  return (
    <div className={`p-2 rounded border ${toneBorder}`}>
      <div className={`text-lg font-semibold tabular-nums ${toneText}`}>
        {prefix}{value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
        {hint && <span className="ml-1 text-muted/70 normal-case tracking-normal">· {hint}</span>}
      </div>
    </div>
  );
}

function LegendDot({ tone }: { tone: "muted" | "success" }) {
  const bg = tone === "success" ? "bg-success" : "bg-muted/40";
  return <span className={`inline-block w-2 h-2 rounded-sm ${bg}`}/>;
}

function NodeDiffBars({ before, after }: {
  before: Map<string, number>;
  after: Map<string, number>;
}) {
  const { t } = useT();
  const nodes = new Set([...before.keys(), ...after.keys()]);
  const rows = [...nodes].map(n => {
    const b = before.get(n) ?? 0;
    const a = after.get(n) ?? 0;
    return { node: n, before: b, after: a, added: Math.max(0, a - b) };
  });
  const max = rows.reduce((m, r) => Math.max(m, r.after, r.before), 1);
  rows.sort((x, y) =>
    y.added - x.added
    || y.after - x.after
    || x.node.localeCompare(y.node));

  if (rows.length === 0) {
    return <div className="text-xs text-muted py-4 text-center">{t("No nodes reporting volumes.")}</div>;
  }
  return (
    <ul className="space-y-1 max-h-[24rem] overflow-auto">
      {rows.map(r => {
        const bPct = (r.before / max) * 100;
        const aPct = (r.added  / max) * 100;
        return (
          <li key={r.node} className="grid grid-cols-[minmax(0,180px)_1fr_auto] items-center gap-2 text-xs">
            <span className="font-mono truncate text-muted" title={r.node}>{r.node}</span>
            <div className="h-3 rounded-sm bg-bg/60 overflow-hidden flex">
              <div className="h-full bg-muted/40 transition-[width] duration-300" style={{ width: `${bPct}%` }}/>
              {r.added > 0 && (
                <div className="h-full bg-success transition-[width] duration-300" style={{ width: `${aPct}%` }}/>
              )}
            </div>
            <span className="font-mono tabular-nums text-[11px] whitespace-nowrap">
              <span className="text-muted">{r.before}</span>
              <span className="mx-1 text-muted/60">→</span>
              <span className={r.added > 0 ? "text-success font-semibold" : "text-text"}>{r.after}</span>
              {r.added > 0 && <span className="ml-1 text-success">+{r.added}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
