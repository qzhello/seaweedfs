"use client";
// Deep-check modal — centered, progressive reveal.
//
// The underlying server endpoint (api.scoreNow) runs all checks in one call
// and returns a single report. To give the operator a sense of progression
// we split that report into 5 step rows and reveal them sequentially with
// a small stagger. The checkbox toggles in the config view filter WHICH
// rows the operator sees; the actual scan is always run end-to-end.

import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import {
  CheckCircle2, Circle, Loader2, AlertCircle, MinusCircle,
  X, Play, RefreshCw, Activity, Database, Snowflake, Shield, ListChecks,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

export interface ScoreReport {
  clusters: number;
  clusters_ok: number;
  volumes_scanned: number;
  volumes_noop: number;
  recs_by_action?: Record<string, number>;
  under_replicated: number;
  missing_volumes?: number[];
  tasks_inserted: number;
  tasks_duplicate: number;
  tasks_failed: number;
  errors?: string[];
  per_cluster?: ClusterScanReport[];
}

export interface ClusterScanReport {
  name: string;
  master_addr?: string;
  business_domain?: string;
  volumes: number;
  recs: number;
  under_replicated: number;
  missing_volumes?: number[];
  inserted: number;
  duplicate: number;
  failed: number;
  error?: string;
}

type StepKey = "connectivity" | "inventory" | "scoring" | "replication" | "tasks";
type StepState = "pending" | "running" | "done" | "skipped" | "failed";

interface Props {
  open: boolean;
  scopeCluster: string;
  onClose: () => void;
  onCompleted?: () => void;
}

const STEP_ICONS: Record<StepKey, LucideIcon> = {
  connectivity: Activity,
  inventory: Database,
  scoring: Snowflake,
  replication: Shield,
  tasks: ListChecks,
};

const STEP_ORDER: StepKey[] = ["connectivity", "inventory", "scoring", "replication", "tasks"];

const TOGGLE_STORAGE_KEY = "tier.deepcheck.toggles";

function loadToggles(): Record<StepKey, boolean> {
  const fallback: Record<StepKey, boolean> = {
    connectivity: true, inventory: true, scoring: true, replication: true, tasks: true,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(TOGGLE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...fallback };
    for (const k of STEP_ORDER) {
      if (typeof parsed[k] === "boolean") out[k] = parsed[k] as boolean;
    }
    return out;
  } catch {
    return fallback;
  }
}

function saveToggles(t: Record<StepKey, boolean>) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(TOGGLE_STORAGE_KEY, JSON.stringify(t)); } catch {}
}

