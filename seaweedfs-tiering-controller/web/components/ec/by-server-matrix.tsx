"use client";

// EC by-server matrix. Pivots the per-volume shard data into a
// server-centric view that the volume table can't easily show:
//
//   - Total shards each server holds across all EC volumes (load balance)
//   - Which DCs / racks each server lives in
//   - Concentration risks: ≥3 shards from the SAME volume on one server
//     (an outage of that server takes 3+ shards offline at once)
//   - Single-rack volumes: every shard of a volume on one rack — a
//     placement bug that breaks the EC durability premise
//
// All derivation runs client-side from the same /clusters/:id/ec-shards
// data the volume table consumes. No new API call.

import { useMemo } from "react";
import Link from "next/link";
import { Server, AlertTriangle, ShieldAlert } from "lucide-react";
import type { ECVolumeMatrixRow } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface ServerStats {
  server: string;
  rack: string;
  dataCenter: string;
  totalShards: number;
  volumesTouched: Set<number>;
  // volumeId → list of shard indices held on this server.
  shardsPerVolume: Map<number, number[]>;
  // Concentration list — volumes where this server holds ≥3 shards.
  concentratedVolumes: number[];
}

interface SingleRackVolume {
  volumeID: number;
  collection: string;
  rack: string;
  shardCount: number;
}

// Threshold for "this server is a concentration risk for that volume".
// EC encoding tolerates loss of up to 4 shards (10+4). A single server
// holding 3 means losing it consumes most of the safety margin.
const CONCENTRATION_THRESHOLD = 3;

