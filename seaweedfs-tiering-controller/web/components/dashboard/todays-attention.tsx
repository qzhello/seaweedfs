"use client";

// Today's Attention — the "what should I look at right now?" panel that
// sits at the top of the Dashboard. Pulls signals from across the
// application (master consistency, EC shard health, pending tasks,
// health gate, safety guard, alert events, cluster pressure) and
// surfaces only the ones that warrant action. Quiet by design: a
// healthy fleet renders a single "all clear" row, not a wall of green.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ShieldAlert, AlertTriangle, CheckCircle2, Lock, Layers, ClipboardCheck, HeartPulse, Shield, Activity, ChevronRight, BellOff, X, Undo2, Clock,
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
  // Set false to suppress the per-card × dismiss button (e.g. "all clear"
  // shouldn't be dismissible — it's not noise, it's the happy path).
  dismissible?: boolean;
  // ISO timestamp of when the signal *actually* started. When the source
  // API gives us a real time (e.g. alerts.created_at) we pass it here.
  // Otherwise SignalCard falls back to client-side first-seen tracking,
  // which is a lower bound ("at least this long") but still useful — an
  // operator who reloads the dashboard at 14:00 and sees "first seen ~5h
  // ago" knows the issue has been ongoing across sessions.
  observedSince?: string;
}

// ---- Client-side "first seen" tracking -------------------------------------
// Most derived signals (Raft consistency, health gate, EC degradation) don't
// carry a server-side timestamp — the API just snapshots current state. We
// record when this browser first saw a given signal key into localStorage so
// the card can show "first seen 12m ago" instead of nothing.
//
// Stamps are auto-cleared when the underlying signal disappears (resolved or
// dismissed), so the next time it fires we start a fresh clock rather than
// showing a misleadingly old timestamp.

const FIRSTSEEN_STORAGE_KEY = "dashboard:first-seen";

interface FirstSeenMap { [signalKey: string]: string /* first seen ISO */ }

function loadFirstSeen(): FirstSeenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FIRSTSEEN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FirstSeenMap) : {};
  } catch { return {}; }
}

function saveFirstSeen(m: FirstSeenMap) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(FIRSTSEEN_STORAGE_KEY, JSON.stringify(m)); } catch {}
}