export function DeepCheckModal({ open, scopeCluster, onClose, onCompleted }: Props) {
  const { t } = useT();
  const [phase, setPhase] = useState<"config" | "running" | "done">("config");
  const [toggles, setToggles] = useState<Record<StepKey, boolean>>(() => loadToggles());
  const [steps, setSteps] = useState<Record<StepKey, { state: StepState; result?: string }>>(() => ({
    connectivity: { state: "pending" },
    inventory:    { state: "pending" },
    scoring:      { state: "pending" },
    replication:  { state: "pending" },
    tasks:        { state: "pending" },
  }));
  const [report, setReport] = useState<ScoreReport | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  // Reset modal state every time it opens.
  useEffect(() => {
    if (!open) return;
    setPhase("config");
    setReport(null);
    setTopError(null);
    setSteps({
      connectivity: { state: "pending" },
      inventory:    { state: "pending" },
      scoring:      { state: "pending" },
      replication:  { state: "pending" },
      tasks:        { state: "pending" },
    });
  }, [open]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const labels: Record<StepKey, { title: string; target: string }> = {
    connectivity: { title: t("Connectivity"),       target: t("Probe each cluster master and report which are reachable.") },
    inventory:    { title: t("Volume inventory"),   target: t("Enumerate volumes across reachable clusters.") },
    scoring:      { title: t("Cold scoring"),       target: t("Score volumes against cooling windows and recommend movement.") },
    replication:  { title: t("Replication health"), target: t("Detect under-replicated volumes and surface missing volume IDs.") },
    tasks:        { title: t("Task generation"),    target: t("Insert new tiering tasks based on the recommendations.") },
  };

  const toggleStep = (k: StepKey, v: boolean) => {
    const next = { ...toggles, [k]: v };
    setToggles(next); saveToggles(next);
  };

  const startScan = useCallback(async () => {
    const anyOn = STEP_ORDER.some(k => toggles[k]);
    if (!anyOn) { setTopError(t("Pick at least one check.")); return; }

    setTopError(null);
    setPhase("running");
    setSteps(s => ({
      ...s,
      ...Object.fromEntries(STEP_ORDER.map(k => [k, { state: toggles[k] ? ("running" as StepState) : ("skipped" as StepState) }])) as Record<StepKey, { state: StepState }>,
    }));

    let res: { ok?: boolean; report?: ScoreReport; error?: string };
    try {
      res = await api.scoreNow(scopeCluster || undefined) as { ok?: boolean; report?: ScoreReport; error?: string };
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
      setSteps(s => ({
        ...s,
        ...Object.fromEntries(STEP_ORDER.map(k => [k, { state: toggles[k] ? ("failed" as StepState) : ("skipped" as StepState) }])) as Record<StepKey, { state: StepState }>,
      }));
      setPhase("done");
      return;
    }
    if (res?.error) {
      setTopError(res.error);
      setSteps(s => ({
        ...s,
        ...Object.fromEntries(STEP_ORDER.map(k => [k, { state: toggles[k] ? ("failed" as StepState) : ("skipped" as StepState) }])) as Record<StepKey, { state: StepState }>,
      }));
      setPhase("done");
      return;
    }
    const r = res?.report;
    setReport(r ?? null);

    // Compute conclusions per step.
    const conclusions: Record<StepKey, string> = {
      connectivity: r
        ? `${t("Probed")} ${r.clusters} ${t("clusters")} · ${r.clusters_ok} ${t("clusters reachable")}`
        : "—",
      inventory: r
        ? `${t("Discovered")} ${r.volumes_scanned} ${t("volumes total")}`
        : "—",
      scoring: (() => {
        if (!r) return "—";
        const recs = r.recs_by_action ?? {};
        const recCount = Object.entries(recs)
          .filter(([k]) => k !== "fix_replication")
          .reduce((s, [, n]) => s + n, 0);
        if (r.volumes_noop === r.volumes_scanned && recCount === 0) {
          return t("All volumes are within policy — no action needed.");
        }
        const detail = Object.entries(recs)
          .filter(([k]) => k !== "fix_replication")
          .map(([k, n]) => `${k}=${n}`).join(", ");
        return `${recCount} ${t("recommendations generated")}${detail ? ` (${detail})` : ""}`;
      })(),
      replication: (() => {
        if (!r) return "—";
        if (r.under_replicated > 0) {
          const sample = (r.missing_volumes ?? []).slice(0, 5).join(", ");
          const more = (r.missing_volumes ?? []).length > 5 ? "…" : "";
          return `${r.under_replicated} ${t("under-replicated volume(s)")} (${sample}${more})`;
        }
        return t("All replicas present.");
      })(),
      tasks: (() => {
        if (!r) return "—";
        if (r.tasks_inserted > 0) return `${r.tasks_inserted} ${t("new task(s) queued.")}`;
        if (r.tasks_failed > 0)   return `${r.tasks_failed} ${t("task insert(s) failed (see errors below)")}`;
        return t("No new tasks (deduplicated against in-flight work).");
      })(),
    };

    // Reveal step-by-step.
    for (const k of STEP_ORDER) {
      if (!toggles[k]) continue;
      // Stagger each step ~450ms so the operator sees progression.
      await new Promise(resolve => setTimeout(resolve, 450));
      setSteps(s => ({ ...s, [k]: { state: "done", result: conclusions[k] } }));
    }
    setPhase("done");
    onCompleted?.();
  }, [toggles, scopeCluster, onCompleted, t]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true">
      <div
        className="card bg-panel border border-border w-full max-w-3xl max-h-[90vh] flex flex-col shadow-soft"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
              <RefreshCw size={14} className={phase === "running" ? "text-accent animate-spin" : "text-accent"}/>
              {t("Deep check")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {scopeCluster ? scopeCluster : t("All clusters")}
              {" · "}
              {phase === "config" && t("Pick what to inspect. Each step shows what was checked and the conclusion.")}
              {phase === "running" && t("Running deep check…")}
              {phase === "done" && (topError ? t("Failed") : t("Done"))}
            </p>
          </div>
          <button className="text-muted hover:text-text shrink-0" aria-label={t("Close")} onClick={onClose}>
            <X size={16}/>
          </button>
        </header>

        {/* Body */}
        <div className="px-5 py-4 overflow-auto flex-1">
          {topError && (
            <div className="mb-3 text-sm text-danger flex items-center gap-2">
              <AlertCircle size={14}/> {topError}
            </div>
          )}

          {phase === "config" ? (
            <ConfigList toggles={toggles} onToggle={toggleStep} labels={labels}/>
          ) : (
            <StepList steps={steps} toggles={toggles} labels={labels}/>
          )}

          {/* Per-cluster breakdown only after the run finishes. */}
          {phase === "done" && report?.per_cluster && report.per_cluster.length > 0 && (
            <PerClusterTable report={report}/>
          )}

          {phase === "done" && report?.errors && report.errors.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="text-danger font-medium mb-1">{t("Errors:")}</div>
              <ul className="space-y-0.5 text-danger/80 font-mono">
                {report.errors.map((e, i) => <li key={i}>· {e}</li>)}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose}>{t("Close")}</button>
          {phase === "config" && (
            <button className="btn btn-primary inline-flex items-center gap-1" onClick={startScan}>
              <Play size={12}/> {t("Start deep check")}
            </button>
          )}
          {phase === "done" && (
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={() => setPhase("config")}>
              <RefreshCw size={12}/> {t("Re-run")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function ConfigList({
  toggles, onToggle, labels,
}: {
  toggles: Record<StepKey, boolean>;
  onToggle: (k: StepKey, v: boolean) => void;
  labels: Record<StepKey, { title: string; target: string }>;
}) {
  return (
    <div className="space-y-2">
      {STEP_ORDER.map((k) => {
        const Icon = STEP_ICONS[k];
        const on = toggles[k];
        return (
          <label
            key={k}
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              on ? "border-accent/40 bg-accent/5" : "border-border/60 hover:bg-bg/60"
            }`}>
            <input
              type="checkbox"
              className="mt-1 accent-accent"
              checked={on}
              onChange={(e) => onToggle(k, e.target.checked)}
            />
            <Icon size={14} className={`mt-0.5 ${on ? "text-accent" : "text-muted"}`}/>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{labels[k].title}</div>
              <div className="text-xs text-muted mt-0.5">{labels[k].target}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function StepList({
  steps, toggles, labels,
}: {
  steps: Record<StepKey, { state: StepState; result?: string }>;
  toggles: Record<StepKey, boolean>;
  labels: Record<StepKey, { title: string; target: string }>;
}) {
  const { t } = useT();
  return (
    <ol className="space-y-2">
      {STEP_ORDER.map((k, idx) => {
        const Icon = STEP_ICONS[k];
        const { state, result } = steps[k];
        const enabled = toggles[k];
        return (
          <li
            key={k}
            className={`flex items-start gap-3 p-3 rounded-lg border ${
              state === "running" ? "border-accent/40 bg-accent/5"
              : state === "done" ? "border-success/30 bg-success/5"
              : state === "failed" ? "border-danger/30 bg-danger/5"
              : "border-border/60"
            }`}>
            <div className="shrink-0 mt-0.5"><StateIndicator state={state}/></div>
            <Icon size={14} className={`mt-0.5 shrink-0 ${enabled ? "text-text" : "text-muted/50"}`}/>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-muted">
                  {t("Step")} {idx + 1}
                </span>
                <span className="text-sm font-medium">{labels[k].title}</span>
                <StateBadge state={state}/>
              </div>
              <div className="text-xs text-muted mt-0.5">
                <span className="text-muted">{t("Target:")}</span> {labels[k].target}
              </div>
              {result && state === "done" && (
                <div className="text-xs mt-1">
                  <span className="text-muted">{t("Result:")}</span> {result}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StateIndicator({ state }: { state: StepState }) {
  if (state === "running") return <Loader2 size={14} className="text-accent animate-spin"/>;
  if (state === "done")    return <CheckCircle2 size={14} className="text-success"/>;
  if (state === "failed")  return <AlertCircle size={14} className="text-danger"/>;
  if (state === "skipped") return <MinusCircle size={14} className="text-muted/50"/>;
  return <Circle size={14} className="text-muted/40"/>;
}

function StateBadge({ state }: { state: StepState }): ReactNode {
  const { t } = useT();
  if (state === "running") return <span className="badge border-accent/40 text-accent">{t("Running")}</span>;
  if (state === "done")    return <span className="badge border-success/40 text-success">{t("Done")}</span>;
  if (state === "failed")  return <span className="badge border-danger/40 text-danger">{t("Failed")}</span>;
  if (state === "skipped") return <span className="badge border-border text-muted">{t("Skipped")}</span>;
  return <span className="badge border-border text-muted">{t("Waiting")}</span>;
}

function PerClusterTable({ report }: { report: ScoreReport }) {
  const { t } = useT();
  if (!report.per_cluster || report.per_cluster.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="text-xs text-muted mb-1">{t("Per cluster:")}</div>
      <div className="text-xs overflow-x-auto">
        <table className="w-full">
          <thead className="text-muted">
            <tr className="text-left">
              <th className="font-normal pr-3 pb-1">{t("Clusters")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("vols")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("recs")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("under-replicated")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("new")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("dup")}</th>
              <th className="font-normal pr-3 pb-1 text-right">{t("failed")}</th>
            </tr>
          </thead>
          <tbody>
            {report.per_cluster.map((c, i) => (
              <tr key={i} className="border-t border-border/60">
                <td className="py-1 pr-3 font-mono">
                  {c.name}
                  {c.business_domain && <span className="text-muted"> [{c.business_domain}]</span>}
                  {c.error && <span className="text-danger"> · {c.error}</span>}
                </td>
                <td className="py-1 pr-3 text-right">{c.volumes}</td>
                <td className="py-1 pr-3 text-right">{c.recs || ""}</td>
                <td className={`py-1 pr-3 text-right ${c.under_replicated > 0 ? "text-warning" : ""}`}>
                  {c.under_replicated || ""}
                </td>
                <td className="py-1 pr-3 text-right">{c.inserted || ""}</td>
                <td className="py-1 pr-3 text-right">{c.duplicate || ""}</td>
                <td className={`py-1 pr-3 text-right ${c.failed > 0 ? "text-danger" : ""}`}>{c.failed || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