export function ECByServerMatrix({ volumes, clusterID }: {
  volumes: ECVolumeMatrixRow[];
  clusterID: string;
}) {
  const { t } = useT();
  const { servers, singleRack } = useMemo(() => buildServerStats(volumes), [volumes]);

  if (servers.length === 0) {
    return (
      <div className="card p-6 text-sm text-muted text-center">
        {t("No EC shard locations to pivot. Run ec.encode on some volumes first.")}
      </div>
    );
  }

  const totalConcentration = servers.reduce((s, x) => s + x.concentratedVolumes.length, 0);

  return (
    <div className="space-y-4">
      {/* Top-level placement risks — surfaced before the table so the
          operator sees them without scrolling. Both lists are empty
          when nothing's wrong, in which case nothing renders. */}
      {(totalConcentration > 0 || singleRack.length > 0) && (
        <section className="card border-warning/40 bg-warning/5 p-3 space-y-2 text-xs">
          <header className="inline-flex items-center gap-1.5 font-semibold text-warning">
            <ShieldAlert size={13}/> {t("Placement risks")}
          </header>
          {totalConcentration > 0 && (
            <p>
              <span className="font-mono text-warning">{totalConcentration}</span>{" "}
              {t("server×volume pairs with ≥{n} shards on one server. Losing that server consumes most of the EC safety margin.").replace("{n}", String(CONCENTRATION_THRESHOLD))}
            </p>
          )}
          {singleRack.length > 0 && (
            <div>
              <p className="mb-1">
                <span className="font-mono text-danger">{singleRack.length}</span>{" "}
                {t("volume(s) with every shard on a single rack — EC durability is rack-fault-tolerant only if shards are spread across racks.")}
              </p>
              <ul className="ml-3 list-disc space-y-0.5 text-[11px] font-mono">
                {singleRack.slice(0, 8).map(v => (
                  <li key={v.volumeID}>
                    <Link href={`/clusters/${clusterID}/ec-volumes/${v.volumeID}`} className="hover:underline">
                      vol {v.volumeID}
                    </Link>{" "}
                    <span className="text-muted">({v.collection || "(default)"})</span>{" "}
                    <span className="text-danger">rack={v.rack}</span>
                    <span className="text-muted ml-1">· {v.shardCount} {t("shards")}</span>
                  </li>
                ))}
                {singleRack.length > 8 && (
                  <li className="text-muted">+{singleRack.length - 8} {t("more")}</li>
                )}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-border px-3 py-2 text-xs font-semibold inline-flex items-center gap-2">
          <Server size={13}/> {t("By server")}
          <span className="font-normal text-muted">— {servers.length} {t("servers, sorted by total shards held")}</span>
        </header>
        <div className="overflow-x-auto">
          <table className="grid w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">{t("Server")}</th>
                <th className="text-left">{t("DC / Rack")}</th>
                <th className="num">{t("Shards")}</th>
                <th className="num">{t("Volumes")}</th>
                <th className="text-left">{t("Concentration")}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map(s => (
                <ServerRow key={s.server} s={s} clusterID={clusterID}/>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ServerRow({ s, clusterID }: { s: ServerStats; clusterID: string }) {
  const { t } = useT();
  return (
    <tr>
      <td className="font-mono text-xs">{s.server}</td>
      <td className="font-mono text-[11px] text-muted">
        {s.dataCenter || "—"} / {s.rack || "—"}
      </td>
      <td className="num tabular-nums">{s.totalShards}</td>
      <td className="num tabular-nums">{s.volumesTouched.size}</td>
      <td>
        {s.concentratedVolumes.length === 0 ? (
          <span className="text-muted text-[11px]">—</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-warning text-[11px]">
            <AlertTriangle size={11}/>
            {s.concentratedVolumes.slice(0, 6).map(v => (
              <Link key={v}
                    href={`/clusters/${clusterID}/ec-volumes/${v}`}
                    className="font-mono hover:underline">
                vol {v} ({s.shardsPerVolume.get(v)!.length})
              </Link>
            )).reduce<React.ReactNode[]>((acc, el, i, arr) => {
              acc.push(el);
              if (i < arr.length - 1) acc.push(<span key={`sep${i}`} className="text-muted/60">,</span>);
              return acc;
            }, [])}
            {s.concentratedVolumes.length > 6 && (
              <span className="text-muted">+{s.concentratedVolumes.length - 6}</span>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

// buildServerStats pivots volume rows → server rows. Pure derivation,
// no I/O. Also surfaces single-rack volumes — independent of the
// per-server stats but cheap to compute in the same pass.
function buildServerStats(volumes: ECVolumeMatrixRow[]): {
  servers: ServerStats[];
  singleRack: SingleRackVolume[];
} {
  const byServer = new Map<string, ServerStats>();
  const singleRack: SingleRackVolume[] = [];

  for (const v of volumes) {
    // Per-volume rack inventory for the single-rack detector.
    const racksForThisVolume = new Set<string>();
    let shardCountThisVolume = 0;

    for (const [idxStr, locs] of Object.entries(v.shards_by_index ?? {})) {
      const idx = Number(idxStr);
      for (const loc of locs) {
        if (loc.rack) racksForThisVolume.add(loc.rack);
        shardCountThisVolume++;

        let s = byServer.get(loc.server);
        if (!s) {
          s = {
            server: loc.server,
            rack: loc.rack ?? "",
            dataCenter: loc.data_center ?? "",
            totalShards: 0,
            volumesTouched: new Set(),
            shardsPerVolume: new Map(),
            concentratedVolumes: [],
          };
          byServer.set(loc.server, s);
        }
        s.totalShards++;
        s.volumesTouched.add(v.id);
        const arr = s.shardsPerVolume.get(v.id);
        if (arr) arr.push(idx);
        else s.shardsPerVolume.set(v.id, [idx]);
      }
    }

    // A volume is "single-rack" if it has ≥2 shards and all of them
    // sit in one rack. Single-shard volumes are skipped — that's
    // almost certainly a degraded state already covered by the
    // volume table's "missing shards" surfacing.
    if (racksForThisVolume.size === 1 && shardCountThisVolume >= 2) {
      singleRack.push({
        volumeID: v.id,
        collection: v.collection,
        rack: [...racksForThisVolume][0],
        shardCount: shardCountThisVolume,
      });
    }
  }

  // Resolve concentration per server.
  for (const s of byServer.values()) {
    for (const [vol, idxs] of s.shardsPerVolume) {
      if (idxs.length >= CONCENTRATION_THRESHOLD) {
        s.concentratedVolumes.push(vol);
      }
    }
    s.concentratedVolumes.sort((a, b) =>
      (s.shardsPerVolume.get(b)!.length) - (s.shardsPerVolume.get(a)!.length)
    );
  }

  const servers = [...byServer.values()].sort((a, b) => b.totalShards - a.totalShards);
  return { servers, singleRack };
}
