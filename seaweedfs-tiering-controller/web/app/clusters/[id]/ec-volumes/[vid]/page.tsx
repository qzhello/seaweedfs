"use client";

// Single-EC-volume drilldown. Pivots the per-shard locations into:
//   - a 14-cell shard strip identical in shape to the matrix view,
//   - a per-host table ("who holds what"),
//   - a placement summary (DCs, racks) so single-rack EC volumes are
//     obvious.
// Repair guidance is intentionally informational: we surface the
// `ec.decode` / `ec.encode` shell hint instead of wiring a button —
// the destructive path stays in the dedicated EC dialogs.

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Layers, ArrowLeft, AlertTriangle, Server, Wrench } from "lucide-react";
import {
  useECVolumeDetail, type ECVolumeHostSummary, type ECShardLocation,
} from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { HealthBadge } from "@/components/health-badge";
import { ECPlanDialog } from "@/components/ec/plan-dialog";

export default function ECVolumeDetailPage() {
  const { id, vid } = useParams<{ id: string; vid: string }>();
  const { has, loading: capsLoading } = useCaps();
  const { t } = useT();
  const { data, isLoading, error, mutate } = useECVolumeDetail(id, vid);
  const [rebuildOpen, setRebuildOpen] = useState(false);

  if (capsLoading) return null;
  if (!has("volume.read")) {
    return (
      <div className="card p-6 text-sm text-muted">
        {t("You do not have permission to view volume details.")}
      </div>
    );
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
        <Loader2 size={14} className="animate-spin" /> {t("Loading EC volume…")}
      </div>
    );
  }

  const totalShards = data.total_shards;
  const collectionHref = `/clusters/${id}/collections/${encodeURIComponent(data.collection || "_default_")}`;

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-muted">
            <Link href={`/clusters/${id}/ec-shards`} className="inline-flex items-center gap-1 hover:underline">
              <ArrowLeft size={11} /> {t("All EC volumes")}
            </Link>
          </div>
          <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2 mt-1">
            <Layers size={16} /> {t("EC volume")} #{data.id}
          </h2>
          <p className="text-xs text-muted mt-0.5">
            {t("Collection")}:{" "}
            <Link href={collectionHref} className="font-mono hover:underline">
              {data.collection || t("(default)")}
            </Link>
            <span className="mx-2 text-muted/40">|</span>
            {bytes(data.total_size)}
            <span className="mx-2 text-muted/40">|</span>
            <HealthBadge tone={data.healthy ? "ok" : "err"}>
              {data.shards_present}/{totalShards} {t("shards")}
            </HealthBadge>
          </p>
        </div>
      </header>

      {/* Repair hint — only when missing shards */}
      {!data.healthy && (
        <div className="card p-4 border-warning/40 bg-warning/10 text-warning text-xs space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 font-semibold">
                <AlertTriangle size={14} /> {t("Missing shards")}
              </div>
              <div>
                {t("Missing shard indices")}: <span className="font-mono">{data.missing.join(", ")}</span>
              </div>
              <div className="text-muted">
                {data.shards_present >= 10
                  ? t("Recoverable: ≥10 shards still present. ec.rebuild can regenerate the missing ones.")
                  : t("UNRECOVERABLE: fewer than 10 shards remain. ec.rebuild cannot help.")}
              </div>
            </div>
            {data.shards_present >= 10 && has("volume.write") && (
              <button
                className="btn bg-warning/20 border-warning/40 text-warning hover:bg-warning/30 inline-flex items-center gap-1 shrink-0"
                onClick={() => setRebuildOpen(true)}
                title={t("Open ec.rebuild plan for this collection")}
              >
                <Wrench size={12} /> {t("Rebuild shards")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Shard strip — same layout as the list page so the eye carries over */}
      <section className="card p-4 space-y-2">
        <div className="text-xs font-semibold inline-flex items-center gap-1.5">
          {t("Shard layout")}
        </div>
        <div className="overflow-x-auto">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${totalShards}, 32px)` }}>
            {Array.from({ length: totalShards }).map((_, idx) => {
              const locs = data.shards_by_index?.[String(idx)] ?? [];
              const present = locs.length > 0;
              const title = present
                ? `${t("Shard")} ${idx} — ${locs.map((l: ECShardLocation) => l.server).join(", ")}`
                : `${t("Shard")} ${idx} — ${t("MISSING")}`;
              return (
                <div
                  key={idx}
                  className={`h-7 text-[10px] font-mono text-center leading-7 rounded ${
                    present
                      ? "bg-success/20 text-success"
                      : "bg-danger/25 text-danger border border-danger/60"
                  }`}
                  title={title}
                >
                  {idx}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted pt-1">
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-success/30 mr-1 align-middle" />{t("present")}</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-danger/40 mr-1 align-middle" />{t("missing")}</span>
          <span className="text-muted/60">·</span>
          <span>{data.data_centers.length} {t("DC(s)")}</span>
          <span>·</span>
          <span>{data.racks.length} {t("rack(s)")}</span>
        </div>
      </section>

      {/* Shard -> hosts table — for each of the 14 indices, which
          server(s) hold a copy. This is the view operators actually
          use when planning repairs: "who has shard 7?" */}
      <section className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold">
          {t("Shard → hosts")}
        </div>
        <div className="overflow-x-auto">
          <table className="grid">
            <thead>
              <tr>
                <th className="num">{t("Shard")}</th>
                <th>{t("Status")}</th>
                <th>{t("Hosts")}</th>
                <th>{t("Placement")}</th>
                <th className="num">{t("Size")}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: totalShards }).map((_, idx) => {
                const locs = data.shards_by_index?.[String(idx)] ?? [];
                const present = locs.length > 0;
                const totalSize = locs.reduce((s: number, l: ECShardLocation) => s + (l.size ?? 0), 0);
                return (
                  <tr key={idx}>
                    <td className="num font-mono text-xs">{idx}</td>
                    <td>
                      {present
                        ? <HealthBadge tone="ok">{t("present")}</HealthBadge>
                        : <HealthBadge tone="err">{t("MISSING")}</HealthBadge>}
                    </td>
                    <td className="font-mono text-xs">
                      {present
                        ? locs.map((l: ECShardLocation, i: number) => (
                            <span key={`${l.server}-${i}`}>
                              {i > 0 && <span className="text-muted/40">, </span>}
                              <Link
                                href={`/clusters/${id}/volume-servers/${encodeURIComponent(l.server)}`}
                                className="hover:underline"
                              >
                                {l.server}
                              </Link>
                            </span>
                          ))
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="text-xs text-muted">
                      {present
                        ? Array.from(new Set(locs.map((l: ECShardLocation) => `${l.data_center || "?"}/${l.rack || "?"}`))).join(", ")
                        : "—"}
                    </td>
                    <td className="num text-xs">{present ? bytes(totalSize) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-host table — who holds what */}
      <section className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold inline-flex items-center gap-1.5">
          <Server size={12} /> {t("Hosts holding this volume")}
        </div>
        {data.hosts.length === 0 ? (
          <div className="p-6 text-sm text-muted text-center">{t("No host holds any shard of this volume.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead>
                <tr>
                  <th>{t("Server")}</th>
                  <th>{t("DC")}</th>
                  <th>{t("Rack")}</th>
                  <th className="num">{t("Shards")}</th>
                  <th>{t("Indices")}</th>
                  <th className="num">{t("Size")}</th>
                </tr>
              </thead>
              <tbody>
                {data.hosts.map((h: ECVolumeHostSummary) => (
                  <tr key={h.server}>
                    <td className="font-mono text-xs">
                      <Link
                        href={`/clusters/${id}/volume-servers/${encodeURIComponent(h.server)}`}
                        className="hover:underline"
                      >
                        {h.server}
                      </Link>
                    </td>
                    <td className="text-xs text-muted">{h.data_center || "—"}</td>
                    <td className="text-xs text-muted">{h.rack || "—"}</td>
                    <td className="num text-xs">{h.shard_count}</td>
                    <td className="font-mono text-[11px] text-muted">{h.shards.join(", ")}</td>
                    <td className="num text-xs">{bytes(h.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {rebuildOpen && (
        <ECPlanDialog
          kind="rebuild"
          clusterID={id}
          initialCollection={data.collection || ""}
          onClose={() => { setRebuildOpen(false); mutate(); }}
        />
      )}
    </div>
  );
}
