"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Server, ArrowLeft } from "lucide-react";
import { useVolumeServer, type VolumeReplicaRow } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { HealthBadge } from "@/components/health-badge";

export default function VolumeServerDetailPage() {
  const { id, addr } = useParams<{ id: string; addr: string }>();
  const decoded = decodeURIComponent(addr);
  const { has, loading: capsLoading } = useCaps();
  const { t } = useT();
  const { data, isLoading, error } = useVolumeServer(id, decoded);

  const collectionRows = useMemo(() => {
    if (!data) return [] as { collection: string; replicas: number; bytes: number }[];
    const groups = new Map<string, { replicas: number; bytes: number }>();
    for (const v of data.volumes) {
      const key = v.Collection || t("(default)");
      const existing = groups.get(key) || { replicas: 0, bytes: 0 };
      groups.set(key, { replicas: existing.replicas + 1, bytes: existing.bytes + (v.Size || 0) });
    }
    return Array.from(groups.entries())
      .map(([collection, agg]) => ({ collection, ...agg }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [data, t]);

  if (capsLoading) return null;
  if (!has("volume.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view volume servers.")}</div>;
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
        <Loader2 size={14} className="animate-spin"/> {t("Loading volume server…")}
      </div>
    );
  }

  const fill = data.max_volumes > 0 ? data.volumes.length / Math.max(1, Number(data.max_volumes)) : 0;
  const tone = fill >= 0.9 ? "err" : fill >= 0.75 ? "warn" : "ok";

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <Link href={`/clusters/${id}/topology`} className="text-xs text-muted inline-flex items-center gap-1 hover:text-text">
            <ArrowLeft size={12}/> {t("Back to topology")}
          </Link>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2 mt-1">
            <Server size={18}/> <span className="font-mono">{data.address}</span>
          </h1>
          <p className="text-xs text-muted">
            {data.data_center && <>{t("DC")} <span className="font-mono text-text">{data.data_center}</span></>}
            {data.rack && <> · {t("Rack")} <span className="font-mono text-text">{data.rack}</span></>}
          </p>
        </div>
        <HealthBadge tone={tone}>{(fill * 100).toFixed(0)}% {t("full")}</HealthBadge>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label={t("Volumes")} value={data.volume_count.toLocaleString()}/>
        <Kpi label={t("Used bytes")} value={bytes(data.used_bytes)}/>
        <Kpi label={t("Max volumes")} value={Number(data.max_volumes).toLocaleString()}/>
        <Kpi label={t("Free slots")} value={Number(data.free_volumes).toLocaleString()}/>
        <Kpi label={t("EC shards")} value={data.ec_shard_count.toLocaleString()} hint={`${data.read_only_count.toLocaleString()} ${t("read-only")}`}/>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-3">{t("Disks")}</h2>
          {data.disks.length === 0 ? (
            <p className="text-xs text-muted">{t("No disk topology reported.")}</p>
          ) : (
            <table className="grid">
              <thead><tr>
                <th>{t("Type")}</th>
                <th className="num">{t("Volumes")}</th>
                <th className="num">{t("Max")}</th>
                <th className="num">{t("Free")}</th>
                <th className="num">{t("Used")}</th>
              </tr></thead>
              <tbody>
                {data.disks.map((disk, idx) => (
                  <tr key={`${disk.disk_type || "default"}-${idx}`}>
                    <td className="font-mono text-xs">{disk.disk_type || "default"}</td>
                    <td className="num">{disk.volume_count.toLocaleString()}</td>
                    <td className="num">{disk.max_volume_count.toLocaleString()}</td>
                    <td className="num">{disk.free_volume_count.toLocaleString()}</td>
                    <td className="num">{bytes(disk.used_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-3">{t("Collections on this server")}</h2>
          {collectionRows.length === 0 ? (
            <p className="text-xs text-muted">{t("No volumes hosted here.")}</p>
          ) : (
            <table className="grid">
              <thead><tr>
                <th>{t("Collection")}</th>
                <th className="num">{t("Replicas")}</th>
                <th className="num">{t("Size")}</th>
              </tr></thead>
              <tbody>
                {collectionRows.map((row) => (
                  <tr key={row.collection}>
                    <td className="font-mono text-xs">
                      <Link
                        href={`/clusters/${id}/collections/${encodeURIComponent(row.collection === t("(default)") ? "_default_" : row.collection)}`}
                        className="hover:underline"
                      >
                        {row.collection}
                      </Link>
                    </td>
                    <td className="num">{row.replicas.toLocaleString()}</td>
                    <td className="num">{bytes(row.bytes)}</td>
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
              <th>{t("Collection")}</th>
              <th>{t("Placement")}</th>
              <th className="num">{t("Size")}</th>
              <th className="num">{t("Files")}</th>
              <th className="num">{t("Deleted")}</th>
              <th>{t("Flags")}</th>
            </tr></thead>
            <tbody>
              {data.volumes.map((v, idx) => <VolumeRow key={`${v.ID}-${idx}`} v={v} clusterId={id}/>)}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function VolumeRow({ v, clusterId }: { v: VolumeReplicaRow; clusterId: string }) {
  const { t } = useT();
  return (
    <tr>
      <td className="num font-mono">
        <Link href={`/clusters/${clusterId}/volumes/${v.ID}`} className="hover:underline">{v.ID}</Link>
      </td>
      <td className="font-mono text-xs">
        <Link
          href={`/clusters/${clusterId}/collections/${encodeURIComponent(v.Collection || "_default_")}`}
          className="hover:underline"
        >
          {v.Collection || t("(default)")}
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
