"use client";

import { Database, RefreshCw, AlertTriangle } from "lucide-react";
import { useClusterFilers, type ClusterFilerRow } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { HealthBadge } from "@/components/health-badge";
import { TableSkeleton } from "@/components/table-skeleton";
import { useClusterDetail } from "../_context";

export default function ClusterFilersPage() {
  const { has, loading: capsLoading } = useCaps();
  const { id } = useClusterDetail();
  const { t } = useT();
  const { data, isLoading, isValidating, mutate, error } = useClusterFilers(id);

  if (capsLoading) return null;
  if (!has("cluster.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view filers.")}</div>;
  }
  if (error) {
    return (
      <div className="card p-5 border-danger/40 bg-danger/10 text-danger text-xs font-mono whitespace-pre-wrap">
        {String((error as Error).message ?? error)}
      </div>
    );
  }

  const rows = data?.filers ?? [];
  const loadingData = isLoading && !data;
  const masterCount = rows.filter((f) => f.source !== "config").length;
  const configOnlyCount = rows.filter((f) => f.source === "config").length;

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
            <Database size={16}/> {t("Filers")}
          </h2>
          <p className="text-xs text-muted">
            <span className="tabular-nums">{masterCount}</span> {t("registered with master")}
            {configOnlyCount > 0 && (
              <>
                <span className="mx-2 text-muted/40">|</span>
                <span className="text-warning tabular-nums">{configOnlyCount}</span>{" "}
                <span className="text-warning">{t("config-only (heartbeat missing)")}</span>
              </>
            )}
          </p>
        </div>
        <button onClick={() => mutate()} disabled={isValidating} className="btn inline-flex items-center gap-1">
          <RefreshCw size={12} className={isValidating ? "animate-spin" : ""}/>
          {t("Refresh")}
        </button>
      </header>

      {data?.master_list_error && (
        <div className="card p-3 border-danger/40 bg-danger/10 text-danger text-xs space-y-1">
          <div className="inline-flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={12}/> {t("Master did not return a filer list")}
          </div>
          <div className="font-mono text-[11px] opacity-80 break-all">{data.master_list_error}</div>
          <div className="text-muted">
            {t("Falling back to the filers configured at cluster registration.")}
          </div>
        </div>
      )}

      {configOnlyCount > 0 && (
        <div className="card p-3 border-warning/40 bg-warning/10 text-warning text-xs space-y-1">
          <div className="inline-flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={12}/> {t("Filer/master heartbeat is broken")}
          </div>
          <div className="text-muted">
            {t("These filer addresses come from cluster.filer_addr but the master never saw them. Check the filer was started with -master=<this cluster's master> and that the network allows the heartbeat.")}
          </div>
        </div>
      )}

      {loadingData ? (
        <TableSkeleton rows={5} headers={[t("Address"), t("Source"), t("Health"), t("Version"), t("Data center"), t("Rack"), t("Latency"), t("Registered at")]}/>
      ) : (
        <section className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="p-6 text-sm text-muted text-center">{t("No filers registered with this cluster.")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid">
                <thead><tr>
                  <th>{t("Address")}</th>
                  <th>{t("Source")}</th>
                  <th>{t("Health")}</th>
                  <th>{t("Version")}</th>
                  <th>{t("Data center")}</th>
                  <th>{t("Rack")}</th>
                  <th className="num">{t("Latency")}</th>
                  <th>{t("Registered at")}</th>
                </tr></thead>
                <tbody>
                  {rows.map((row) => <FilerRow key={row.address} row={row}/>)}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function sourceLabel(source: ClusterFilerRow["source"], t: (s: string) => string): { text: string; tone: "ok" | "warn" } {
  switch (source) {
    case "master":         return { text: t("master"),         tone: "ok" };
    case "master+config":  return { text: t("master+config"),  tone: "ok" };
    case "config":         return { text: t("config-only"),    tone: "warn" };
    default:               return { text: source,              tone: "warn" };
  }
}

function FilerRow({ row }: { row: ClusterFilerRow }) {
  const { t } = useT();
  const registeredLabel = row.created_at_ns
    ? new Date(Math.floor(row.created_at_ns / 1_000_000)).toLocaleString()
    : "—";
  const src = sourceLabel(row.source, t);
  return (
    <tr>
      <td className="font-mono text-sm">
        <a
          href={`http://${row.address}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
          title={t("Open filer in new tab")}
        >
          {row.address}
        </a>
      </td>
      <td><HealthBadge tone={src.tone}>{src.text}</HealthBadge></td>
      <td><HealthBadge tone={row.health}>{t(row.health)}</HealthBadge></td>
      <td className="font-mono text-xs">{row.version || "—"}</td>
      <td className="text-xs">{row.data_center || "—"}</td>
      <td className="text-xs">{row.rack || "—"}</td>
      <td className="num text-xs">
        {row.reachable
          ? `${row.latency_ms ?? "?"} ms`
          : <span className="text-danger" title={row.probe_error}>{t("unreachable")}</span>}
      </td>
      <td className="text-xs text-muted">{registeredLabel}</td>
    </tr>
  );
}
