"use client";

// Live progress panel for streaming EC shell runs.
//
// Connects to a POST + text/event-stream endpoint and renders:
//   - elapsed timer + lines/sec rate
//   - per-volume shard progress (parsed from "shard X of volume Y" / "ec0X" lines)
//   - target node map (parsed from shard-copy destination lines)
//   - rolling stdout tail
//
// The output parsers are best-effort — `ec.encode` / `ec.decode` print
// human-readable progress that varies across SeaweedFS releases, so we
// extract just what we can recognise and fall back to the raw tail for
// everything else. ETA = avg seconds-per-completed-step × remaining
// expected steps (14 shards × volume count).

import { useEffect, useRef, useState } from "react";
import { authHeaders, BASE } from "@/lib/api";
import { Loader2, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { CommandPreview } from "@/components/cli/command-preview";

interface Props {
  url: string;                  // POST endpoint, e.g. /clusters/X/ec/encode/stream
  body: unknown;                // JSON request body
  expectedVolumes: number;      // for ETA (volume count × 14 shards)
  onClose: () => void;
  // onDone fires when the `done` SSE event arrives. `payload` is the
  // parsed JSON of that event so callers can read command-specific
  // fields like `summary` (volume.fix.replication) or `failed_volumes`
  // (ec.encode). Empty object when parsing fails.
  onDone?: (ok: boolean, payload?: Record<string, unknown>) => void;
  title: string;
  subtitle?: string;
  // "modal"  (default) — full-screen overlay, replaces caller UI.
  // "inline" — render bare body so callers can embed it inside another
  //            dialog (e.g. the encode form's right-side panel). No
  //            backdrop, no header/footer; cancel button stays inline.
  variant?: "modal" | "inline";
}

interface VolumeProgress {
  id: number;
  shardsSeen: Set<number>;
  startedAt: number;
  finishedAt?: number;
}

const SHARDS_PER_VOLUME = 14;

// Recognise lines like:
//   "encoding volume 7 ..."        → starts volume 7
//   "ec.encode volume 7 ..."       → starts volume 7
//   "--- volume 7 ---"             → starts volume 7 (decode batch marker)
//   "generated volume 7 ec shards" → completes volume 7
//   "copying ec shard 3 of volume 7 to 10.0.0.5:8080"
//   "mounting ec shard 3 of volume 7 on 10.0.0.5:8080"
//   "volume 7.ec03 from 10.0.0.1 to 10.0.0.5"
const reVolStart    = /(?:^|\s)(?:encoding|decoding|ec\.encode|ec\.decode|---)\s+volume\s+(\d+)/i;
const reShardCopy   = /(?:copying|mounting|moving)\s+(?:ec\s+)?shard\s+(\d+)\s+of\s+volume\s+(\d+)(?:\s+(?:to|on|from)\s+(\S+))?/i;
const reShardSuffix = /volume\s+(\d+)\.ec([0-9a-f]{2})\b.*?(?:to|on)\s+(\S+)/i;
const reVolDone     = /(?:generated|wrote|finished|done\s+with)\s+(?:volume\s+|encoding\s+volume\s+)?(\d+)(?:\s|$)/i;

export function ECProgressStream({
  url, body, expectedVolumes, onClose, onDone, title, subtitle, variant = "modal",
}: Props) {
  const { t } = useT();
  const [lines, setLines] = useState<string[]>([]);
  const [volumes, setVolumes] = useState<Map<number, VolumeProgress>>(new Map());
  // node → shard count seen on this node (target side of copy/mount lines)
  const [targets, setTargets] = useState<Map<string, number>>(new Map());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Flags from the start event so we can render a "命令行" preview at
  // the top of the panel — operators want to see the exact `weed shell`
  // invocation before scrolling through the tail.
  const [startArgs, setStartArgs] = useState<string[]>([]);
  const [startCommand, setStartCommand] = useState<string>("");
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const tailRef = useRef<HTMLPreElement>(null);

  // Tick the wall clock so elapsed/ETA refresh even when no lines arrive.
  useEffect(() => {
    if (finishedAt) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [finishedAt]);

  // Auto-scroll the tail.
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        const resp = await fetch(`${BASE}${url}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "");
          const msg = `${resp.status} ${txt || resp.statusText}`;
          setErr(msg);
          setOk(false);
          // Propagate the failure reason so callers can toast/log it
          // instead of having to scrape the inline tail.
          onDone?.(false, { error: msg });
          return;
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        // Each SSE event is separated by a blank line. Parse incrementally.
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleEvent(ev);
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(msg);
          setOk(false);
          onDone?.(false, { error: msg });
        }
      }
    })();
    return () => { ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Parse one SSE event (event:/data: lines).
  function handleEvent(raw: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const ln of raw.split("\n")) {
      if (ln.startsWith("event: ")) event = ln.slice(7).trim();
      else if (ln.startsWith("data: ")) dataLines.push(ln.slice(6));
    }
    const data = dataLines.join("\n");

    if (event === "start") {
      try {
        const obj = JSON.parse(data) as { started_at?: number; args?: string[]; command?: string };
        setStartedAt(obj.started_at || Date.now());
        if (Array.isArray(obj.args)) setStartArgs(obj.args);
        if (obj.command) setStartCommand(obj.command);
      } catch { setStartedAt(Date.now()); }
      return;
    }
    if (event === "done") {
      try {
        const obj = JSON.parse(data) as { ok?: boolean; error?: string };
        setFinishedAt(Date.now());
        setOk(!!obj.ok);
        if (obj.error) setErr(obj.error);
        onDone?.(!!obj.ok, obj as Record<string, unknown>);
      } catch {
        setFinishedAt(Date.now());
        setOk(true);
        onDone?.(true, {});
      }
      return;
    }
    if (event === "line") {
      pushLine(data);
      return;
    }
    if (event === "ping") {
      // Keepalive heartbeat — fired by backends whose shell goes quiet
      // during lock acquisition or topology collection. We just nudge
      // the clock so the elapsed counter stays accurate and the tail
      // shows we're still connected.
      try {
        const obj = JSON.parse(data) as { elapsed_ms?: number };
        if (typeof obj.elapsed_ms === "number") {
          setNow(Date.now());
        }
      } catch { /* ignore */ }
      // Surface a low-key idle marker so the operator sees activity
      // even when the shell is mid-15s topology gather. Replace the
      // previous idle marker rather than stacking them up.
      setLines(prev => {
        if (prev.length > 0 && prev[prev.length - 1].startsWith("… still waiting")) {
          const copy = prev.slice(0, -1);
          copy.push(`… still waiting (${(elapsedMs / 1000).toFixed(0)}s)`);
          return copy;
        }
        return [...prev, `… still waiting (${(elapsedMs / 1000).toFixed(0)}s)`];
      });
    }
  }

  function pushLine(line: string) {
    setLines(prev => {
      const next = prev.length > 800 ? prev.slice(-700) : prev.slice();
      next.push(line);
      return next;
    });

    // Volume start.
    let m = line.match(reVolStart);
    if (m) {
      const id = parseInt(m[1], 10);
      setVolumes(prev => {
        if (prev.has(id)) return prev;
        const next = new Map(prev);
        next.set(id, { id, shardsSeen: new Set(), startedAt: Date.now() });
        return next;
      });
    }

    // Shard copy/mount/move — extracts shard idx + target node.
    let shardIdx: number | null = null;
    let volID: number | null = null;
    let target: string | null = null;
    m = line.match(reShardCopy);
    if (m) {
      shardIdx = parseInt(m[1], 10);
      volID = parseInt(m[2], 10);
      target = m[3] || null;
    } else {
      m = line.match(reShardSuffix);
      if (m) {
        volID = parseInt(m[1], 10);
        shardIdx = parseInt(m[2], 16); // hex two-char suffix
        target = m[3] || null;
      }
    }
    if (volID != null && shardIdx != null) {
      setVolumes(prev => {
        const cur = prev.get(volID!) || { id: volID!, shardsSeen: new Set<number>(), startedAt: Date.now() };
        if (cur.shardsSeen.has(shardIdx!)) return prev;
        const next = new Map(prev);
        const updated: VolumeProgress = {
          ...cur,
          shardsSeen: new Set([...cur.shardsSeen, shardIdx!]),
        };
        if (updated.shardsSeen.size >= SHARDS_PER_VOLUME) {
          updated.finishedAt = Date.now();
        }
        next.set(volID!, updated);
        return next;
      });
      if (target) {
        setTargets(prev => {
          const next = new Map(prev);
          next.set(target!, (next.get(target!) || 0) + 1);
          return next;
        });
      }
    }

    // Explicit completion marker (some `ec.*` builds emit one).
    m = line.match(reVolDone);
    if (m) {
      const id = parseInt(m[1], 10);
      setVolumes(prev => {
        const cur = prev.get(id);
        if (!cur || cur.finishedAt) return prev;
        const next = new Map(prev);
        next.set(id, { ...cur, finishedAt: Date.now() });
        return next;
      });
    }
  }

  // ───── derived metrics ─────
  const elapsedMs = startedAt ? (finishedAt || now) - startedAt : 0;
  const totalShardsSeen = [...volumes.values()].reduce((s, v) => s + v.shardsSeen.size, 0);
  const expectedShards = Math.max(SHARDS_PER_VOLUME, expectedVolumes * SHARDS_PER_VOLUME);
  const progressPct = Math.min(100, (totalShardsSeen / expectedShards) * 100);
  const linesPerSec = elapsedMs > 0 ? lines.length / (elapsedMs / 1000) : 0;
  const shardsPerSec = elapsedMs > 0 ? totalShardsSeen / (elapsedMs / 1000) : 0;
  const remainingShards = Math.max(0, expectedShards - totalShardsSeen);
  const etaSec = shardsPerSec > 0 && !finishedAt ? remainingShards / shardsPerSec : 0;

  const cancel = () => {
    abortRef.current?.abort();
    onClose();
  };

  // Header bar — used at the top of the body in both variants. The
  // modal wrapper just adds backdrop + footer chrome around it.
  const statusHeader = (
    <div className="flex items-center justify-between gap-3 pb-2 border-b border-border/60">
      <div className="min-w-0">
        <h2 className="text-sm font-medium tracking-tight inline-flex items-center gap-2">
          {finishedAt && ok ? <CheckCircle2 size={14} className="text-success"/>
            : finishedAt && !ok ? <AlertTriangle size={14} className="text-danger"/>
            : <Loader2 size={14} className="text-accent animate-spin"/>}
          {title}
        </h2>
        {subtitle && <p className="text-[11px] text-muted mt-0.5 font-mono truncate">{subtitle}</p>}
      </div>
      <button
        className="text-muted hover:text-text shrink-0"
        onClick={cancel}
        aria-label={finishedAt ? t("Close") : t("Cancel")}
        title={finishedAt ? t("Close") : t("Cancel")}>
        <X size={14}/>
      </button>
    </div>
  );

  const cmdBlock = startCommand && (
    <CommandPreview command={startCommand} args={startArgs}/>
  );

  const panel = (
    <div className={variant === "inline" ? "space-y-3" : "px-5 py-4 overflow-auto flex-1 space-y-3"}>
      {variant === "inline" && statusHeader}
          {cmdBlock}
          {/* Top metrics row */}
          <div className="grid grid-cols-4 gap-2 text-xs">
            <Metric label={t("Elapsed")} value={formatDuration(elapsedMs)}/>
            <Metric label={t("ETA")} value={finishedAt ? "—" : etaSec > 0 ? formatDuration(etaSec * 1000) : t("calculating…")}/>
            <Metric label={t("Shards / sec")} value={shardsPerSec.toFixed(2)}/>
            <Metric label={t("Lines / sec")} value={linesPerSec.toFixed(1)}/>
          </div>

          {/* Overall progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-muted mb-1">
              <span>{t("Overall progress")}</span>
              <span className="font-mono">
                {totalShardsSeen}/{expectedShards} {t("shards")} · {progressPct.toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-bg overflow-hidden border border-border">
              <div
                className={`h-full transition-[width] duration-300 ${finishedAt && !ok ? "bg-danger" : "bg-accent"}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Per-volume status */}
          {volumes.size > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">{t("Per-volume")}</div>
              <ul className="space-y-1 max-h-[200px] overflow-auto">
                {[...volumes.values()].sort((a, b) => a.id - b.id).map(v => (
                  <li key={v.id} className="flex items-center gap-2 text-xs">
                    <span className="font-mono w-12">vol {v.id}</span>
                    <div className="flex gap-0.5 shrink-0">
                      {Array.from({ length: SHARDS_PER_VOLUME }, (_, i) => (
                        <span
                          key={i}
                          title={`shard ${i}: ${v.shardsSeen.has(i) ? "done" : "pending"}`}
                          style={{
                            background: v.shardsSeen.has(i) ? "var(--color-accent, oklch(74% 0.18 230))" : "rgba(255,255,255,0.08)",
                            width: 10, height: 10, borderRadius: 2, display: "inline-block",
                          }}
                        />
                      ))}
                    </div>
                    <span className="font-mono text-muted">{v.shardsSeen.size}/{SHARDS_PER_VOLUME}</span>
                    {v.finishedAt && <span className="text-success text-[10px]">✓</span>}
                    <span className="text-muted text-[10px]">{formatDuration((v.finishedAt || now) - v.startedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Target node map */}
          {targets.size > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">{t("Target nodes")}</div>
              <ul className="space-y-0.5 text-xs max-h-[120px] overflow-auto">
                {[...targets.entries()].sort((a, b) => b[1] - a[1]).map(([node, n]) => (
                  <li key={node} className="flex items-center gap-2">
                    <span className="font-mono text-muted">{node}</span>
                    <div className="flex-1 h-1 bg-bg rounded">
                      <div className="h-full bg-accent rounded"
                        style={{ width: `${Math.min(100, (n / Math.max(1, totalShardsSeen)) * 100 * 5)}%` }}/>
                    </div>
                    <span className="font-mono text-muted shrink-0">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {err && (
            <div className="text-sm text-danger inline-flex items-center gap-2">
              <AlertTriangle size={14}/> {err}
            </div>
          )}

          {/* Live tail */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">{t("Output (tail)")}</div>
            <pre
              ref={tailRef}
              className={`font-mono text-[10px] p-2 rounded bg-bg border border-border overflow-auto ${
                variant === "inline" ? "max-h-[18vh]" : "max-h-[28vh]"
              }`}>
              {lines.length === 0 ? t("(waiting for output…)") : lines.join("\n")}
            </pre>
          </div>
    </div>
  );

  // Inline variant: caller embeds `panel` directly into its own dialog.
  if (variant === "inline") return panel;

  // Modal variant: full-screen overlay + footer cancel button.
  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog" aria-modal="true">
      <div
        className="card bg-panel border border-border w-full max-w-3xl max-h-[92vh] flex flex-col shadow-soft"
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          {statusHeader}
        </header>
        {panel}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={cancel}>
            {finishedAt ? t("Close") : t("Cancel")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-sm font-mono mt-0.5">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
