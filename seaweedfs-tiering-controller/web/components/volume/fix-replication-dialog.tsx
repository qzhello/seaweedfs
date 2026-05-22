"use client";

// Dialog for `volume.fix.replication`. Single-pane layout:
//   - left  : form (always editable until the run starts; locked while running)
//   - right : command preview + live SSE progress (always visible)
//
// Both dry-run and apply stream via SSE — the shell command sits silent
// for ~15s collecting topology, so a blocking JSON dry-run would feel
// frozen. The handler emits `line` events as stdout arrives and `done`
// carries the parsed summary so the dialog can render counts after exit.

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  usePreflightLockProbe, PreflightProbeBanner, preflightButtonLabel,
} from "@/components/preflight-lock-probe";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Play, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { ECProgressStream } from "@/components/ec/progress-stream";
import { ComboInput, NumberSlider, Field } from "@/components/form/smart-inputs";
import { CommandPreview } from "@/components/cli/command-preview";

interface RepairResult {
  volume_id: number;
  placement: string;
  kind: "under" | "over" | "misplaced" | "";
  before: number;
  after: number;
  status: "fixed" | "failed" | "detected" | "pending";
  error?: string;
}

interface PlacementStat {
  placement: string;
  detected: number;
  fixed: number;
  failed: number;
}

interface Summary {
  results: RepairResult[];
  by_placement: PlacementStat[];
  detected: number;
  fixed: number;
  failed: number;
  pending: number;
  under_replicated: number;
  over_replicated: number;
  misplaced: number;
}

interface Props {
  clusterID: string;
  collections?: string[];
  onClose: () => void;
  onDone?: () => void;
}

// Mirror of internal/api/volume_fix_replication.go::buildVolumeFixReplicationArgs.
// Kept in sync so the form-side preview matches what the backend will
// actually run. The backend is still the source of truth (it re-emits
// args in the start SSE event); this just lets us show the command
// before submission.
function buildArgs(state: {
  pattern: string;
  doDelete: boolean;
  doCheck: boolean;
  verbose: boolean;
  maxParallel: number | "";
  retry: number | "";
  apply: boolean;
}): string[] {
  const args: string[] = [];
  if (state.pattern.trim()) args.push(`-collectionPattern=${state.pattern.trim()}`);
  if (!state.doDelete) args.push("-doDelete=false");
  if (!state.doCheck) args.push("-doCheck=false");
  if (state.verbose) args.push("-verbose");
  if (typeof state.maxParallel === "number" && state.maxParallel > 0) {
    args.push(`-maxParallelization=${state.maxParallel}`);
  }
  if (typeof state.retry === "number" && state.retry > 0) {
    args.push(`-retry=${state.retry}`);
  }
  if (state.apply) args.push("-apply");
  return args;
}

