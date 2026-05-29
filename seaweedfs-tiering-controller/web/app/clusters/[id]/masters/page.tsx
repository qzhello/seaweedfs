"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, RefreshCw, Crown } from "lucide-react";
import {
  api,
  useClusterMasters,
  type ClusterMasterRow,
  type MasterConsistency,
  type RaftServerInfo,
} from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { confirm as confirmDlg } from "@/lib/confirm";
import { useT } from "@/lib/i18n";
import { HealthBadge } from "@/components/health-badge";
import { useClusterDetail } from "../_context";

type LockProbeResult = {
  status: "free" | "held" | "quorum_unhealthy" | "loading";
  address?: string;
  lock_name?: string;
  holder?: string;
  message?: string;
  latency_ms?: number;
};

export default function ClusterMastersPage() {
  const { has, loading: capsLoading } = useCaps();
  const { id } = useClusterDetail();
  const { t } = useT();
  const { data, isLoading, isValidating, mutate, error } = useClusterMasters(id);
  const [probe, setProbe] = useState<LockProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [target, setTarget] = useState(""); // "" = auto; else "id|grpcAddr"
  const [transferring, setTransferring] = useState(false);
  const [transferResult, setTransferResult] = useState<string | null>(null);

  if (capsLoading) return null;
  if (!has("cluster.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view cluster diagnostics.")}</div>;
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
        <Loader2 size={14} className="animate-spin"/> {t("Loading masters…")}
      </div>
    );
  }

  const canProbe = has("cluster.lock.probe");
  const consistency = data.consistency;

  async function runProbe() {
    setProbing(true);
    setProbe({ status: "loading", message: t("probing admin lock…") });
    try {
      const res = await api.lockProbe(id);
      setProbe(res);
      mutate();
    } catch (e) {
      setProbe({
        status: "quorum_unhealthy",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setProbing(false);
    }
  }

  const canTransfer = has("cluster.raft.transfer");

  async function runTransfer() {
    if (!(await confirmDlg.warning({
      title: t("Transfer raft leadership to another master?"),
      body: t("This triggers a brief re-election. The cluster stays available for reads during the handoff."),
    }))) {
      return;
    }
    setTransferring(true);
    setTransferResult(null);
    try {
      let body: { target_id: string; target_address: string } | undefined;
      if (target) {
        const parts = target.split("|");
        if (parts.length === 2) {
          body = { target_id: parts[0], target_address: parts[1] };
        }
      }
      const res = await api.transferLeader(id, body);
      setTransferResult(res.output);
      setTarget("");
      mutate();
    } catch (e) {
      setTransferResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTransferring(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
            <ShieldCheck size={16}/> {t("Masters & raft quorum")}
          </h2>
          <p className="text-xs text-muted">
            {t("Configured master")}: <span className="font-mono text-text">{data.configured_master || "—"}</span>
            <span className="mx-2 text-muted/40">|</span>
            {data.masters.length} {t("discovered")}
          </p>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isValidating}
          className="btn inline-flex items-center gap-1"
          title={t("Refresh")}
        >
          <RefreshCw size={12} className={isValidating ? "animate-spin" : ""}/>
          {t("Refresh")}
        </button>
      </header>

      <ConsistencyPanel consistency={consistency}/>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="grid">
            <thead><tr>
              <th>{t("Address")}</th>
              <th>{t("Health")}</th>
              <th>{t("Role")}</th>
              <th>{t("Reported leader")}</th>
              <th>{t("Reported peers")}</th>
              <th className="num">{t("Latency")}</th>
              <th>{t("Lock holder")}</th>
              <th>{t("Warnings")}</th>
            </tr></thead>
            <tbody>
              {data.masters.map((row) => <MasterRow key={row.address} row={row}/>)}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2">
              <AlertTriangle size={14}/> {t("Lock probe")}
            </h3>
            <p className="text-xs text-muted">
              {t("Leases the SeaweedFS shell admin lock for one round-trip and releases immediately. Use this when a shell action is hanging — the response identifies the current holder without granting any mutating capability.")}
            </p>
          </div>
          <button
            onClick={runProbe}
            disabled={!canProbe || probing}
            title={canProbe ? t("Probe admin lock") : t("Requires cluster.lock.probe capability")}
            className="btn btn-primary inline-flex items-center gap-1"
          >
            {probing ? <Loader2 size={12} className="animate-spin"/> : <ShieldCheck size={12}/>}
            {t("Probe admin lock")}
          </button>
        </header>
        <LockProbeResult result={probe}/>
      </section>

      <section className="card p-4 space-y-3">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2">
              <Crown size={14}/> {t("Raft leadership")}
            </h3>
            <p className="text-xs text-muted">
              {t("Gracefully move master raft leadership to another node before maintaining the current leader. Allowed during change/maintenance windows; blocked only by emergency stop.")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!canTransfer || transferring}
              aria-label={t("Target node")}
              className="input text-xs"
            >
              <option value="">{t("Auto (any eligible follower)")}</option>
              {(data.raft_servers ?? [])
                .filter((s: RaftServerInfo) => !s.is_leader && s.suffrage === "voter")
                .map((s: RaftServerInfo) => (
                  <option key={s.id} value={`${s.id}|${s.address}`}>
                    {s.id} — {s.address}
                  </option>
                ))}
            </select>
            <button
              onClick={runTransfer}
              disabled={!canTransfer || transferring}
              title={canTransfer ? t("Transfer leader") : t("Requires cluster.raft.transfer capability")}
              className="btn btn-primary inline-flex items-center gap-1"
            >
              {transferring ? <Loader2 size={12} className="animate-spin"/> : <Crown size={12}/>}
              {t("Transfer leader")}
            </button>
          </div>
        </header>
        {transferResult !== null && (
          <pre className="font-mono text-[11px] bg-bg/60 border border-border rounded p-3 whitespace-pre-wrap max-h-60 overflow-auto">
            {transferResult}
          </pre>
        )}
      </section>
    </div>
  );
}

function ConsistencyPanel({ consistency }: { consistency: MasterConsistency }) {
  const { t } = useT();
  const tone = consistency.healthy ? "ok" : consistency.leader_agreement && consistency.peer_set_agreement ? "warn" : "err";
  const label = consistency.healthy ? t("Quorum healthy") : t("Quorum issues");
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <HealthBadge tone={tone}>{label}</HealthBadge>
        {!consistency.leader_agreement && <HealthBadge tone="err">{t("leader disagreement")}</HealthBadge>}
        {!consistency.peer_set_agreement && <HealthBadge tone="err">{t("peer-set disagreement")}</HealthBadge>}
        {consistency.reported_leaders.length > 0 && (
          <span className="text-xs text-muted">
            {t("leader(s)")}: <span className="font-mono text-text">{consistency.reported_leaders.join(", ")}</span>
          </span>
        )}
        {consistency.expected_peers.length > 0 && (
          <span className="text-xs text-muted">
            {t("expected peers")}: <span className="font-mono text-text">{consistency.expected_peers.join(", ")}</span>
          </span>
        )}
      </div>
      {consistency.issues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {consistency.issues.map((issue, idx) => (
            <li key={`${issue.code}-${idx}`} className="flex items-start gap-2">
              <span className="badge border-warning/40 text-warning font-mono shrink-0">{issue.code}</span>
              <span className="text-muted">{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MasterRow({ row }: { row: ClusterMasterRow }) {
  const { t } = useT();
  return (
    <tr>
      <td className="font-mono text-sm">{row.address}</td>
      <td><HealthBadge tone={row.health}>{t(row.health)}</HealthBadge></td>
      <td>
        <span className={`badge ${row.is_leader ? "border-accent/40 text-accent" : "border-muted/40 text-muted"}`}>
          {t(row.suffrage)}
        </span>
      </td>
      <td className="font-mono text-xs text-muted">{row.reported_leader || "—"}</td>
      <td className="font-mono text-xs text-muted">
        {row.normalized_peers.length === 0
          ? <span className="text-muted/60">{t("none reported")}</span>
          : row.normalized_peers.join(", ")}
      </td>
      <td className="num text-xs">{row.reachable ? `${row.latency_ms} ms` : "—"}</td>
      <td className="font-mono text-xs">
        {row.lock_holder ? <span className="text-warning">{row.lock_holder}</span> : <span className="text-muted/60">{t("free")}</span>}
      </td>
      <td>
        {row.warnings.length === 0
          ? <span className="text-xs text-muted/60">—</span>
          : (
            <div className="flex flex-wrap gap-1">
              {row.warnings.map((code) => (
                <span key={code} className="badge border-warning/40 text-warning font-mono text-[10px]">{code}</span>
              ))}
            </div>
          )}
        {!row.reachable && row.error && (
          <div className="text-[11px] text-danger font-mono mt-1 break-all">{row.error}</div>
        )}
      </td>
    </tr>
  );
}

function LockProbeResult({ result }: { result: LockProbeResult | null }) {
  const { t } = useT();
  if (!result) {
    return <p className="text-xs text-muted">{t("No probe run yet.")}</p>;
  }
  if (result.status === "loading") {
    return (
      <div className="text-xs text-muted inline-flex items-center gap-2">
        <Loader2 size={12} className="animate-spin"/> {result.message}
      </div>
    );
  }
  if (result.status === "free") {
    return (
      <div className="text-xs flex items-center gap-2 flex-wrap">
        <HealthBadge tone="ok">{t("free")}</HealthBadge>
        <span className="text-muted">
          {t("Acquired and released the lock on")} <span className="font-mono text-text">{result.address}</span>
          {result.latency_ms != null && <> {t("in")} <span className="font-mono">{result.latency_ms} ms</span></>}.
          {" "}{t("A shell command should be able to start now.")}
        </span>
      </div>
    );
  }
  if (result.status === "held") {
    return (
      <div className="text-xs flex items-start gap-2 flex-wrap">
        <HealthBadge tone="warn">{t("held")}</HealthBadge>
        <span className="text-muted">
          {t("Currently held by")} <span className="font-mono text-warning">{result.holder || t("unknown")}</span>
          {result.address && <> {t("on")} <span className="font-mono text-text">{result.address}</span></>}.
          {" "}{t("Other shell commands will block until this holder releases.")}
        </span>
      </div>
    );
  }
  return (
    <div className="text-xs flex items-start gap-2 flex-wrap">
      <HealthBadge tone="err">{t("quorum unhealthy")}</HealthBadge>
      <span className="text-muted font-mono break-all">{result.message || t("probe failed")}</span>
    </div>
  );
}