function useFirstSeen(activeKeys: string[]) {
  // Stamp on first appearance; sweep stale keys (signals that no longer fire)
  // so the next occurrence gets a fresh "first seen" clock. We diff by stable
  // string key, not Signal object reference, since the parent regenerates
  // Signal objects every render.
  const [map, setMap] = useState<FirstSeenMap>({});
  useEffect(() => { setMap(loadFirstSeen()); }, []);

  // Use a serialised key set in the deps array so unchanged sets don't churn
  // localStorage. Sort for stability (Set iteration order is insertion).
  const activeKeysStr = activeKeys.slice().sort().join("|");

  useEffect(() => {
    setMap((prev) => {
      const nowIso = new Date().toISOString();
      const next: FirstSeenMap = {};
      // Carry forward stamps for still-active keys; assign nowIso to newly
      // active ones. Anything in `prev` not in active is dropped (sweep).
      for (const k of activeKeys) {
        next[k] = prev[k] || nowIso;
      }
      // Only write when anything changed — avoid an infinite render loop
      // since this effect also depends on `setMap`'s output.
      const same = Object.keys(prev).length === Object.keys(next).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      if (same) return prev;
      saveFirstSeen(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKeysStr]);

  return (key: string): string | undefined => map[key];
}

// Returns the earliest ISO timestamp from a list, or undefined if empty.
// Used to pick "the oldest firing thing" as a since-anchor for grouped
// signals (e.g. all critical alerts collapsed into one card).
function oldestTimestamp(values: (string | undefined)[]): string | undefined {
  let oldest: string | undefined;
  let oldestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < oldestMs) { oldestMs = ms; oldest = v; }
  }
  return oldest;
}

// Relative time formatter. Returns short human-readable form like "12m",
// "3h", "2d". Designed to fit in a small chip next to a card title — full
// timestamp lives in the tooltip via the parent.
function formatRelativeShort(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60)   return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m`;
  const hr  = Math.floor(min / 60);
  if (hr  < 48)   return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

// ---- Client-side dismiss tracking ------------------------------------------
// Some signals are derived from real-time cluster state and can't be
// "acknowledged" upstream (Raft warnings, EC degradation, etc). The
// operator already knows; they don't want to see the card every refresh
// while they work on it. We hide such cards client-side for 24h —
// matching "今日关注" semantics: gone for today, back tomorrow if still
// firing. If the underlying state resolves and re-fires, the same key
// reappears because we filter on isDismissed, not on key history.

const DISMISS_STORAGE_KEY = "dashboard:dismissed-signals";
const DISMISS_TTL_HOURS = 24;

interface DismissMap { [signalKey: string]: string /* dismissUntil ISO */ }

function loadDismissed(): DismissMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DismissMap;
    // Garbage-collect expired entries on read so the map doesn't grow
    // unboundedly across days.
    const now = Date.now();
    const fresh: DismissMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (new Date(v).getTime() > now) fresh[k] = v;
    }
    return fresh;
  } catch { return {}; }
}

function saveDismissed(m: DismissMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(m));
  } catch { /* quota — ignore */ }
}

function useDismissed() {
  const [map, setMap] = useState<DismissMap>({});
  // Load on mount only — avoids hydration mismatch. SSR sees empty map.
  useEffect(() => { setMap(loadDismissed()); }, []);

  const dismiss = useCallback((key: string) => {
    setMap((prev) => {
      const next = { ...prev, [key]: new Date(Date.now() + DISMISS_TTL_HOURS * 3600_000).toISOString() };
      saveDismissed(next);
      return next;
    });
  }, []);

  const restoreAll = useCallback(() => {
    setMap({});
    saveDismissed({});
  }, []);

  const isDismissed = useCallback((key: string) => {
    const until = map[key];
    if (!until) return false;
    return new Date(until).getTime() > Date.now();
  }, [map]);

  return { dismiss, restoreAll, isDismissed, dismissedCount: Object.keys(map).length };
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

export function TodaysAttention({ className = "" }: { className?: string } = {}) {
  const { t } = useT();
  const { data: clusters } = useClusters();
  const { data: pending } = useTasks("pending");
  const { data: gate } = useHealthGate();
  const { data: safety } = useSafetyStatus();
  const { data: alerts, mutate: refetchAlerts } = useAlertEvents();
  const { dismiss, restoreAll, isDismissed, dismissedCount } = useDismissed();

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
    // Pick the *oldest* still-firing alert for the timeline anchor so the
    // operator sees "the oldest firing alert is from X ago" rather than the
    // last one ingested. We compute crit and warn separately because the
    // panel splits them into two cards by severity.
    const oldestCriticalAt = oldestTimestamp(recent.filter((e) => e.severity === "critical").map((e) => e.created_at));
    const oldestWarningAt  = oldestTimestamp(recent.filter((e) => e.severity === "warning" ).map((e) => e.created_at));
    if (recentCritical > 0) {
      out.push({
        key: "alerts-critical",
        tone: "err",
        icon: <Activity size={14}/>,
        title: t("Critical alerts firing"),
        detail: `${recentCritical} ${t("critical")} · ${recentWarning} ${t("warning")}`,
        href: "/reliability?tab=alerts",
        action: { label: t("Ignore all"), icon: <BellOff size={12}/>, onClick: ignoreAllAlerts },
        observedSince: oldestCriticalAt,
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
        observedSince: oldestWarningAt,
      });
    }
    return out;
    // ignoreAllAlerts is stable enough between renders that depending on
    // it would just churn the memo; we depend on the underlying alerts
    // payload instead, which is what actually changes the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, gate, safety, alerts, t]);

  // Apply per-signal client-side dismiss to the global feed. Cluster
  // children filter their own signals via the same isDismissed (passed
  // down) so their count reported back to clusterCounts is post-filter
  // and the "All clear" fallback works correctly.
  const visibleGlobal = globalSignals.filter((s) => !isDismissed(s.key));

  // Stamp first-seen for global signals (alerts have server `created_at`,
  // others don't). The hook auto-sweeps stamps for keys no longer present
  // so the next occurrence gets a fresh clock.
  const getFirstSeen = useFirstSeen(visibleGlobal.map((s) => s.key));

  return (
    <section className={`card p-4 flex flex-col gap-3 ${className}`}>
      <header className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {t("Today's attention")}
        </h2>
        <span className="text-[11px] text-muted">{t("Signals that warrant operator action")}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 gap-2 pr-1">
        {visibleGlobal.map((s) => (
          <SignalCard
            key={s.key}
            signal={s}
            onDismiss={dismiss}
            firstSeenFallback={getFirstSeen(s.key)}
          />
        ))}
        {enabledClusters.map((c) => (
          <ClusterSignals
            key={c.id}
            clusterID={c.id}
            clusterName={c.name}
            onCountChange={reportClusterCount}
            isDismissed={isDismissed}
            onDismiss={dismiss}
          />
        ))}
        {enabledClusters.length === 0 && visibleGlobal.length === 0 && (
          <SignalCard signal={{
            key: "no-clusters",
            tone: "warn",
            icon: <AlertTriangle size={14}/>,
            title: t("No enabled clusters"),
            detail: t("Add a cluster in /clusters to start monitoring."),
            href: "/clusters",
          }} onDismiss={dismiss}/>
        )}
        {visibleGlobal.length === 0 && enabledClusters.length > 0 &&
          Object.keys(clusterCounts).length === enabledClusters.length &&
          Object.values(clusterCounts).every((n) => n === 0) && (
            <AllClearSignal/>
          )}
      </div>
      {dismissedCount > 0 && (
        <footer className="flex items-center justify-end gap-2 pt-1 text-[11px] text-muted">
          <span>{t("{n} hidden for today").replace("{n}", String(dismissedCount))}</span>
          <button
            type="button"
            onClick={restoreAll}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-panel2 hover:text-text transition-colors"
          >
            <Undo2 size={11}/>
            {t("Show hidden")}
          </button>
        </footer>
      )}
    </section>
  );
}

// Per-cluster signal row. Owns its own SWR fetches so the panel renders
// progressively — a slow master doesn't block the global signals above.
function ClusterSignals({ clusterID, clusterName, onCountChange, isDismissed, onDismiss }: {
  clusterID: string;
  clusterName: string;
  onCountChange: (id: string, n: number) => void;
  isDismissed: (key: string) => boolean;
  onDismiss: (key: string) => void;
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
  // Visible = post-dismiss. We report visible count up so the panel's
  // "All clear" fallback fires correctly once everything is hidden.
  const visible = signals.filter((s) => !isDismissed(s.key));
  useEffect(() => {
    if (loaded) onCountChange(clusterID, visible.length);
  }, [loaded, visible.length, clusterID, onCountChange]);

  // Per-cluster signals have no server timestamps, so the first-seen
  // fallback is the only timing info available. The hook scopes its
  // active key set to this cluster's signals only — same effect as the
  // global one, just smaller.
  const getFirstSeen = useFirstSeen(visible.map((s) => s.key));

  if (visible.length === 0) return null;
  return <>{visible.map((s) => (
    <SignalCard
      key={s.key}
      signal={s}
      onDismiss={onDismiss}
      firstSeenFallback={getFirstSeen(s.key)}
    />
  ))}</>;
}

function SignalCard({ signal, onDismiss, firstSeenFallback }: {
  signal: Signal;
  onDismiss?: (key: string) => void;
  // Client-side stamp of when this signal was first seen in this browser
  // session. Used when the server doesn't give a real timestamp on the
  // signal itself (Raft consistency, EC degradation, etc).
  firstSeenFallback?: string;
}) {
  const { t } = useT();
  // Prefer server-truth time when present; fall back to first-seen client
  // stamp. The phrasing makes the difference visible in the tooltip — a
  // real timestamp says "since HH:MM"; a fallback says "first seen at
  // HH:MM" so the operator knows it's a lower bound.
  const since = signal.observedSince || firstSeenFallback;
  const sinceLabel = since ? formatRelativeShort(since) : null;
  const sinceTooltip = since
    ? (signal.observedSince
        ? `${t("Since")} ${new Date(since).toLocaleString()}`
        : `${t("First seen at")} ${new Date(since).toLocaleString()} ${t("(may have started earlier)")}`)
    : "";
  // Re-render every 30s so the relative label ticks up live without
  // requiring a full SWR refetch. Cheap — just a state bump.
  const [, force] = useState(0);
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [since]);
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

  // Per-card × dismiss. Hides the signal client-side for 24h. Suppressed
  // on the "all-clear" signal and any signal explicitly marked
  // dismissible:false. Sits outside the Link wrapper so it doesn't
  // navigate.
  const canDismiss = onDismiss && signal.dismissible !== false && signal.key !== "all-clear";
  const dismissButton = canDismiss ? (
    <button
      type="button"
      className="shrink-0 opacity-50 hover:opacity-100 hover:bg-current/15 rounded p-0.5 -m-0.5 transition"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss!(signal.key); }}
      title={t("Hide for today")}
      aria-label={t("Hide for today")}
    >
      <X size={12}/>
    </button>
  ) : null;

  const inner = (
    <div className={`rounded-md border px-3 py-2 ${TONE_CLASSES[signal.tone]} hover:brightness-110 transition`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5">{signal.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold truncate">{signal.title}</span>
            {sinceLabel && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] tabular-nums opacity-75 shrink-0"
                title={sinceTooltip}
              >
                <Clock size={9}/>
                {sinceLabel}
              </span>
            )}
          </div>
          {signal.detail && <div className="text-[11px] opacity-80 mt-0.5 truncate">{signal.detail}</div>}
        </div>
        {actionButton}
        {signal.href && <ChevronRight size={12} className="shrink-0 mt-0.5 opacity-60"/>}
        {dismissButton}
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