export function VolumeFixReplicationDialog({
  clusterID, collections = [], onClose, onDone,
}: Props) {
  const { t } = useT();

  const [pattern, setPattern] = useState("");
  const [doDelete, setDoDelete] = useState(true);
  const [doCheck, setDoCheck] = useState(true);
  const [maxParallel, setMaxParallel] = useState<number | "">(10);
  const [retry, setRetry] = useState<number | "">(5);
  // Verbose default true: shell silently collects topology for ~15s
  // before printing anything. Verbose prints "wait 15 seconds..." /
  // "collected topology: ..." / per-volume check lines so the tail
  // starts moving immediately.
  const [verbose, setVerbose] = useState(true);
  const [apply, setApply] = useState(false);

  // streamBody !== null means a run is in progress (or finished).
  // The form stays visible but read-only on the left while the right
  // pane streams output.
  const [streamBody, setStreamBody] = useState<Record<string, unknown> | null>(null);
  const [streamApply, setStreamApply] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [finishedOk, setFinishedOk] = useState<boolean | null>(null);
  const { probe, probing, runProbe, reset: resetProbe } = usePreflightLockProbe(clusterID);

  const previewArgs = useMemo(
    () => buildArgs({ pattern, doDelete, doCheck, verbose, maxParallel, retry, apply }),
    [pattern, doDelete, doCheck, verbose, maxParallel, retry, apply],
  );

  const buildBody = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    if (pattern.trim()) b.collectionPattern = pattern.trim();
    if (!doDelete) b.doDelete = false;
    if (!doCheck) b.doCheck = false;
    if (verbose) b.verbose = true;
    if (typeof maxParallel === "number" && maxParallel > 0) b.maxParallelization = maxParallel;
    if (typeof retry === "number" && retry > 0) b.retry = retry;
    return b;
  };

  const run = async () => {
    if (apply) {
      const ok = await runProbe(probe !== null);
      if (!ok) return;
    }
    setSummary(null);
    setFinishedOk(null);
    setStreamApply(apply);
    setStreamBody(buildBody());
  };

  const reset = () => {
    setStreamBody(null);
    setSummary(null);
    setFinishedOk(null);
  };

  const running = streamBody !== null && finishedOk === null;
  const wideMode = streamBody !== null;
  const streamURL = streamBody
    ? `/clusters/${clusterID}/volume/fix-replication/${streamApply ? "apply" : "plan"}`
    : "";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${
          wideMode ? "max-w-6xl" : "max-w-3xl"
        } max-h-[92vh] flex flex-col shadow-soft`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">{t("Fix replication")}</h2>
            <p className="text-xs text-muted mt-0.5 truncate">
              {t("Detect under/over/misplaced replicas. With Apply: copy new replicas and delete extras.")}
            </p>
          </div>
          <button className="text-muted hover:text-text shrink-0" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className={`overflow-auto flex-1 ${
          wideMode
            ? "grid grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-5 px-5 py-4"
            : "px-5 py-4 space-y-4"
        }`}>
          {/* ───────── Left: form ───────── */}
          <div className={`space-y-3 ${running ? "opacity-70 pointer-events-none" : ""}`}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Collection pattern")}
                hint={t('Wildcards * and ? allowed. Blank = all collections.')}>
                <ComboInput
                  value={pattern}
                  onChange={setPattern}
                  options={collections}
                  placeholder="* / important*"
                />
              </Field>
              <Field label={t("Max parallelization")}
                hint={t("Default 10. Lower under load.")}>
                <NumberSlider
                  value={maxParallel === "" ? 10 : maxParallel}
                  onChange={setMaxParallel}
                  min={1} max={32} step={1}
                />
              </Field>
              <Field label={t("Retry count")}
                hint={t("How many times to retry topology after a copy.")}>
                <NumberSlider
                  value={retry === "" ? 5 : retry}
                  onChange={setRetry}
                  min={0} max={20} step={1}
                />
              </Field>
              <div className="flex flex-col gap-2 pt-5">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-accent" checked={doDelete} onChange={e => setDoDelete(e.target.checked)}/>
                  {t("Delete over-replicated copies")}
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-accent" checked={doCheck} onChange={e => setDoCheck(e.target.checked)}/>
                  {t("Check sync before deleting")}
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-accent" checked={verbose} onChange={e => setVerbose(e.target.checked)}/>
                  {t("Verbose output")}
                </label>
              </div>
            </div>

            <label className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
              apply ? "border-warning/40 bg-warning/5" : "border-border/60"
            }`}>
              <input
                type="checkbox" className="mt-0.5 accent-accent"
                checked={apply} onChange={e => { setApply(e.target.checked); resetProbe(); }}/>
              <div>
                <div className={`text-sm font-medium ${apply ? "text-warning" : ""}`}>
                  {t("Apply (actually run)")}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {t("Unchecked = dry-run (plan only, no data is written). Checked = real run with live streaming progress.")}
                </div>
              </div>
            </label>

            <div className="text-[11px] text-muted inline-flex items-center gap-1.5">
              <AlertTriangle size={12}/>
              {t("Shell takes ~15s to collect topology before printing — be patient.")}
            </div>

            {/* Always-visible command preview, before run. Updates live
                as the operator edits the form. */}
            {!wideMode && (
              <CommandPreview command="volume.fix.replication" args={previewArgs}/>
            )}
          </div>

          {/* ───────── Right: command + progress (visible while/after run) ───────── */}
          {wideMode && (
            <div className="space-y-3 min-w-0">
              <CommandPreview command="volume.fix.replication" args={previewArgs}/>
              {streamBody && streamURL && (
                <ECProgressStream
                  key={JSON.stringify(streamBody) + (streamApply ? "1" : "0")}
                  variant="inline"
                  url={streamURL}
                  body={streamBody}
                  expectedVolumes={1}
                  title={`volume.fix.replication ${t("in progress")}`}
                  subtitle={streamApply ? t("Apply (actually run)") : t("Dry-run")}
                  onClose={reset}
                  onDone={(ok, payload) => {
                    const s = payload?.summary as Summary | undefined;
                    if (s) setSummary(s);
                    setFinishedOk(ok);
                    if (ok) {
                      if (streamApply) {
                        toast.success(t("Replication fix applied"));
                        onDone?.();
                      }
                    } else {
                      const msg = typeof payload?.error === "string" ? payload.error : t("Replication fix failed");
                      toast.error(t("Replication fix failed"), msg);
                    }
                  }}
                />
              )}
              {summary && <SummaryPanel summary={summary} t={t}/>}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <div className="text-[11px] text-muted">
            {finishedOk === null
              ? (running ? t("Streaming…") : null)
              : summary && summary.detected === 0
                ? t("All volumes meet their replication policy.")
                : streamApply
                  ? t("Done.")
                  : t("Tick Apply to repair.")}
          </div>
          <div className="flex items-center gap-2">
            {wideMode && !running && (
              <button className="btn" onClick={reset}>{t("Back to form")}</button>
            )}
            {apply && <PreflightProbeBanner probe={probe}/>}
            <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
            {!running && (
              <button
                className={`btn ${apply ? "btn-primary" : ""} inline-flex items-center gap-1`}
                disabled={probing}
                onClick={run}>
                {probing ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}
                {(() => {
                  const def = wideMode
                    ? (apply ? t("Re-run (apply)") : t("Re-run dry-run"))
                    : (apply ? t("Run (apply)") : t("Run dry-run"));
                  return apply ? preflightButtonLabel(t, probe, probing, def) : def;
                })()}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function SummaryPanel({ summary, t }: { summary: Summary; t: (s: string) => string }) {
  if (summary.detected === 0) {
    return (
      <div className="p-3 rounded border border-success/40 bg-success/5">
        <div className="text-sm text-success inline-flex items-center gap-2">
          <CheckCircle2 size={14}/> {t("All volumes meet their replication policy.")}
        </div>
      </div>
    );
  }

  const statusBadge = (s: RepairResult["status"]) => {
    switch (s) {
      case "fixed":    return <span className="text-success text-[10px]">✓ {t("fixed")}</span>;
      case "failed":   return <span className="text-danger text-[10px]">✗ {t("failed")}</span>;
      case "pending":  return <span className="text-warning text-[10px]">… {t("pending")}</span>;
      default:         return <span className="text-muted text-[10px]">• {t("detected")}</span>;
    }
  };

  const kindLabel = (k: RepairResult["kind"]) =>
    k === "under" ? t("under-replicated")
      : k === "over" ? t("over-replicated")
      : k === "misplaced" ? t("misplaced")
      : "";

  // Sort: failed first (need attention), then fixed, then pending, then
  // detected. Within each, by volume id ascending.
  const order = { failed: 0, fixed: 1, pending: 2, detected: 3 } as const;
  const sorted = [...summary.results].sort((a, b) =>
    order[a.status] - order[b.status] || a.volume_id - b.volume_id);

  return (
    <div className="space-y-2">
      {/* KPI strip — 4 small tiles. Coloured by tile, value first so
          the eye lands on numbers. */}
      <div className="grid grid-cols-4 gap-2">
        <Kpi label={t("Detected")} value={summary.detected} tone="muted"/>
        <Kpi label={t("Fixed")}    value={summary.fixed}    tone="success"/>
        <Kpi label={t("Failed")}   value={summary.failed}   tone="danger"/>
        <Kpi label={t("Pending")}  value={summary.pending}  tone="warning"/>
      </div>

      {/* By-placement breakdown. Hidden when there's only one strategy
          (no signal in repeating the global totals). */}
      {summary.by_placement.length > 1 && (
        <div className="p-2 rounded border border-border/60 bg-bg/30">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
            {t("By placement")}
          </div>
          <ul className="text-xs space-y-0.5">
            {summary.by_placement
              .sort((a, b) => b.detected - a.detected)
              .map(p => (
                <li key={p.placement} className="flex items-center gap-2 font-mono">
                  <span className="text-accent w-12">{p.placement}</span>
                  <span className="text-muted">
                    {t("detected")} <span className="text-text">{p.detected}</span>
                  </span>
                  {p.fixed > 0 && (
                    <span className="text-success">
                      · {t("fixed")} {p.fixed}
                    </span>
                  )}
                  {p.failed > 0 && (
                    <span className="text-danger">
                      · {t("failed")} {p.failed}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Per-volume detail rows. "before → after" arrow makes the actual
          repair effect obvious; -before/+after stays the original number
          when no change happened (pending / detected only). */}
      <div className="p-2 rounded border border-border/60 bg-bg/30">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
          {t("Volumes")}
        </div>
        <ul className="text-xs space-y-1 font-mono max-h-48 overflow-auto">
          {sorted.slice(0, 64).map(r => {
            const changed = r.before !== r.after;
            return (
              <li key={r.volume_id} className="flex items-center gap-2 flex-wrap">
                <span className="text-text w-14 shrink-0">vol {r.volume_id}</span>
                <span className="text-accent">{r.placement}</span>
                <span className="text-muted">{kindLabel(r.kind)}</span>
                <span className="text-muted/60">·</span>
                <span>
                  {t("replicas")}{" "}
                  <span className="text-text">{r.before}</span>
                  <span className={changed ? "mx-1 text-success" : "mx-1 text-muted/60"}>→</span>
                  <span className={changed ? "text-success font-semibold" : "text-text"}>{r.after}</span>
                </span>
                <span className="ml-auto">{statusBadge(r.status)}</span>
                {r.error && (
                  <div className="w-full text-[10px] text-danger pl-14 break-all">
                    {r.error}
                  </div>
                )}
              </li>
            );
          })}
          {sorted.length > 64 && (
            <li className="text-muted/70">… +{sorted.length - 64}</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: "muted" | "success" | "danger" | "warning" }) {
  const toneText =
    tone === "success" ? "text-success"
    : tone === "danger" ? "text-danger"
    : tone === "warning" ? "text-warning"
    : "text-text";
  const toneBorder =
    tone === "success" ? "border-success/40 bg-success/5"
    : tone === "danger" ? "border-danger/40 bg-danger/5"
    : tone === "warning" ? "border-warning/40 bg-warning/5"
    : "border-border/60 bg-bg/30";
  return (
    <div className={`p-2 rounded border ${toneBorder}`}>
      <div className={`text-base font-semibold tabular-nums ${toneText}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}
