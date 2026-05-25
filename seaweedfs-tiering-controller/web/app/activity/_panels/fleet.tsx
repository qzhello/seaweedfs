"use client";

// Fleet ops overview — Activity tab's "where is everything?" view.
//
// Four tiles at the top (pending / running / 7d-succeeded / 7d-failed),
// then per-cluster queue depth, stuck-task hotspots, action failure
// rate, and a 7-day throughput sparkline. Pure SQL behind it; no AI.
//
// Refresh: useSWR with refreshInterval=30s. The dashboard is meant to
// stay open during incident response — staleness would make it useless.

import { useState } from "react";
import Link from "next/link";
import { Clock, ListChecks, CheckCircle2, AlertTriangle, ChevronRight } from "lucide-react";
import { useOpsFleet, type OpsFleetStuckRow, type OpsFleetDailyThroughputRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ErrorPanel } from "@/components/error-panel";

export function FleetOpsPanel() {
  const { t } = useT();
  const [windowHours, setWindowHours] = useState(168);
  const { data, error, isLoading } = useOpsFleet(windowHours);

  if (error)     return <ErrorPanel error={error}/>;
  if (isLoading) return <div className="card p-6 text-sm text-muted">{t("Loading…")}</div>;
  if (!data)     return null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("Fleet ops overview")}</h2>
          <p className="text-xs text-muted">{t("Where tasks are queueing, what's failing, throughput trend.")}</p>
        </div>
        <label className="text-xs">
          <span className="block text-muted">{t("Window")}</span>
          <select className="input" value={windowHours} onChange={e => setWindowHours(Number(e.target.value))}>
            <option value={24}>24h</option>
            <option value={72}>72h</option>
            <option value={168}>7d</option>
            <option value={336}>14d</option>
            <option value={720}>30d</option>
          </select>
        </label>
      </header>

      {/* 4-tile summary */}
      <div className="grid gap-2 sm:grid-cols-4">
        <Tile icon={Clock}        label={t("Pending")}   value={data.total_pending}   tone="warning"/>
        <Tile icon={ListChecks}   label={t("Running")}   value={data.total_running}   tone="accent"/>
        <Tile icon={CheckCircle2} label={`${t("Succeeded")} (${humanWindow(data.window_hours, t)})`} value={data.total_succeeded_in_window} tone="success"/>
        <Tile icon={AlertTriangle} label={`${t("Failed")} (${humanWindow(data.window_hours, t)})`}   value={data.total_failed_in_window}    tone={data.total_failed_in_window > 0 ? "danger" : "muted"}/>
      </div>

      <Throughput rows={data.daily_throughput}/>

      <ClusterTable rows={data.clusters} windowHours={data.window_hours}/>

      {data.stuck_tasks.length > 0 && (
        <StuckTable rows={data.stuck_tasks}
                    runningStuckSec={data.running_stuck_threshold_seconds}
                    pendingStuckSec={data.pending_stuck_threshold_seconds}/>
      )}

      {data.action_failures.length > 0 && (
        <ActionFailureTable rows={data.action_failures} windowHours={data.window_hours}/>
      )}
    </div>
  );
}

// ---- Tiles ----

function Tile({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "accent" | "muted";
}) {
  const toneCls = {
    success: "border-success/30 bg-success/5  text-success",
    warning: "border-warning/30 bg-warning/5  text-warning",
    danger:  "border-danger/30  bg-danger/5   text-danger",
    accent:  "border-accent/30  bg-accent/5   text-accent",
    muted:   "border-divider                  text-muted",
  }[tone];
  return (
    <div className={`card flex items-center justify-between gap-3 p-3 ${toneCls}`}>
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
        <span className="font-mono text-2xl tabular-nums">{value}</span>
      </div>
      <Icon size={28} className="opacity-50"/>
    </div>
  );
}

// ---- Throughput sparkline ----

