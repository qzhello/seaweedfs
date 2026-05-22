"use client";

// Replication / Raft panel. Two halves:
//   - Master raft: leader, peer connectivity, latency, consistency.
//   - Per-volume replication: sole copies, under/over replication,
//     EC shard health.
//
// Both auto-refresh every 15s (SWR refreshInterval on the hooks).
// Used during incidents — the operator wants to see "who's leader,
// who can't reach quorum, which volumes lost replicas" in one place.

import {
  Network, CheckCircle2, AlertTriangle, Layers,
} from "lucide-react";
import Link from "next/link";
import {
  useClusterMasters, useReplicationHealth,
  type ClusterMasterRow, type ReplicaIssue, type ECShardHealth,
} from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { HealthOverview } from "./_health-overview";

export default function RaftPage() {
  const { t } = useT();
  return (
    <Can cap="volume.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: masters, error: mErr, mutate: refetchMasters, isValidating: mLoading } = useClusterMasters(clusterID || undefined);
  const { data: repl, error: rErr, mutate: refetchRepl, isValidating: rLoading } = useReplicationHealth(clusterID || undefined);

  if (!clusterID) {
    return (
      <div className="space-y-4">
        <Header t={t}/>
        <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>
      </div>
    );
  }

  const refreshAll = () => { refetchMasters(); refetchRepl(); };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <Header t={t}/>
        <RefreshButton loading={mLoading || rLoading} onClick={refreshAll}/>
      </header>

      {mErr && <ErrorPanel error={mErr}/>}
      {rErr && <ErrorPanel error={rErr}/>}

      {/* Rolled-up durability score */}
      <HealthOverview masters={masters} repl={repl}/>

      {/* Master raft */}
      <MasterRaftSection t={t} data={masters} clusterID={clusterID}/>

      {/* Volume replication health */}
      <ReplicationSection t={t} data={repl} clusterID={clusterID}/>
    </div>
  );
}

function Header({ t }: { t: (k: string) => string }) {
  return (
    <div>
      <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
        <Network size={20}/> {t("Durability")}
      </h1>
      <p className="text-xs text-muted mt-1 max-w-2xl">
        {t("Master raft quorum + per-volume replication health. Auto-refreshes every 15s.")}
      </p>
    </div>
  );
}

// ---------- Master raft ----------

function MasterRaftSection({ t, data, clusterID }: {
  t: (k: string) => string;
  data: import("@/lib/api").ClusterMastersResponse | undefined;
  clusterID: string;
}) {
  if (!data) {
    return <section className="card p-4 text-sm text-muted">{t("Loading masters…")}</section>;
  }
  const masters = data.masters;
  const leaders = masters.filter(m => m.is_leader);
  const reachable = masters.filter(m => m.reachable).length;
  const healthyOverall = data.consistency.healthy && leaders.length === 1 && reachable === masters.length;

  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-xs font-semibold inline-flex items-center gap-2">
          <Network size={12}/> {t("Master raft")}
        </div>
        <span className={`badge text-[10px] inline-flex items-center gap-1 ${
          healthyOverall ? "border-emerald-400/40 text-emerald-300"
          : "border-rose-400/40 text-rose-300"
        }`}>
          {healthyOverall ? <CheckCircle2 size={10}/> : <AlertTriangle size={10}/>}
          {healthyOverall ? t("quorum healthy") : t("quorum issue")}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        <Tile label={t("Masters")} value={`${reachable}/${masters.length}`} sub={t("reachable")}/>
        <Tile label={t("Leaders observed")} value={String(leaders.length)} sub={leaders.length === 1 ? t("single leader (good)") : leaders.length === 0 ? t("no leader (split-brain)") : t("multiple leaders (split-brain)")}/>
        <Tile label={t("Leader agreement")} value={data.consistency.leader_agreement ? "✓" : "✗"} sub={data.consistency.leader_agreement ? t("all masters agree") : t("masters disagree")}/>
        <Tile label={t("Peer set agreement")} value={data.consistency.peer_set_agreement ? "✓" : "✗"} sub={t("expected: {n} peers").replace("{n}", String(data.consistency.expected_peers.length))}/>
      </div>

      {data.consistency.issues.length > 0 && (
        <div className="px-4 pb-3 space-y-1">
          {data.consistency.issues.map((iss, i) => (
            <div key={i} className="card p-2 border-warning/40 bg-warning/10 text-xs text-warning inline-flex items-start gap-2">
              <AlertTriangle size={12} className="shrink-0 mt-0.5"/>
              <div><span className="font-mono">{iss.code}</span> · {iss.message}</div>
            </div>
          ))}
        </div>
      )}

      <table className="grid">
        <thead>
          <tr>
            <th>{t("Address")}</th>
            <th>{t("Role")}</th>
            <th className="text-right">{t("Latency")}</th>
            <th>{t("Reported leader")}</th>
            <th>{t("Peers reported")}</th>
            <th>{t("Health")}</th>
          </tr>
        </thead>
        <tbody>
          {masters.map(m => <MasterRow key={m.address} m={m} t={t}/>)}
        </tbody>
      </table>

      <footer className="px-3 py-2 border-t border-border text-[11px] text-muted">
        {t("Configured master:")} <span className="font-mono">{data.configured_master}</span> ·{" "}
        <Link href={`/clusters/${clusterID}/masters`} className="text-accent hover:underline">{t("Open masters detail")} →</Link>
      </footer>
    </section>
  );
}

