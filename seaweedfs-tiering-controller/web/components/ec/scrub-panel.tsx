"use client";

// Live panel for an on-demand EC scrub (POST + text/event-stream).
// Renders an elapsed timer, a rolling stdout tail, and — on the `done`
// event — a structured green/red summary of broken EC volumes/shards.
// Unlike ECProgressStream this does NOT parse per-shard progress: ec.scrub
// reports per-node ("Scrubbing addr (i/N)"), so we just tail + summarize.

import { useEffect, useRef, useState } from "react";
import { authHeaders, BASE, type ECScrubSummary } from "@/lib/api";
import { Loader2, AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";

interface Props {
  clusterID: string;
  mode: string;
  onClose: () => void;
}

export function ECScrubPanel({ clusterID, mode, onClose }: Props) {
  const { t } = useT();
  const [lines, setLines] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<ECScrubSummary | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const tailRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (finishedAt) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [finishedAt]);

  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    // Reset accumulated state so a re-run (clusterID/mode change) doesn't
    // show the previous scrub's tail/summary until new events arrive.
    setLines([]);
    setStartedAt(null);
    setFinishedAt(null);
    setOk(null);
    setErr(null);
    setSummary(null);
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        const resp = await fetch(`${BASE}/clusters/${clusterID}/ec/scrub`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ mode }),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "");
          setErr(`${resp.status} ${txt || resp.statusText}`);
          setOk(false);
          setFinishedAt(Date.now());
          return;
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            handleEvent(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setErr(e instanceof Error ? e.message : String(e));
          setOk(false);
          setFinishedAt(Date.now());
        }
      }
    })();
    return () => { ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterID, mode]);

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
        const obj = JSON.parse(data) as { started_at?: number };
        setStartedAt(obj.started_at || Date.now());
      } catch { setStartedAt(Date.now()); }
    } else if (event === "line") {
      setLines(prev => {
        const next = prev.length > 800 ? prev.slice(-700) : prev.slice();
        next.push(data);
        return next;
      });
    } else if (event === "done") {
      setFinishedAt(Date.now());
      try {
        const obj = JSON.parse(data) as { ok?: boolean; error?: string; summary?: ECScrubSummary };
        setOk(!!obj.ok);
        if (obj.error) setErr(obj.error);
        if (obj.summary) setSummary(obj.summary);
      } catch { setOk(true); }
    }
    // ping events: ignore (heartbeat).
  }

  const elapsedMs = startedAt ? (finishedAt || now || Date.now()) - startedAt : 0;
  const elapsedS = Math.floor(elapsedMs / 1000);
  const running = !finishedAt;
  const cancel = () => { abortRef.current?.abort(); onClose(); };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">
          {running ? <Loader2 size={14} className="animate-spin text-accent"/>
            : ok ? <CheckCircle2 size={14} className="text-success"/>
            : <AlertTriangle size={14} className="text-danger"/>}
          {t("EC scrub")} · {mode}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted">{elapsedS}s</span>
          <button type="button" className="btn" onClick={cancel}>{running ? t("Cancel") : t("Close")}</button>
        </div>
      </div>

      {finishedAt && summary && (
        summary.broken_volumes === 0 && summary.broken_shards === 0 ? (
          <div className="text-xs text-success inline-flex items-center gap-2">
            <ShieldCheck size={14}/> {t("All EC shards intact")}
          </div>
        ) : (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 space-y-2 text-xs">
            <div className="text-danger inline-flex items-center gap-2 font-medium">
              <AlertTriangle size={14}/>
              {summary.broken_volumes} {t("broken EC volumes")} · {summary.broken_shards} {t("broken shards")}
            </div>
            {summary.affected_volumes.length > 0 && (
              <div><span className="text-muted">{t("Affected volumes")}: </span>
                <span className="font-mono break-all">{summary.affected_volumes.join(", ")}</span></div>
            )}
            {summary.affected_shards.length > 0 && (
              <div><span className="text-muted">{t("Affected shards")}: </span>
                <span className="font-mono break-all">{summary.affected_shards.join(", ")}</span></div>
            )}
          </div>
        )
      )}

      {err && <div className="text-xs text-danger inline-flex items-center gap-2"><AlertTriangle size={14}/> {err}</div>}

      <pre ref={tailRef} className="font-mono text-[10px] p-2 rounded bg-bg border border-border overflow-auto max-h-[28vh] whitespace-pre-wrap">
        {lines.length === 0 ? t("(waiting for output…)") : lines.join("\n")}
      </pre>
    </div>
  );
}
