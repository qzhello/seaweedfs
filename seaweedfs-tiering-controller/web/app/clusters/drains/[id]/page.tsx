"use client";

// Drain job detail — live tail of a single durable drain. The runner
// publishes events to /drains/:id/stream; we consume them to update
// status, progress, and the rolling log. Closing this tab does NOT
// cancel the job — that's the whole point of the persistent variant.

import { useEffect, useRef, useState } from "react";
import { CardSkeleton } from "@/components/table-skeleton";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LogOut, ArrowLeft, X, RefreshCw, CheckCircle2, AlertTriangle, Clock,
  HardDrive, User, Calendar, Hash, RotateCcw,
} from "lucide-react";
import { api, useDrain, useClusters, getToken, type DrainJob, type DrainStatus } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { toast } from "@/lib/toast";
import { bytes as fmtBytes } from "@/lib/utils";
import { StatusBadge } from "../../maintenance/_panels/_drain-status";

export default function DrainDetailPage() {
  const { t } = useT();
  return (
    <Can cap="cluster.volume-server.leave" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  // Initial snapshot via REST; the SSE stream then keeps it fresh.
  // We don't poll because the stream emits a snapshot on connect.
  const { data: rest, error, mutate } = useDrain(id);
  const [live, setLive] = useState<DrainJob | null>(null);
  // Tail of log lines emitted during this session. Pre-existing log
  // content from before this tab opened comes in on the `snapshot`
  // event. We append `line` events on top.
  const [tail, setTail] = useState<string[]>([]);
  const [streamErr, setStreamErr] = useState<string>("");
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const { data: clustersResp } = useClusters();

  const drain = live ?? rest;
  const isTerminal = drain && (drain.status === "done" || drain.status === "failed" || drain.status === "cancelled");

  // Hook up SSE. Refetches when `id` changes; tears down on unmount or
  // when the job hits a terminal status.
  useEffect(() => {
    if (!id) return;
    let aborted = false;
    const ctrl = new AbortController();
    (async () => {
      const tok = getToken();
      const headers: Record<string, string> = {};
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      try {
        const r = await fetch(`/api/v1/drains/${id}/stream`, { headers, signal: ctrl.signal });
        if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let event = "line";
        while (!aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const raw of lines) {
            if (raw.startsWith("event: ")) {
              event = raw.slice(7).trim();
            } else if (raw.startsWith("data: ")) {
              const payload = raw.slice(6);
              handleEvent(event, payload);
            }
          }
        }
      } catch (e) {
        if (!aborted) {
          setStreamErr((e as Error).message);
        }
      }
    })();
    return () => { aborted = true; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function handleEvent(event: string, raw: string) {
    if (event === "snapshot") {
      try {
        const snap = JSON.parse(raw) as DrainJob;
        setLive(snap);
        // Seed tail with the persisted log so reconnecting clients
        // see history rather than a blank pane.
        if (snap.run_log) {
          setTail(snap.run_log.split("\n").filter(Boolean));
        }
      } catch { /* ignore */ }
    } else if (event === "line") {
      // Raw text payload — no JSON encoding to avoid double-escapes.
      setTail(prev => {
        const next = [...prev, raw];
        // Cap to last 2000 lines to keep React + DOM responsive on a
        // drain that goes for hours.
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    } else if (event === "progress") {
      try {
        const p = JSON.parse(raw) as { volumes: number; bytes: number };
        setLive(l => l ? { ...l, last_volumes: p.volumes, last_bytes: p.bytes } : l);
      } catch { /* ignore */ }
    } else if (event === "status") {
      try {
        const p = JSON.parse(raw) as { status: DrainStatus };
        setLive(l => l ? { ...l, status: p.status } : l);
      } catch { /* ignore */ }
    } else if (event === "done") {
      try {
        const p = JSON.parse(raw) as { status: DrainStatus; error?: string };
        setLive(l => l ? { ...l, status: p.status, error: p.error || "" } : l);
        // Re-fetch to pick up finished_at + final last_volumes from DB.
        mutate();
      } catch { /* ignore */ }
    }
  }

  // Auto-scroll the log to the bottom on every append unless the user
  // has scrolled up to inspect. We detect "near the bottom" with a
  // 32px slack so the auto-stick is forgiving of subpixel scroll.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [tail.length]);

  const cancel = async () => {
    if (!id || !drain) return;
    if (!(await confirmDlg.danger({ title: t("Cancel this drain? The shell will be interrupted and the node may end up partially drained.") }))) return;
    setCancelling(true);
    try {
      await api.cancelDrain(id);
      toast.success(t("Cancellation requested"));
    } catch (e) {
      toast.fromError(e, t("Cancel failed"));
    } finally {
      setCancelling(false);
    }
  };

  const retry = async () => {
    if (!drain) return;
    setRetrying(true);
    try {
      const { id: newID } = await api.createDrain(drain.cluster_id, {
        node: drain.node,
        force: drain.force,
        reason: drain.reason
          ? `${t("retry of")} ${drain.id.slice(0, 8)}: ${drain.reason}`
          : `${t("retry of")} ${drain.id.slice(0, 8)}`,
      });
      router.push(`/clusters/drains/${newID}`);
    } catch (e) {
      toast.fromError(e, t("Retry failed"));
    } finally {
      setRetrying(false);
    }
  };

  if (error) return <div className="space-y-4"><Header t={t}/><ErrorPanel error={error}/></div>;
  if (!drain) return <div className="space-y-4"><Header t={t}/><CardSkeleton lines={5}/></div>;

  const clusterName = (clustersResp?.items ?? []).find((c: { id: string; name: string }) => c.id === drain.cluster_id)?.name
    ?? drain.cluster_id.slice(0, 8);
  const remaining = drain.initial_volumes > 0
    ? Math.max(0, 1 - (drain.last_volumes / drain.initial_volumes))
    : (drain.status === "done" ? 1 : 0);

  return (
    <div className="space-y-4">
      <Header t={t}/>

      <section className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-base">{drain.node}</span>
              {drain.force && <span className="badge text-[10px] border-warning/40 text-warning">force</span>}
              <StatusBadge status={drain.status} t={t}/>
            </div>
            <div className="text-xs text-muted">
              {t("On cluster")} <span className="font-mono">{clusterName}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isTerminal && (
              <button onClick={cancel} disabled={cancelling}
                className="btn text-xs inline-flex items-center gap-1.5">
                <X size={12}/> {cancelling ? t("Cancelling…") : t("Cancel drain")}
              </button>
            )}
            {(drain.status === "failed" || drain.status === "cancelled") && (
              <button onClick={retry} disabled={retrying}
                className="btn btn-primary text-xs inline-flex items-center gap-1.5">
                <RotateCcw size={12}/> {retrying ? t("Starting…") : t("Retry as new drain")}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Meta icon={<Hash size={11}/>} label={t("Drain id")} value={drain.id.slice(0, 8)}/>
          <Meta icon={<User size={11}/>} label={t("Requested by")} value={drain.requested_by || "—"}/>
          <Meta icon={<Calendar size={11}/>} label={t("Created")} value={new Date(drain.created_at).toLocaleString()}/>
          <Meta icon={<Calendar size={11}/>} label={t("Finished")} value={drain.finished_at ? new Date(drain.finished_at).toLocaleString() : "—"}/>
        </div>

        {drain.reason && (
          <div className="text-xs">
            <span className="text-muted">{t("Reason")}:</span>{" "}
            <span className="italic">{drain.reason}</span>
          </div>
        )}

        {/* Progress bar — width-driven by 1 - (last/initial). When
            initial_volumes is 0 (server already had no volumes) we
            still want a finished bar after status=done. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive size={11}/>
              {drain.last_volumes}/{drain.initial_volumes} {t("volumes remaining")} · {fmtBytes(drain.last_bytes)} / {fmtBytes(drain.initial_bytes)}
            </span>
            <span className="font-mono">{Math.round(remaining * 100)}%</span>
          </div>
          <div className="h-2 bg-panel2 rounded overflow-hidden">
            <div
              className={`h-full transition-[width] duration-300 ${
                drain.status === "done" ? "bg-success/70"
                : (drain.status === "failed" || drain.status === "cancelled") ? "bg-danger/40"
                : "bg-accent"
              }`}
              style={{ width: `${Math.max(2, Math.round(remaining * 100))}%` }}
            />
          </div>
        </div>

        {drain.error && (
          <div className="card p-2 border-danger/40 bg-danger/5 text-xs text-danger font-mono whitespace-pre-wrap">
            {drain.error}
          </div>
        )}

        {drain.status === "done" && (
          <div className="card p-2 border-success/40 bg-success/5 text-xs text-success inline-flex items-center gap-2">
            <CheckCircle2 size={14}/>
            {t("Node is empty and safe to power off.")}
          </div>
        )}
      </section>

      {streamErr && (
        <div className="card p-2 text-xs text-danger border-danger/40">
          {t("Stream error")}: {streamErr}
        </div>
      )}

      <section className="card p-0 overflow-hidden">
        <header className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold inline-flex items-center gap-1.5">
            <LogOut size={12}/> {t("Run log")}
          </span>
          <span className="text-[10px] text-muted">
            {tail.length} {t("lines")}
          </span>
        </header>
        <pre
          ref={logRef}
          className="text-[11px] font-mono p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all bg-black/30"
        >
          {tail.length === 0 ? <span className="text-muted">{t("Waiting for output…")}</span> : tail.join("\n")}
        </pre>
      </section>
    </div>
  );
}

function Header({ t }: { t: (k: string) => string }) {
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Link href="/clusters/maintenance?tab=drain-history" className="text-muted hover:text-text inline-flex items-center gap-1 text-xs">
          <ArrowLeft size={12}/> {t("Drain history")}
        </Link>
      </div>
    </header>
  );
}

function Meta({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted/70 inline-flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-xs font-mono mt-0.5">{value}</div>
    </div>
  );
}