function MasterRow({ m, t }: { m: ClusterMasterRow; t: (k: string) => string }) {
  const healthTone = m.health === "ok" ? "border-emerald-400/40 text-emerald-300"
    : m.health === "warn" ? "border-warning/40 text-warning"
    : "border-rose-400/40 text-rose-300";
  return (
    <tr>
      <td className="font-mono text-sm">
        {m.address}
        {m.is_leader && <span className="badge text-[10px] ml-1 border-emerald-400/40 text-emerald-300">leader</span>}
      </td>
      <td className="text-xs">{m.suffrage}</td>
      <td className="text-right font-mono text-xs">
        {m.reachable ? `${m.latency_ms}ms` : <span className="text-rose-300">—</span>}
      </td>
      <td className="font-mono text-[11px] text-muted truncate max-w-[180px]" title={m.reported_leader}>{m.reported_leader || "—"}</td>
      <td className="text-[11px] text-muted">
        {m.reported_peers.length > 0 ? `${m.reported_peers.length} ${t("peer(s)")}` : "—"}
      </td>
      <td>
        <span className={`badge text-[10px] ${healthTone}`}>{m.health}</span>
        {m.warnings.length > 0 && (
          <span className="text-[10px] text-warning ml-1" title={m.warnings.join(", ")}>
            +{m.warnings.length} {t("warn")}
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------- Replication ----------

function ReplicationSection({ t, data, clusterID }: {
  t: (k: string) => string;
  data: import("@/lib/api").ReplicationHealthResp | undefined;
  clusterID: string;
}) {
  if (!data) {
    return <section className="card p-4 text-sm text-muted">{t("Loading replication health…")}</section>;
  }
  const allHealthy = data.sole_copies === 0 && data.under_replicated === 0 && data.ec_potentially_short_shards === 0;
  const healthyPct = data.normal_volumes > 0 ? (data.healthy_volumes / data.normal_volumes) : 1;
  // Tolerate a null/absent field from an older backend build.
  const singleCopy = data.single_copy_volumes ?? 0;
  // Tolerate a null payload from an older backend build — these are [] in current responses.
  const issues = data.issues ?? [];
  const ecShardsAtRisk = data.ec_shards_at_risk ?? [];

  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-xs font-semibold inline-flex items-center gap-2">
          <Layers size={12}/> {t("Volume replication")}
        </div>
        <span className={`badge text-[10px] inline-flex items-center gap-1 ${
          allHealthy ? "border-emerald-400/40 text-emerald-300"
          : data.sole_copies > 0 ? "border-rose-400/40 text-rose-300"
          : "border-warning/40 text-warning"
        }`}>
          {allHealthy ? <CheckCircle2 size={10}/> : <AlertTriangle size={10}/>}
          {allHealthy ? t("all volumes healthy") : t("{n} need attention").replace("{n}", String(data.sole_copies + data.under_replicated + data.ec_potentially_short_shards))}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-4">
        <Tile label={t("Total volumes")} value={data.total_volumes.toLocaleString()}
          sub={`${data.normal_volumes} ${t("normal")} · ${data.ec_volumes} EC`}/>
        <Tile
          label={t("Healthy")}
          value={data.healthy_volumes.toLocaleString()}
          sub={`${Math.round(healthyPct * 100)}%`}
          tone="emerald"/>
        <Tile
          label={t("Single-copy volumes")}
          value={singleCopy.toLocaleString()}
          sub={t("data-loss exposure")}
          tone={singleCopy > 0 ? "amber" : "muted"}/>
        <Tile
          label={t("Sole copies")}
          value={data.sole_copies.toLocaleString()}
          sub={t("below configured policy")}
          tone={data.sole_copies > 0 ? "rose" : "muted"}/>
        <Tile
          label={t("Under-replicated")}
          value={data.under_replicated.toLocaleString()}
          sub={t("fewer copies than configured")}
          tone={data.under_replicated > 0 ? "amber" : "muted"}/>
        <Tile
          label={t("EC at risk")}
          value={data.ec_potentially_short_shards.toLocaleString()}
          sub={t("<10 shards observed")}
          tone={data.ec_potentially_short_shards > 0 ? "rose" : "muted"}/>
      </div>

      {issues.length > 0 && (
        <IssuesTable t={t} issues={issues}/>
      )}
      {ecShardsAtRisk.length > 0 && (
        <ECTable t={t} shards={ecShardsAtRisk}/>
      )}
      {issues.length === 0 && ecShardsAtRisk.length === 0 && (
        <div className="p-6 text-center text-xs text-muted">
          <CheckCircle2 size={16} className="inline mr-1 text-emerald-300"/>
          {t("All volumes match their configured replication.")}
        </div>
      )}

      <footer className="px-3 py-2 border-t border-border text-[11px] text-muted">
        <Link href={`/volumes?cluster=${clusterID}`} className="text-accent hover:underline">
          {t("Open volumes page")} →
        </Link>
      </footer>
    </section>
  );
}

function IssuesTable({ t, issues }: { t: (k: string) => string; issues: ReplicaIssue[] }) {
  return (
    <table className="grid border-t border-border">
      <thead>
        <tr>
          <th>{t("Volume")}</th>
          <th>{t("Collection")}</th>
          <th>{t("Severity")}</th>
          <th>{t("Replication")}</th>
          <th>{t("Observed")}</th>
          <th>{t("Servers")}</th>
          <th>{t("Reason")}</th>
        </tr>
      </thead>
      <tbody>
        {issues.map(i => (
          <tr key={i.volume_id}>
            <td>
              <Link href={`/volumes/${i.volume_id}`} className="font-mono text-sm hover:underline">#{i.volume_id}</Link>
            </td>
            <td className="font-mono text-xs">{i.collection || "(default)"}</td>
            <td>
              <span className={`badge text-[10px] ${
                i.severity === "critical" ? "border-rose-400/40 text-rose-300"
                : i.severity === "warning" ? "border-warning/40 text-warning"
                : "border-sky-400/40 text-sky-300"
              }`}>{i.severity}</span>
            </td>
            <td className="font-mono text-xs">{i.replica_placement}</td>
            <td className="font-mono text-xs">{i.observed}/{i.expected}</td>
            <td className="text-[11px] text-muted truncate max-w-[200px]" title={i.servers.join(", ")}>{i.servers.join(", ")}</td>
            <td className="text-[11px] text-muted">{i.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ECTable({ t, shards }: { t: (k: string) => string; shards: ECShardHealth[] }) {
  return (
    <table className="grid border-t border-border">
      <thead>
        <tr>
          <th>{t("EC volume")}</th>
          <th>{t("Collection")}</th>
          <th>{t("Shards observed")}</th>
          <th>{t("Servers")}</th>
          <th>{t("Risk")}</th>
        </tr>
      </thead>
      <tbody>
        {shards.map(s => (
          <tr key={s.volume_id}>
            <td className="font-mono text-sm">#{s.volume_id}</td>
            <td className="font-mono text-xs">{s.collection || "(default)"}</td>
            <td className="font-mono text-xs">{s.shard_count}/14</td>
            <td className="text-[11px] text-muted truncate max-w-[260px]" title={s.servers.join(", ")}>{s.servers.join(", ")}</td>
            <td>
              {s.missing_hint
                ? <span className="badge text-[10px] border-rose-400/40 text-rose-300">{t("unrecoverable")}</span>
                : <span className="badge text-[10px] border-warning/40 text-warning">{t("parity gone")}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- shared ----------

function Tile({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: "muted" | "emerald" | "rose" | "amber";
}) {
  const toneClass = {
    muted: "text-text",
    emerald: "text-emerald-300",
    rose: "text-rose-300",
    amber: "text-warning",
  }[tone ?? "muted"];
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

