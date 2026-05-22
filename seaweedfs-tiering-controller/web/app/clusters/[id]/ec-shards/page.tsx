"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Grid3X3, RefreshCw, Wrench } from "lucide-react";
import { useClusterECShards, type ECVolumeMatrixRow } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { HealthBadge } from "@/components/health-badge";
import { ECPlanDialog } from "@/components/ec/plan-dialog";
import { useClusterDetail } from "../_context";

export default function ECShardsPage() {
  const { has, loading: capsLoading } = useCaps();
  const { id } = useClusterDetail();
  const { t } = useT();
  const { data, isLoading, isValidating, mutate, error } = useClusterECShards(id);
  const [onlyUnhealthy, setOnlyUnhealthy] = useState(false);
  const [collectionFilter, setCollectionFilter] = useState("");
  // Track which collection the operator wants to rebuild. ec.rebuild is
  // scoped per-collection, not per-volume, so opening the dialog from
  // any volume in collection X is equivalent to the volume-detail
  // version of the button.
  const [rebuildCollection, setRebuildCollection] = useState<string | null>(null);
  const canRebuild = has("volume.write");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.volumes.filter((v) => {
      if (onlyUnhealthy && v.healthy) return false;
      if (collectionFilter && !v.collection.toLowerCase().includes(collectionFilter.toLowerCase())) return false;
      return true;
    });
  }, [data, onlyUnhealthy, collectionFilter]);

  if (capsLoading) return null;
  if (!has("volume.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view EC shards.")}</div>;
  }
  if (error) {
    return (
      <div className="card p-5 border-danger/40 bg-danger/10 text-danger text-xs font-mono whitespace-pre-wrap">
        {String((error as Error).message ?? error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="p-6 text-sm text-muted inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin"/> {t("Loading EC shards…")}
      </div>
    );
  }

  const unhealthy = data.volumes.filter((v) => !v.healthy).length;
  const totalShards = data.total_shards;
  // Distinct collections that have at least one unhealthy volume — used
  // to offer a "Rebuild all" affordance per collection.
  const unhealthyCollections = Array.from(
    new Set(data.volumes.filter((v) => !v.healthy).map((v) => v.collection))
  );

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
            <Grid3X3 size={16}/> {t("EC shard layout")}
          </h2>
          <p className="text-xs text-muted">
            {data.volumes.length} {t("EC volumes")}
            <span className="mx-2 text-muted/40">|</span>
            {unhealthy > 0
              ? <span className="text-danger">{unhealthy} {t("with missing shards")}</span>
              : <span className="text-success">{t("all volumes complete")}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={collectionFilter}
            onChange={(e) => setCollectionFilter(e.target.value)}
            placeholder={t("Filter by collection…")}
            className="input w-56"
          />
          <label className="inline-flex items-center gap-1 text-xs text-muted cursor-pointer">
            <input type="checkbox" checked={onlyUnhealthy} onChange={(e) => setOnlyUnhealthy(e.target.checked)}/>
            {t("Only show incomplete")}
          </label>
          <button onClick={() => mutate()} disabled={isValidating} className="btn inline-flex items-center gap-1">
            <RefreshCw size={12} className={isValidating ? "animate-spin" : ""}/>
            {t("Refresh")}
          </button>
        </div>
      </header>

      {/* Repair affordance — one button per collection with degraded
          volumes, so the operator can fire ec.rebuild without having
          to drill into each volume first. */}
      {canRebuild && unhealthyCollections.length > 0 && (
        <div className="card p-3 border-warning/40 bg-warning/10 text-xs flex flex-wrap items-center gap-2">
          <span className="text-warning font-semibold inline-flex items-center gap-1.5">
            <Wrench size={12}/> {t("Rebuild degraded volumes")}:
          </span>
          {unhealthyCollections.map((col) => (
            <button
              key={col || "_default_"}
              className="btn text-warning border-warning/40 hover:bg-warning/20 inline-flex items-center gap-1"
              onClick={() => setRebuildCollection(col)}
              title={t("Open ec.rebuild plan for this collection")}
            >
              <Wrench size={11}/> {col || t("(default)")}
            </button>
          ))}
          <span className="text-muted ml-1">{t("(opens dry-run; Apply runs the rebuild)")}</span>
        </div>
      )}

      <section className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-6 text-sm text-muted text-center">
            {data.volumes.length === 0
              ? t("This cluster has no EC volumes yet. Run ec.encode to convert volumes.")
              : t("No EC volumes match the filter.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th className="num">{t("Volume")}</th>
                <th>{t("Collection")}</th>
                <th>{t("Health")}</th>
                <th className="num">{t("Size")}</th>
                <th style={{ minWidth: 14 * 22 }}>{t("Shard 0–13")}</th>
                {canRebuild && <th>{t("Action")}</th>}
              </tr></thead>
              <tbody>
                {filtered.map((row) => (
                  <ECRow
                    key={row.id}
                    row={row}
                    clusterId={id}
                    totalShards={totalShards}
                    canRebuild={canRebuild}
                    onRebuild={() => setRebuildCollection(row.collection)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {rebuildCollection !== null && (
        <ECPlanDialog
          kind="rebuild"
          clusterID={id}
          initialCollection={rebuildCollection}
          onClose={() => { setRebuildCollection(null); mutate(); }}
        />
      )}
    </div>
  );
}

function ECRow({ row, clusterId, totalShards, canRebuild, onRebuild }: {
  row: ECVolumeMatrixRow;
  clusterId: string;
  totalShards: number;
  canRebuild: boolean;
  onRebuild: () => void;
}) {
  const { t } = useT();
  return (
    <tr>
      <td className="num font-mono text-xs">
        <Link href={`/clusters/${clusterId}/ec-volumes/${row.id}`} className="hover:underline">
          {row.id}
        </Link>
      </td>
      <td className="font-mono text-xs">
        <Link
          href={`/clusters/${clusterId}/collections/${encodeURIComponent(row.collection || "_default_")}`}
          className="hover:underline"
        >
          {row.collection || t("(default)")}
        </Link>
      </td>
      <td>
        <HealthBadge tone={row.healthy ? "ok" : "err"}>
          {row.shards_present}/{totalShards}
        </HealthBadge>
      </td>
      <td className="num text-xs">{bytes(row.total_size)}</td>
      <td>
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${totalShards}, 18px)` }}>
          {Array.from({ length: totalShards }).map((_, idx) => {
            const locs = row.shards_by_index?.[String(idx)];
            const present = locs && locs.length > 0;
            const titleParts = [
              `${t("Shard")} ${idx}`,
              present ? locs.map((l) => l.server).join(", ") : t("MISSING"),
            ];
            return (
              <div
                key={idx}
                className={`h-5 text-[9px] font-mono text-center leading-5 rounded-sm ${
                  present ? "bg-success/20 text-success" : "bg-danger/25 text-danger border border-danger/60"
                }`}
                title={titleParts.join(" — ")}
              >
                {idx}
              </div>
            );
          })}
        </div>
      </td>
      {canRebuild && (
        <td>
          {row.healthy ? (
            <span className="text-muted/40 text-xs">—</span>
          ) : row.shards_present >= 10 ? (
            <button
              className="btn text-warning border-warning/40 hover:bg-warning/20 inline-flex items-center gap-1 text-xs"
              onClick={onRebuild}
              title={t("Open ec.rebuild plan for this collection")}
            >
              <Wrench size={11}/> {t("Rebuild")}
            </button>
          ) : (
            <span className="text-danger text-xs" title={t("UNRECOVERABLE: fewer than 10 shards remain. ec.rebuild cannot help.")}>
              {t("unrecoverable")}
            </span>
          )}
        </td>
      )}
    </tr>
  );
}
