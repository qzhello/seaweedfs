"use client";

// Volume Balance dialog. Wraps the full `weed shell volume.balance`
// flag set:
//
//   -collection   ALL_COLLECTIONS | EACH_COLLECTION | <name>
//   -dataCenter   DC filter
//   -racks        comma-separated rack list
//   -nodes        comma-separated host:port list
//   -writable     restrict to writable volumes only
//   -noLock       skip the shell's cluster-wide admin lock (risky)
//   -apply        actually execute moves
//
// Same dual-mode shape as fix-replication / ec.rebuild:
//   - dry-run = stream of "would move…" lines + parsed move list
//   - apply   = stream of actual moves as the master executes them
// Both modes use the same SSE endpoint pattern; the route's
// forceApply middleware decides which one runs.

import { useMemo, useState } from "react";
import { Scale, X, AlertTriangle, Play, Loader2, CheckCircle2, Sparkles } from "lucide-react";
import { authHeaders, BASE, type Volume, type BalanceRecommendation } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { BalanceAdvicePanel } from "@/components/volume/_balance-advice";
import { ComboInput, Field } from "@/components/form/smart-inputs";
import { CommandPreview } from "@/components/cli/command-preview";
import {
  usePreflightLockProbe, PreflightProbeBanner, preflightButtonLabel,
} from "@/components/preflight-lock-probe";

interface Props {
  clusterID: string;
  allVolumes: Volume[];
  // Pre-select a specific collection (e.g. when launched from the
  // /collections operations menu). Empty/undefined keeps the default
  // "all collections" behaviour.
  initialCollection?: string;
  onClose: () => void;
  onDone?: () => void;
}

interface Move {
  volume_id: number;
  from: string;
  to: string;
  collection?: string;
  size_mb?: number;
}

interface DoneEvent {
  ok: boolean;
  error?: string;
  duration_ms?: number;
  moves?: Move[];
  move_count?: number;
}


