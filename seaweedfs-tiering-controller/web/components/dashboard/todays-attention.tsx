"use client";

// Today's Attention — the "what should I look at right now?" panel that
// sits at the top of the Dashboard. Pulls signals from across the
// application (master consistency, EC shard health, pending tasks,
// health gate, safety guard, alert events, cluster pressure) and
// surfaces only the ones that warrant action. Quiet by design: a
// healthy fleet renders a single "all clear" row, not a wall of green.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ShieldAlert, AlertTriangle, CheckCircle2, Lock, Layers, ClipboardCheck, HeartPulse, Shield, Activity, ChevronRight, BellOff,
} from "lucide-react";
import {
  useClusters, useTasks, useHealthGate, useSafetyStatus, useAlertEvents,
  useClusterMasters, useClusterECShards, ackAlertEvents,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { confirm as confirmDlg } from "@/lib/confirm";

type Tone = "err" | "warn" | "ok";

interface Signal {
  key: string;
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  href?: string;
  // Optional inline action — currently used to attach "Ignore all" to
  // the alert signals so an operator can clear noise without leaving
  // the dashboard. Kept generic so other signal sources can add their
  // own dismiss UX later (snooze raft warning until maintenance etc).
  action?: { label: string; onClick: () => void | Promise<void>; icon?: React.ReactNode };
}

const TONE_CLASSES: Record<Tone, string> = {
  err:  "border-danger/40 bg-danger/10 text-danger",
  warn: "border-warning/40 bg-warning/10 text-warning",
  ok:   "border-success/40 bg-success/10 text-success",
};

// Lifted state lets each child <ClusterSignals> report its current
// finding count back to the panel so an "All clear" fallback only
// renders when nothing else is on the grid. Keys = "<clusterID>" so
// the same child updating between renders overwrites the prior count.
type ClusterSignalCounts = Record<string, number>;

export function TodaysAttention() {
  const { t } = useT();
  const { data: clusters } = useClusters();
  const { data: pending } = useTasks("pending");
  const { data: gate } = useHealthGate();
  const { data: safety } = useSafetyStatus();
  const { data: alerts, mutate: refetchAlerts } = useAlertEvents();

  // "Ignore all current alerts" — acks every event older than now so
  // anything firing between click and server-side commit stays visible.
  const ignoreAllAlerts = async () => {
    const recent = ((alerts as { items?: { id: number }[] } | undefined)?.items ?? []);
    if (recent.length === 0) return;
    if (!(await confirmDlg.warning({
      title: t("Ignore all {n} active alert(s)?").replace("{n}", String(recent.length)),
      body: t("New alerts that fire after this stay visible. Use the alerts page to undo."),
    }))) return;
    try {
      const r = await ackAlertEvents({ before: new Date().toISOString() });
      toast.success(t("Ignored {n}").replace("{n}", String(r.acked)));
      refetchAlerts();
    } catch (e) {
      toast.fromError(e, t("Ignore failed"));
    }
  };
  const [clusterCounts, setClusterCounts] = useState<ClusterSignalCounts>({});
  const reportClusterCount = (id: string, n: number) => {
    setClusterCounts((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }));
  };

  const enabledClusters: { id: string; name: string }[] = useMemo(() => {
    return ((clusters as { items?: { id: string; name: string; enabled: boolean }[] } | undefined)?.items ?? [])
      .filter((c) => c.enabled)
      .map((c) => ({ id: c.id, name: c.name }));
  }, [clusters]);

  // Global (non-cluster) signals
  const globalSignals: Signal[] = useMemo(() => {
    const out: Signal[] = [];
    const pendingCount = ((pending as { items?: unknown[] } | undefined)?.items?.length) ?? 0;
    if (pendingCount > 0) {
      out.push({
        key: "tasks-pending",
        tone: "warn",
        icon: <ClipboardCheck size={14}/>,
        title: t("Pending task approvals"),
        detail: `${pendingCount} ${t("waiting for review")}`,
        href: "/tasks?status=pending",
      });
    }
    // /health/gate returns { ok, reason, gating: [{name, state, severity}] }.
    // `reason` is only populated when ok=false; otherwise stitch the
    // unhealthy gating sources together so the operator sees who's bad.
    const gateData = gate as {
      ok?: boolean; reason?: string;
      gating?: { name: string; state: string; severity?: string }[];
    } | undefined;
    if (gateData && gateData.ok === false) {
      const unhealthy = (gateData.gating ?? []).filter((g) => g.state !== "healthy");
      const detail = gateData.reason
        || (unhealthy.length > 0 ? unhealthy.map((g) => `${g.name}=${g.state}`).join(" · ") : t("automated jobs blocked"));
      out.push({
        key: "health-gate",
        tone: "err",
        icon: <HeartPulse size={14}/>,
        title: t("Health gate is closed"),
        detail,
        href: "/reliability?tab=health",
      });
    }
    // safety.status returns { safety_allowed, safety_code, safety_reason, overall_allowed }.
    // `safety_code === "emergency_stop"` is the explicit kill-switch; any
    // other non-allowed state (maintenance, change_window, holiday,
    // blocklist) shows as a softer warning so the dashboard can
    // distinguish "panic" from "scheduled quiet hours".
    const safetyData = safety as {
      safety_allowed?: boolean; safety_code?: string; safety_reason?: string;
      overall_allowed?: boolean;
    } | undefined;
    if (safetyData?.safety_code === "emergency_stop") {
      out.push({
        key: "safety-stop",
        tone: "err",
        icon: <Shield size={14}/>,
        title: t("Emergency stop is engaged"),
        detail: safetyData.safety_reason || t("All executor activity is suspended."),
        href: "/reliability?tab=safety",
      });
    } else if (safetyData && safetyData.safety_allowed === false) {
      out.push({
        key: "safety-blocked",
        tone: "warn",
        icon: <Shield size={14}/>,
        title: t("Safety guard is blocking ops"),
        detail: safetyData.safety_reason || safetyData.safety_code || t("Operations temporarily disallowed."),
        href: "/reliability?tab=safety",
      });
    }
    const recent = ((alerts as { items?: { severity?: string; created_at?: string }[] } | undefined)?.items ?? []);
    const recentCritical = recent.filter((e) => e.severity === "critical").length;
    const recentWarning = recent.filter((e) => e.severity === "warning").length;
    if (recentCritical > 0) {
      out.push({
        key: "alerts-critical",
        tone: "err",
        icon: <Activity size={14}/>,
        title: t("Critical alerts firing"),
        detail: `${recentCritical} ${t("critical")} · ${recentWarning} ${t("warning")}`,
        href: "/reliability?tab=alerts",
        action: { label: t("Ignore all"), icon: <BellOff size={12}/>, onClick: ignoreAllAlerts },
      });
    } else if (recentWarning > 0) {
      out.push({
        key: "alerts-warning",
        tone: "warn",
        icon: <Activity size={14}/>,
        title: t("Warnings firing"),
        detail: `${recentWarning} ${t("warning")}`,
        href: "/reliability?tab=alerts",
        action: { label: t("Ignore all"), icon: <BellOff size={12}/>, onClick: ignoreAllAlerts },
      });
    }
    return out;
    // ignoreAllAlerts is stable enough between renders that depending on
    // it would just churn the memo; we depend on the underlying alerts
    // payload instead, which is what actually changes the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, gate, safety, alerts, t]);

  return (
    <section className="card p-4 space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {t("Today's attention")}
        </h2>
        <span className="text-[11px] text-muted">{t("Signals that warrant operator action")}</span>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {globalSignals.map((s) => <SignalCard key={s.key} signal={s}/>)}
        {enabledClusters.map((c) => (
          <ClusterSignals
            key={c.id}
            clusterID={c.id}
            clusterName={c.name}
            onCountChange={reportClusterCount}
          />
        ))}
        {enabledClusters.length === 0 && globalSignals.length === 0 && (
          <SignalCard signal={{
            key: "no-clusters",
            tone: "warn",
            icon: <AlertTriangle size={14}/>,
            title: t("No enabled clusters"),
            detail: t("Add a cluster in /clusters to start monitoring."),
            href: "/clusters",
          }}/>
        )}
        {globalSignals.length === 0 && enabledClusters.length > 0 &&
          Object.keys(clusterCounts).length === enabledClusters.length &&
          Object.values(clusterCounts).every((n) => n === 0) && (
            <AllClearSignal/>
          )}
      </div>
    </section>
  );
}

// Per-cluster signal row. Owns its own SWR fetches so the panel renders
// progressively — a slow master doesn't block the global signals above.
function ClusterSignals({ clusterID, clusterName, onCountChange }: {
  clusterID: string;
  clusterName: string;
  onCountChange: (id: string, n: number) => void;
}) {
  const { t } = useT();
  const { data: masters, error: mErr } = useClusterMasters(clusterID);
  const { data: ec, error: ecErr } = useClusterECShards(clusterID);

  const signals: Signal[] = useMemo(() => {
    const out: Signal[] = [];
    // Raft consistency from /masters
    if (masters && !masters.consistency?.healthy) {
      const issueCount = masters.consistency?.issues?.length ?? 0;
      const sev: Tone = (!masters.consistency?.leader_agreement || !masters.consistency?.peer_set_agreement) ? "err" : "warn";
      out.push({
        key: `${clusterID}-quorum`,
        tone: sev,
        icon: <ShieldAlert size={14}/>,
        title: `${clusterName}: ${t("Raft quorum issues")}`,
        detail: `${issueCount} ${t("consistency issue(s)")}`,
        href: `/clusters/${clusterID}/masters`,
      });
    }
    // Admin lock held by someone — derived from per-master lock_holder gauge
    const holders = (masters?.masters ?? []).map((m) => m.lock_holder).filter((h): h is string => !!h);
    if (holders.length > 0) {
      out.push({
        key: `${clusterID}-lock`,
        tone: "warn",
        icon: <Lock size={14}/>,
        title: `${clusterName}: ${t("Admin lock is held")}`,
        detail: `${t("Held by")} ${holders[0]}`,
        href: `/clusters/${clusterID}/masters`,
      });
    }
    // EC volumes with missing shards
    const unhealthyEC = (ec?.volumes ?? []).filter((v) => !v.healthy);
    if (unhealthyEC.length > 0) {
      out.push({
        key: `${clusterID}-ec`,
        tone: "err",
        icon: <Layers size={14}/>,
        title: `${clusterName}: ${t("EC volumes with missing shards")}`,
        detail: `${unhealthyEC.length} ${t("incomplete volume(s)")}`,
        href: `/clusters/${clusterID}/ec-shards`,
      });
    }
    // Surface fetch errors as a low-priority warn so the operator knows
    // the panel can't see this cluster, but the rest of the dashboard
    // still loads.
    if (mErr || ecErr) {
      out.push({
        key: `${clusterID}-fetch`,
        tone: "warn",
        icon: <AlertTriangle size={14}/>,
        title: `${clusterName}: ${t("Diagnostics unreachable")}`,
        detail: mErr ? String((mErr as Error).message) : String((ecErr as Error).message),
        href: `/clusters/${clusterID}/masters`,
      });
    }
    return out;
  }, [masters, ec, mErr, ecErr, clusterID, clusterName, t]);

  // Report our finding count up so the panel can show an "All clear"
  // fallback when nobody has signals. We only report once SWR has
  // produced a non-undefined response (or errored out) so the parent
  // doesn't race ahead and render "all clear" mid-load.
  const loaded = (masters !== undefined || mErr !== undefined) &&
                 (ec !== undefined || ecErr !== undefined);
  useEffect(() => {
    if (loaded) onCountChange(clusterID, signals.length);
  }, [loaded, signals.length, clusterID, onCountChange]);

  if (signals.length === 0) return null;
  return <>{signals.map((s) => <SignalCard key={s.key} signal={s}/>)}</>;
}

function SignalCard({ signal }: { signal: Signal }) {
  const { t } = useT();
  // Inline action sits outside the Link wrapper so clicking it doesn't
  // navigate. We stopPropagation just in case a parent ever listens.
  const actionButton = signal.action ? (
    <button
      type="button"
      className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-current/30 hover:bg-current/10 shrink-0"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void signal.action!.onClick(); }}
      title={signal.action.label}
    >
      {signal.action.icon}
      {signal.action.label}
    </button>
  ) : null;

  const inner = (
    <div className={`rounded-md border px-3 py-2 ${TONE_CLASSES[signal.tone]} hover:brightness-110 transition`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5">{signal.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{signal.title}</div>
          {signal.detail && <div className="text-[11px] opacity-80 mt-0.5 truncate">{signal.detail}</div>}
        </div>
        {actionButton}
        {signal.href && <ChevronRight size={12} className="shrink-0 mt-0.5 opacity-60"/>}
      </div>
    </div>
  );
  if (signal.href) {
    return (
      <Link href={signal.href} className="block" title={t("Open")}>
        {inner}
      </Link>
    );
  }
  return inner;
}

// Optional empty-state row used by the panel when nothing is wrong.
// Exported so the Dashboard can decide whether to render the panel at
// all (e.g. when in compact mode).
export function AllClearSignal() {
  const { t } = useT();
  return (
    <SignalCard signal={{
      key: "all-clear",
      tone: "ok",
      icon: <CheckCircle2 size={14}/>,
      title: t("All clear"),
      detail: t("No action items right now. Routine reviews still recommended."),
    }}/>
  );
}
