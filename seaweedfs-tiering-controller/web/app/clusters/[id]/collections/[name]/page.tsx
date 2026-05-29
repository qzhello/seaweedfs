"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Scale } from "lucide-react";
import { useCollectionDetail, useVolumes, type VolumeReplicaRow } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { VolumeBalanceDialog } from "@/components/volume/balance-dialog";
import { HealthBadge } from "@/components/health-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { CardSkeleton, TableSkeleton } from "@/components/table-skeleton";

const SENTINEL_DEFAULT = "_default_";

export default function ClusterCollectionDetailPage() {
  const { id, name } = useParams<{ id: string; name: string }>();
  const decoded = decodeURIComponent(name);
  const collectionName = decoded === SENTINEL_DEFAULT ? "" : decoded;
  const { has, loading: capsLoading } = useCaps();
  const { t } = useT();
  const { data, error } = useCollectionDetail(id, decoded);
  // useVolumes feeds the balance dialog's autocomplete so the user can scope
  // moves by DC/rack/node — same data we'd ask for if they opened the dialog
  // from the global collections page.
  const { data: vd } = useVolumes(id);
  const allVolumes = (vd as { items?: VolumeReplicaRow[] } | undefined)?.items ?? [];
  const [balanceOpen, setBalanceOpen] = useState(false);

  const serverRows = useMemo(() => {
    if (!data) return [] as { server: string; replicas: number }[];
    return Object.entries(data.server_distribution)
      .map(([server, replicas]) => ({ server, replicas }))
      .sort((a, b) => b.replicas - a.replicas);
  }, [data]);

  const replicationRows = useMemo(() => {
    if (!data) return [] as { code: string; count: number }[];
    return Object.entries(data.replication_distribution)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  if (capsLoading) return null;
  if (!has("volume.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view collection details.")}</div>;
  }
  if (error) {
    return (
      <div className="card p-5 border-danger/40 bg-danger/10 text-danger text-xs font-mono whitespace-pre-wrap">
        {String((error as Error).message ?? error)}
      </div>
    );
  }

  const displayName = collectionName || t("(default)");

  return (
    <div className="space-y-5">
      <Breadcrumb items={[
        { label: t("Collections"), href: "/collections" },
        { label: displayName },
      ]}/>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold">{displayName}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn inline-flex items-center gap-1"
            onClick={() => setBalanceOpen(true)}
            disabled={!has("volume.balance")}
            title={has("volume.balance") ? t("Open balance plan/apply dialog") : t("Requires volume.balance capability")}
          >
            <Scale size={12}/> {t("Balance volumes…")}
          </button>
        </div>
      </header>

      {data ? (
        <>
          <div className="flex items-end gap-4 flex-wrap">
            <p className="text-xs text-muted">{data.volume_count.toLocaleString()} {t("volumes")} · {bytes(data.total_size)}</p>
          </div>

          <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label={t("Volumes")} value={data.volume_count.toLocaleString()}/>
            <Kpi label={t("Replicas")} value={data.replica_row_count.toLocaleString()} hint={t("rows across all nodes")}/>
            <Kpi label={t("Total size")} value={bytes(data.total_size)}/>
            <Kpi label={t("Files")} value={data.file_count.toLocaleString()} hint={`${data.delete_count.toLocaleString()} ${t("deleted")} (${bytes(data.deleted_bytes)})`}/>
            <Kpi label={t("EC volumes")} value={data.ec_volume_count.toLocaleString()} hint={`${data.read_only_volumes.toLocaleString()} ${t("read-only")}`}/>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">{t("Replication placement")}</h2>
              {replicationRows.length === 0 ? (
                <p className="text-xs text-muted">{t("No data.")}</p>
              ) : (
                <table className="grid">
                  <thead><tr><th>{t("Placement")}</th><th className="num">{t("Replica rows")}</th></tr></thead>
                  <tbody>
                    {replicationRows.map((row) => (
                      <tr key={row.code}>
                        <td className="font-mono">
                          {row.code === "ec"
                            ? <HealthBadge tone="ok">EC</HealthBadge>
                            : <span>{row.code}</span>}
                        </td>
                        <td className="num">{row.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">{t("Per-server distribution")}</h2>
              {serverRows.length === 0 ? (
                <p className="text-xs text-muted">{t("No data.")}</p>
              ) : (
                <table className="grid">
                  <thead><tr><th>{t("Server")}</th><th className="num">{t("Replica rows")}</th></tr></thead>
                  <tbody>
                    {serverRows.map((row) => (
                      <tr key={row.server}>
                        <td className="font-mono text-xs">
                          <Link href={`/clusters/${id}/volume-servers/${encodeURIComponent(row.server)}`} className="hover:underline">
                            {row.server}
                          </Link>
                        </td>
                        <td className="num">{row.replicas.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="grid">
                <thead><tr>
                  <th className="num">{t("Volume")}</th>
                  <th>{t("Server")}</th>
                  <th>{t("Placement")}</th>
                  <th className="num">{t("Size")}</th>
                  <th className="num">{t("Files")}</th>
                  <th className="num">{t("Deleted")}</th>
                  <th>{t("Flags")}</th>
                </tr></thead>
                <tbody>
                  {data.volumes.map((v, idx) => (
                    <tr key={`${v.ID}-${v.Server}-${idx}`}>
                      <td className="num font-mono">
                        <Link href={`/clusters/${id}/volumes/${v.ID}`} className="hover:underline">{v.ID}</Link>
                      </td>
                      <td className="font-mono text-xs">
                        <Link href={`/clusters/${id}/volume-servers/${encodeURIComponent(v.Server)}`} className="hover:underline">
                          {v.Server}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">{v.IsEC ? "ec" : String(v.ReplicaPlace).padStart(3, "0")}</td>
                      <td className="num">{bytes(v.Size)}</td>
                      <td className="num">{(v.FileCount || 0).toLocaleString()}</td>
                      <td className="num text-muted">{bytes(v.DeletedBytes || 0)} ({(v.DeleteCount || 0).toLocaleString()})</td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          {v.ReadOnly && <span className="badge border-muted/40 text-muted text-[10px]">{t("read-only")}</span>}
                          {v.IsEC && <span className="badge border-success/40 text-success text-[10px]">EC{v.Shards?.length ? `:${v.Shards.length}` : ""}</span>}
                          {v.RemoteStorageName && <span className="badge border-accent/40 text-accent text-[10px]">tier:{v.RemoteStorageName}</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <CardSkeleton lines={4}/>
          <TableSkeleton rows={3}/>
          <TableSkeleton rows={3}/>
        </>
      )}

      {balanceOpen && (
        <VolumeBalanceDialog
          clusterID={id}
          allVolumes={allVolumes}
          initialCollection={collectionName}
          onClose={() => setBalanceOpen(false)}
          onDone={() => setBalanceOpen(false)}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