function Throughput({ rows }: { rows: OpsFleetDailyThroughputRow[] }) {
  const { t } = useT();
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map(r => Math.max(r.started, r.succeeded + r.failed)));
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold">{t("Daily executions")}</header>
      <div className="overflow-x-auto p-3">
        <div className="flex min-w-max h-24 items-end gap-1.5">
          {rows.map(r => {
            const okH   = (r.succeeded / max) * 100;
            const failH = (r.failed    / max) * 100;
            return (
              <div key={r.day} className="flex w-10 flex-col items-center gap-0.5">
                <div className="flex w-full flex-1 flex-col-reverse">
                  <div className="bg-success/70 rounded-b" title={`${t("succeeded")}: ${r.succeeded}`} style={{ height: `${okH}%` }}/>
                  <div className="bg-danger/70" title={`${t("failed")}: ${r.failed}`} style={{ height: `${failH}%` }}/>
                </div>
                <div className="font-mono text-[9px] text-muted">{r.day.slice(5)}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-success/70"/> {t("succeeded")}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-danger/70"/> {t("failed")}</span>
        </div>
      </div>
    </section>
  );
}

// ---- Per-cluster table ----

function ClusterTable({ rows, windowHours }: { rows: import("@/lib/api").OpsFleetClusterRow[]; windowHours: number }) {
  const { t } = useT();
  if (rows.length === 0) {
    return (
      <section className="card p-3 text-xs text-muted">
        {t("No tasks recorded for any cluster yet.")}
      </section>
    );
  }
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold">{t("By cluster")}</header>
      <table className="grid w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">{t("Cluster")}</th>
            <th className="text-right">{t("Pending")}</th>
            <th className="text-right">{t("Running")}</th>
            <th className="text-right">{t("Succeeded")} ({humanWindow(windowHours, t)})</th>
            <th className="text-right">{t("Failed")} ({humanWindow(windowHours, t)})</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const failureRate = r.succeeded_in_window + r.failed_in_window > 0
              ? r.failed_in_window / (r.succeeded_in_window + r.failed_in_window)
              : 0;
            return (
              <tr key={r.cluster_id || `_unassigned_${i}`}>
                <td className="font-mono">
                  {r.cluster_id ? (
                    <Link href={`/clusters/${r.cluster_id}`} className="hover:text-accent">{r.name}</Link>
                  ) : (
                    <span className="text-muted">{r.name}</span>
                  )}
                </td>
                <td className="text-right tabular-nums">{r.pending}</td>
                <td className="text-right tabular-nums">{r.running}</td>
                <td className="text-right tabular-nums">{r.succeeded_in_window}</td>
                <td className={`text-right tabular-nums ${failureRate > 0.1 ? "text-danger" : ""}`}>
                  {r.failed_in_window}
                  {failureRate > 0.1 && <span className="ml-1 text-[10px]">({(failureRate * 100).toFixed(0)}%)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---- Stuck table ----

function StuckTable({ rows, runningStuckSec, pendingStuckSec }: {
  rows: OpsFleetStuckRow[];
  runningStuckSec: number;
  pendingStuckSec: number;
}) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden border-warning/30">
      <header className="border-b border-border bg-warning/5 px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-warning">
          <AlertTriangle size={12}/> {t("Stuck tasks")}
        </span>
        <span className="ml-2 text-[11px] text-muted">
          {t("running > {r}, pending > {p}")
            .replace("{r}", humanDuration(runningStuckSec, t))
            .replace("{p}", humanDuration(pendingStuckSec, t))}
        </span>
      </header>
      <table className="grid w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">{t("Age")}</th>
            <th className="text-left">{t("Cluster")}</th>
            <th className="text-left">{t("Action")}</th>
            <th className="text-left">{t("Volume")}</th>
            <th className="text-left">{t("Status")}</th>
            <th className="text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="font-mono text-warning">{humanDuration(r.age_seconds, t)}</td>
              <td className="font-mono">{r.cluster_name || "—"}</td>
              <td className="font-mono">{r.action}</td>
              <td className="font-mono">{r.volume_id || "—"} {r.collection && <span className="text-muted">({r.collection})</span>}</td>
              <td><span className="badge text-[10px]">{r.status}</span></td>
              <td className="text-right">
                <Link href={`/executions?task=${r.id}`} className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline">
                  {t("Inspect")} <ChevronRight size={11}/>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- Action failures ----

function ActionFailureTable({ rows, windowHours }: { rows: import("@/lib/api").OpsFleetActionFailureRow[]; windowHours: number }) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold">
        {t("Action failure rate")}
        <span className="ml-2 text-[11px] font-normal text-muted">
          ({humanWindow(windowHours, t)}, {t("min 3 runs")})
        </span>
      </header>
      <table className="grid w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">{t("Action")}</th>
            <th className="text-right">{t("Total")}</th>
            <th className="text-right">{t("Failed")}</th>
            <th className="text-right">{t("Rate")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.action}>
              <td className="font-mono">{r.action}</td>
              <td className="text-right tabular-nums">{r.total}</td>
              <td className="text-right tabular-nums">{r.failed}</td>
              <td className={`text-right tabular-nums ${r.failure_rate > 0.2 ? "text-danger" : r.failure_rate > 0.05 ? "text-warning" : "text-muted"}`}>
                {(r.failure_rate * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- Helpers ----

function humanWindow(hours: number, t: (k: string) => string): string {
  if (hours >= 24 * 7) return `${Math.round(hours / 24 / 7)}${t("w")}`;
  if (hours >= 24)     return `${Math.round(hours / 24)}${t("d")}`;
  return `${hours}${t("h")}`;
}

function humanDuration(seconds: number, t: (k: string) => string): string {
  const m = Math.floor(seconds / 60);
  if (m < 60)        return `${m}${t("m")}`;
  const h = Math.floor(m / 60);
  if (h < 24)        return `${h}${t("h")}`;
  const d = Math.floor(h / 24);
  return `${d}${t("d")}${h % 24 > 0 ? ` ${h % 24}${t("h")}` : ""}`;
}
