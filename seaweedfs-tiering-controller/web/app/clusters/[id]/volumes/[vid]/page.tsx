"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity } from "lucide-react";
import { useVolumeDetail, type VolumeReplicaRow } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { HealthBadge } from "@/components/health-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { CardSkeleton, TableSkeleton } from "@/components/table-skeleton";

const EC_TOTAL_SHARDS = 14;

export default function VolumeDetailPage() {
  const { id, vid } = useParams<{ id: string; vid: string }>();
  const { has, loading: capsLoading } = useCaps();
  const { t } = useT();
  const { data, isLoading, error } = useVolumeDetail(id, vid);

  if (capsLoading) return null;
  if (!has("volume.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view volume details.")}</div>;
  }
  if (error) {
    return (
      <div className="card p-5 border-danger/40 bg-danger/10 text-danger text-xs font-mono whitespace-pre-wrap">
        {String((error as Error).message ?? error)}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Breadcrumb items={[
        { label: t("Topology"), href: `/clusters/${id}/topology` },
        { label: `${t("Volume")} #${vid}` },
      ]}/>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-semibold">
          {t("Volume")} <span className="font-mono">#{vid}</span>
        </h1>
      </header>

      {data ? (
        <>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-muted">
                {t("Collection")}: <Link
                  href={`/clusters/${id}/collections/${encodeURIComponent(data.collection || "_default_")}`}
                  className="font-mono text-text hover:underline"
                >{data.collection || t("(default)")}</Link>
                <span className="mx-2 text-muted/40">|</span>
                {t("Placement")}: <span className="font-mono text-text">{data.placement}</span>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/volumes/${data.id}`}
                className="btn inline-flex items-center gap-1"
                title={t("View read pattern / cohort analytics")}
              >
                <Activity size={12}/> {t("View analytics")}
              </Link>
              {data.is_ec && <HealthBadge tone={data.ec_shards_missing.length === 0 ? "ok" : "err"}>
                EC {data.ec_shard_count}/{EC_TOTAL_SHARDS}
              </HealthBadge>}
              {data.read_only && <span className="badge border-muted/40 text-muted text-[10px]">{t("read-only")}</span>}
            </div>
          </div>

          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label={t("Total size")} value={bytes(data.total_size)}/>
            <Kpi label={t("Files")} value={data.file_count.toLocaleString()} hint={`${data.delete_count.toLocaleString()} ${t("deleted")} (${bytes(data.deleted_bytes)})`}/>
            <Kpi label={t("Replicas")} value={data.replica_count.toLocaleString()} hint={data.servers.join(", ")}/>
            <Kpi label={data.is_ec ? t("EC shards present") : t("Placement")} value={data.is_ec ? `${data.ec_shard_count}/${EC_TOTAL_SHARDS}` : data.placement}/>
          </section>

          {data.is_ec && (
            <section className="card p-4">
              <h2 className="text-sm font-semibold mb-3">{t("EC shard layout")}</h2>
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${EC_TOTAL_SHARDS}, minmax(0, 1fr))` }}>
                {Array.from({ length: EC_TOTAL_SHARDS }).map((_, idx) => {
                  const present = data.ec_shards_present.includes(idx);
                  return (
                    <div
                      key={idx}
                      className={`text-[11px] text-center font-mono py-2 rounded ${
                        present ? "bg-success/10 text-success border border-success/30" : "bg-danger/10 text-danger border border-danger/40"
                      }`}
                      title={present ? t("present") : t("missing")}
                    >
                      {idx}
                    </div>
                  );
                })}
              </div>
              {data.ec_shards_missing.length > 0 && (
                <p className="text-xs text-danger mt-2">
                  {t("Missing shards")}: <span className="font-mono">{data.ec_shards_missing.join(", ")}</span>
                </p>
              )}
            </section>
          )}

          <section className="card overflow-hidden">
            <div className="p-3 border-b border-border/40">
              <h2 className="text-sm font-semibold">{data.is_ec ? t("EC replicas") : t("Replica placements")}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="grid">
                <thead><tr>
                  <th>{t("Server")}</th>
                  <th>{t("Data center")}</th>
                  <th>{t("Rack")}</th>
                  <th className="num">{t("Size")}</th>
                  {data.is_ec
                    ? <th>{t("EC shards")}</th>
                    : <>
                        <th className="num">{t("Files")}</th>
                        <th className="num">{t("Deleted")}</th>
                      </>}
                  <th>{t("Flags")}</th>
                </tr></thead>
                <tbody>
                  {data.replicas.map((r, idx) => <ReplicaRow key={`${r.Server}-${idx}`} r={r} clusterId={id} isEc={data.is_ec}/>)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <CardSkeleton lines={5}/>
          <TableSkeleton rows={3}/>
        </>
      )}
    </div>
  );
}

function ReplicaRow({ r, clusterId, isEc }: { r: VolumeReplicaRow; clusterId: string; isEc: boolean }) {
  const { t } = useT();
  return (
    <tr>
      <td className="font-mono text-xs">
        <Link href={`/clusters/${clusterId}/volume-servers/${encodeURIComponent(r.Server)}`} className="hover:underline">
          {r.Server}
        </Link>
      </td>
      <td className="text-xs">{r.DataCenter || "—"}</td>
      <td className="text-xs">{r.Rack || "—"}</td>
      <td className="num">{bytes(r.Size)}</td>
      {isEc ? (
        <td className="font-mono text-xs">{r.Shards?.length ? r.Shards.join(",") : "—"}</td>
      ) : (
        <>
          <td className="num">{(r.FileCount || 0).toLocaleString()}</td>
          <td className="num text-muted">{bytes(r.DeletedBytes || 0)} ({(r.DeleteCount || 0).toLocaleString()})</td>
        </>
      )}
      <td>
        <div className="flex gap-1 flex-wrap">
          {r.ReadOnly && <span className="badge border-muted/40 text-muted text-[10px]">{t("read-only")}</span>}
          {r.RemoteStorageName && <span className="badge border-accent/40 text-accent text-[10px]">tier:{r.RemoteStorageName}</span>}
        </div>
      </td>
    </tr>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted truncate" title={hint}>{hint}</div>}
    </div>
  );
}