export function VolumeBalanceDialog({ clusterID, allVolumes, initialCollection, onClose, onDone }: Props) {
  const { t } = useT();

  // Collection defaults to empty — the shell treats absence of
  // `-collection` as ALL_COLLECTIONS, which is what most operators
  // actually want for a global balance. EACH_COLLECTION is offered
  // as a separate selectable for the power user case. When launched
  // from the /collections menu we pre-fill the clicked collection.
  const [collection, setCollection] = useState(initialCollection ?? "");
  const [dataCenter, setDataCenter] = useState("");
  // racks/nodes are multi-select chip lists (comma joined on submit).
  // Using a Set rather than free-text keeps the operator from typo'ing
  // a host:port format the shell won't recognise.
  const [racks, setRacks] = useState<Set<string>>(new Set());
  const [nodes, setNodes] = useState<Set<string>>(new Set());
  const [writable, setWritable] = useState(false);
  const [noLock, setNoLock] = useState(false);
  const [apply, setApply] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // Fill the form from an AI recommendation. The operator still has to
  // run the plan/apply themselves — this only seeds the controls.
  const applyAdvice = (rec: BalanceRecommendation) => {
    setCollection(rec.collection || "");
    setDataCenter(rec.data_center || "");
    setWritable(rec.writable);
    setAiOpen(false);
  };

  const [streamBody, setStreamBody] = useState<null | Record<string, unknown>>(null);
  const [streamApply, setStreamApply] = useState(false);
  const [running, setRunning] = useState(false);
  const { probe, probing, runProbe, reset: resetProbe } = usePreflightLockProbe(clusterID);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [doneEvent, setDoneEvent] = useState<DoneEvent | null>(null);

  const { collections, dataCenters, allRacks, allNodes } = useMemo(() => {
    const cs = new Set<string>(), dcs = new Set<string>(), rs = new Set<string>(), ns = new Set<string>();
    for (const v of allVolumes) {
      if (v.Collection) cs.add(v.Collection);
      if (v.DataCenter) dcs.add(v.DataCenter);
      if (v.Rack) rs.add(v.Rack);
      if (v.Server) ns.add(v.Server);
    }
    return {
      collections: [...cs].sort(),
      dataCenters: [...dcs].sort(),
      allRacks: [...rs].sort(),
      allNodes: [...ns].sort(),
    };
  }, [allVolumes]);

  const racksStr = useMemo(() => [...racks].join(","), [racks]);
  const nodesStr = useMemo(() => [...nodes].join(","), [nodes]);

  // Body uses the camelCase keys the backend expects (mirrors the Go
  // struct tags). Empty strings are dropped so the shell falls back
  // to its own defaults; `apply` flag is forced server-side by
  // forceApply middleware so we don't include it in the body.
  // Empty Collection = let the shell apply its own default
  // (ALL_COLLECTIONS). We omit the flag entirely in that case so the
  // command preview reflects what's actually executed.
  const buildBody = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    if (collection.trim()) b.collection = collection.trim();
    if (dataCenter.trim()) b.dataCenter = dataCenter.trim();
    if (racksStr) b.racks = racksStr;
    if (nodesStr) b.nodes = nodesStr;
    if (writable) b.writable = true;
    if (noLock) b.noLock = true;
    return b;
  };

  const previewArgs = useMemo<string[]>(() => {
    const a: string[] = [];
    if (collection.trim()) a.push(`-collection=${collection.trim()}`);
    if (dataCenter.trim()) a.push(`-dataCenter=${dataCenter.trim()}`);
    if (racksStr) a.push(`-racks=${racksStr}`);
    if (nodesStr) a.push(`-nodes=${nodesStr}`);
    if (writable) a.push("-writable");
    if (noLock) a.push("-noLock");
    if (apply) a.push("-apply");
    return a;
  }, [collection, dataCenter, racksStr, nodesStr, writable, noLock, apply]);

  const run = async () => {
    // Preflight only when this submit will actually take the shell
    // lock. Dry-runs (`apply=false`) on the plan/stream route bypass the
    // lock server-side, so probing them is wasted overhead.
    if (apply) {
      const ok = await runProbe(probe !== null);
      if (!ok) return;
    }
    setErr(null);
    setLines([]);
    setDoneEvent(null);
    setStreamApply(apply);
    const body = buildBody();
    setStreamBody(body);
    setRunning(true);

    const url = `${BASE}/clusters/${clusterID}/volume/balance/${apply ? "apply" : "plan"}/stream`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`${resp.status} ${txt || resp.statusText}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
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
      toast.error(apply ? "Balance apply failed" : "Balance plan failed", msg);
    } finally {
      setRunning(false);
      if (apply) onDone?.();
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
      setLines(prev => prev.length > 600 ? [...prev.slice(-500), data] : [...prev, data]);
      return;
    }
    if (event === "done") {
      try { setDoneEvent(JSON.parse(data) as DoneEvent); } catch { /* noop */ }
    }
  }

  const toggleSet = (set: Set<string>, value: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  };

  const wideMode = !!streamBody;
  const moves = doneEvent?.moves ?? [];

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${
          wideMode ? "max-w-6xl" : "max-w-2xl"
        } max-h-[92vh] flex flex-col shadow-soft transition-[max-width]`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
              <Scale size={14}/> {t("Volume Balance")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {t("Plan a redistribution of volumes across servers. Shows the moves the master would make.")}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn text-xs inline-flex items-center gap-1.5"
              onClick={() => setAiOpen(v => !v)}>
              <Sparkles size={13} className="text-accent"/> {t("AI advice")}
            </button>
            <button className="text-muted hover:text-text" onClick={onClose} aria-label={t("Close")}>
              <X size={16}/>
            </button>
          </div>
        </header>

        <div className={`overflow-auto flex-1 ${
          wideMode ? "grid grid-cols-[minmax(0,1fr)_minmax(0,440px)] gap-5 px-5 py-4" : "px-5 py-4 space-y-4"
        }`}>
          {/* ── Form (left) ── */}
          <div className={`space-y-3 ${running ? "opacity-70 pointer-events-none" : ""}`}>
            {aiOpen && (
              <BalanceAdvicePanel
                clusterID={clusterID}
                onApply={applyAdvice}
                onClose={() => setAiOpen(false)}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={t("Collection")}
                hint={t('Default = balance across all collections. EACH_COLLECTION = balance each one separately. Or pick a specific collection.')}>
                <select
                  className="select text-sm w-full"
                  value={collection}
                  onChange={e => setCollection(e.target.value)}>
                  <option value="">{t("(default — all collections)")}</option>
                  <option value="EACH_COLLECTION">{t("EACH_COLLECTION (per-collection)")}</option>
                  {collections.length > 0 && (
                    <optgroup label={t("Collections")}>
                      {collections.map(c => <option key={c} value={c}>{c}</option>)}
                    </optgroup>
                  )}
                </select>
              </Field>
              <Field
                label={t("Data center")}
                hint={t("Limit balancing to this DC. Blank = all DCs.")}>
                <ComboInput value={dataCenter} onChange={setDataCenter} options={dataCenters}/>
              </Field>
            </div>

            {/* Multi-select chips for racks + nodes. Each row toggles
                in/out; the joined comma string becomes the shell arg.
                Using chips (vs free text) makes it impossible to
                typo a host:port pair the shell won't recognise. */}
            <Field
              label={t("Racks")}
              hint={t("Click to toggle. Picks ≥1 means only balance volumes in those racks.")}>
              <ChipList
                values={allRacks}
                selected={racks}
                onToggle={v => toggleSet(racks, v, setRacks)}
                empty={t("(no racks reported)")}/>
            </Field>
            <Field
              label={t("Nodes")}
              hint={t("Click to toggle. Picks ≥1 means only balance volumes on those nodes.")}>
              <ChipList
                values={allNodes}
                selected={nodes}
                onToggle={v => toggleSet(nodes, v, setNodes)}
                empty={t("(no nodes reported)")}/>
            </Field>

            <div className="flex items-center gap-4 text-sm flex-wrap">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-accent"
                  checked={writable} onChange={e => setWritable(e.target.checked)}/>
                <span>{t("Writable only")}</span>
              </label>
              <label className={`inline-flex items-center gap-2 cursor-pointer ${noLock ? "text-warning" : ""}`}>
                <input type="checkbox" className="accent-warning"
                  checked={noLock} onChange={e => setNoLock(e.target.checked)}/>
                <span>{t("No-lock (skip admin shell lock)")}</span>
              </label>
            </div>

            <label className={`flex items-start gap-2 p-2.5 rounded border cursor-pointer transition-colors ${
              apply ? "border-warning/50 bg-warning/5" : "border-border/60 hover:border-border"
            }`}>
              <input type="checkbox" className="mt-0.5 accent-warning"
                checked={apply} onChange={e => { setApply(e.target.checked); resetProbe(); }}
                disabled={running}/>
              <div className="flex-1">
                <div className={`text-sm font-medium inline-flex items-center gap-1.5 ${apply ? "text-warning" : ""}`}>
                  {apply && <AlertTriangle size={12}/>}
                  {t("Apply (actually run)")}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {t("Unchecked = dry-run (plan only, no data is written). Checked = real run with live streaming progress.")}
                </div>
              </div>
            </label>

            {err && (
              <div className="text-sm text-danger inline-flex items-center gap-2">
                <AlertTriangle size={14}/> {err}
              </div>
            )}

            <CommandPreview command="volume.balance" args={previewArgs}/>
          </div>

          {/* ── Live progress (right, when running/done) ── */}
          {wideMode && (
            <div className="space-y-3 min-w-0">
              {/* Status banner */}
              {running ? (
                <div className="card p-3 text-sm inline-flex items-center gap-2 text-warning">
                  <Loader2 size={14} className="animate-spin"/>
                  {streamApply
                    ? t("Master is executing moves…")
                    : t("Master is calculating the balance plan…")}
                </div>
              ) : doneEvent && doneEvent.ok ? (
                <div className={`p-3 rounded border ${
                  (doneEvent.move_count ?? 0) > 0
                    ? "border-accent/40 bg-accent/5"
                    : "border-success/40 bg-success/5"
                }`}>
                  {(doneEvent.move_count ?? 0) === 0 ? (
                    <div className="text-sm text-success inline-flex items-center gap-2">
                      <CheckCircle2 size={14}/>
                      {t("Volumes are already balanced — no moves needed.")}
                    </div>
                  ) : (
                    <div className="text-sm text-accent inline-flex items-center gap-2">
                      <CheckCircle2 size={14}/>
                      {streamApply
                        ? t("{n} move(s) executed").replace("{n}", String(doneEvent.move_count))
                        : t("{n} move(s) planned").replace("{n}", String(doneEvent.move_count))}
                    </div>
                  )}
                </div>
              ) : null}

              {/* Parsed move list — only meaningful in dry-run (apply
                  prints noisier output and we don't re-parse mid-stream). */}
              {moves.length > 0 && !streamApply && (
                <div className="card p-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
                    {t("Planned moves")}
                  </div>
                  <ul className="text-[11px] font-mono space-y-0.5 max-h-[24rem] overflow-auto">
                    {moves.slice(0, 64).map((m, i) => (
                      <li key={`${m.volume_id}-${i}`}
                        className="grid grid-cols-[auto_1fr_auto_1fr] gap-1.5 items-center">
                        <span className="text-text">#{m.volume_id}</span>
                        <span className="text-muted truncate" title={m.from}>{m.from}</span>
                        <span className="text-accent">→</span>
                        <span className="text-text truncate" title={m.to}>{m.to}</span>
                      </li>
                    ))}
                    {moves.length > 64 && <li className="text-muted/70">… +{moves.length - 64}</li>}
                  </ul>
                </div>
              )}

              {/* Live stdout tail */}
              {(lines.length > 0 || running) && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
                    {t("Shell output")}
                  </div>
                  <pre className="font-mono text-[11px] p-2 rounded bg-bg border border-border overflow-auto max-h-[32vh] whitespace-pre-wrap break-all">
                    {lines.length === 0 ? t("(waiting for output…)") : lines.join("\n")}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {apply && <div className="px-5"><PreflightProbeBanner probe={probe}/></div>}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
          {!running && (
            <button
              className={`btn ${apply ? "btn-primary" : ""} inline-flex items-center gap-1`}
              disabled={probing}
              onClick={run}>
              {probing ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}
              {(() => {
                const def = doneEvent
                  ? (apply ? t("Re-run (apply)") : t("Re-run plan"))
                  : (apply ? t("Run (apply)") : t("Plan moves"));
                return apply ? preflightButtonLabel(t, probe, probing, def) : def;
              })()}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ChipList: a horizontal wrap of toggle-able pills used for the racks
// + nodes multi-select. Selected pills get the accent color so the
// operator can scan which filters are in effect at a glance.
function ChipList({
  values, selected, onToggle, empty,
}: {
  values: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  empty: string;
}) {
  if (values.length === 0) {
    return <div className="text-[11px] text-muted py-1">{empty}</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 max-h-32 overflow-auto p-1 rounded border border-border/60 bg-bg/40">
      {values.map(v => {
        const on = selected.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
              on
                ? "border-accent bg-accent/15 text-accent"
                : "border-border/60 bg-bg/40 text-muted hover:text-text hover:border-border"
            }`}>
            {v}
          </button>
        );
      })}
    </div>
  );
}
