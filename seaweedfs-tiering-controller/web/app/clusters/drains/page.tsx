"use client";

// Drain dashboard — every drain job (in-flight + recent) across all
// clusters. The picker page only shows pending/running/verifying for
// the current cluster; this page is the system-wide view, including
// completed and failed jobs for after-the-fact audit.

import Link from "next/link";
import { LogOut } from "lucide-react";
import { useDrains, useClusters, type DrainJob } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { bytes as fmtBytes } from "@/lib/utils";
import { StatusBadge } from "./_status";

export default function DrainsPage() {
  const { t } = useT();
  return (
    <Can cap="cluster.volume-server.leave" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { data, error, mutate, isLoading, isValidating } = useDrains();
  const { data: clustersResp } = useClusters();
  const clusterNameByID = new Map<string, string>(
    (clustersResp?.items ?? []).map((c: { id: string; name: string }) => [c.id, c.name])
  );
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <LogOut size={20}/> {t("Drain history")}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            {t("Every volumeServer.leave job recorded by the controller. Click a row to follow live progress or read the past run log.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <Link href="/clusters/leave" className="btn btn-primary inline-flex items-center gap-1.5 text-xs">
            <LogOut size={12}/> {t("Drain new server")}
          </Link>
        </div>
      </header>

      {error && <ErrorPanel error={error}/>}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={8} headers={[t("Cluster"), t("Node"), t("Status"), t("Progress"), t("Started"), t("Requested by")]}/>
        </section>
      ) : items.length === 0 ? (
        <EmptyState
          icon={LogOut}
          title={t("No drains recorded yet")}
          hint={t("When you drain a volume server, the job is recorded here for the rest of its lifetime.")}
        />
      ) : (
        <section className="card overflow-hidden">
          <table className="grid">
            <thead>
              <tr>
                <th>{t("Cluster")}</th>
                <th>{t("Node")}</th>
                <th>{t("Status")}</th>
                <th>{t("Progress")}</th>
                <th>{t("Started")}</th>
                <th>{t("Requested by")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(d => (
                <DrainRow key={d.id} d={d} clusterName={clusterNameByID.get(d.cluster_id) ?? d.cluster_id.slice(0, 8)} t={t}/>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function DrainRow({ d, clusterName, t }: { d: DrainJob; clusterName: string; t: (k: string) => string }) {
  const remaining = d.initial_volumes > 0
    ? Math.max(0, 1 - (d.last_volumes / d.initial_volumes))
    : (d.status === "done" ? 1 : 0);
  return (
    <tr>
      <td className="text-xs">{clusterName}</td>
      <td>
        <Link href={`/clusters/drains/${d.id}`} className="font-mono text-sm hover:underline">
          {d.node}
        </Link>
        {d.force && <span className="badge text-[10px] ml-1 border-amber-400/40 text-amber-300">force</span>}
      </td>
      <td><StatusBadge status={d.status} t={t}/></td>
      <td className="min-w-[180px]">
        <ProgressBar d={d} progress={remaining}/>
        <div className="text-[10px] text-muted mt-0.5 font-mono">
          {d.last_volumes}/{d.initial_volumes} {t("vols")} · {fmtBytes(d.last_bytes)} / {fmtBytes(d.initial_bytes)}
        </div>
      </td>
      <td className="text-xs text-muted">{d.started_at ? relTime(d.started_at, t) : "—"}</td>
      <td className="text-xs text-muted truncate max-w-[180px]">{d.requested_by || "—"}</td>
      <td>
        <Link href={`/clusters/drains/${d.id}`} className="text-xs text-muted hover:text-text">
          {t("Open")} →
        </Link>
      </td>
    </tr>
  );
}

function ProgressBar({ d, progress }: { d: DrainJob; progress: number }) {
  // Terminal failure / cancel renders as a dim full bar so the row
  // still has visual height; the badge already conveys outcome.
  const isTerminalBad = d.status === "failed" || d.status === "cancelled";
  const tone = d.status === "done" ? "bg-emerald-500/70"
    : isTerminalBad ? "bg-rose-500/40"
    : "bg-accent";
  return (
    <div className="h-1.5 bg-panel2 rounded overflow-hidden">
      <div
        className={`h-full ${tone} transition-[width] duration-300`}
        style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }}
      />
    </div>
  );
}

function relTime(iso: string, t: (k: string) => string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t("just now");
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleString();
}
