"use client";

// Policy time-machine modal. Runs the policy against the selected cluster
// and shows the matched/skipped breakdown + cost projection. No side
// effects — purely a dry-run.
//
// Two modes: "live" (default — current cluster topology) and "as of" (a
// past instant, dry-run against the volume_features snapshot nearest that
// time). The operator picks a time and re-runs.

import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, Loader2, X, AlertTriangle, CheckCircle2, History } from "lucide-react";
import { api, type PolicySimResp } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes as fmtBytes } from "@/lib/utils";

interface Props {
  policyID: string;
  policyName: string;
  clusterID: string;
  onClose: () => void;
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. Used to build
// both the "now" ceiling and the "90 days ago" floor (the collector's
// feature TTL) so the operator can't pick a window with no data.
function localStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PolicySimulateModal({ policyID, policyName, clusterID, onClose }: Props) {
  const { t } = useT();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PolicySimResp | null>(null);
  const [err, setErr] = useState("");
  // datetime-local string; "" === live cluster state.
  const [asOf, setAsOf] = useState("");

  // Monotonic request id — guards against a slow earlier request landing
  // after a faster later one and clobbering the result.
  const reqIdRef = useRef(0);

  const run = useCallback((asOfValue: string) => {
    if (!clusterID) return;
    const myId = ++reqIdRef.current;
    setRunning(true);
    setErr("");
    const iso = asOfValue ? new Date(asOfValue).toISOString() : undefined;
    api.simulatePolicy(policyID, clusterID, iso)
      .then(r => { if (reqIdRef.current === myId) setResult(r); })
      .catch(e => { if (reqIdRef.current === myId) setErr((e as Error).message); })
      .finally(() => { if (reqIdRef.current === myId) setRunning(false); });
  }, [policyID, clusterID]);

  // Kick off a live simulation on mount — operators always want the
  // numbers; an extra click would only slow the workflow.
  useEffect(() => { run(""); }, [run]);

  // Escape closes the modal — matches every other dialog in the console.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const now = new Date();
  const floor = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-4xl max-h-[90vh] flex flex-col p-0">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <FlaskConical size={16} className="text-warning"/>
            {t("Policy time machine")}: <span className="font-mono">{policyName}</span>
          </h2>
          <button onClick={onClose} aria-label={t("Close")} className="text-muted hover:text-text"><X size={14}/></button>
        </header>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          {!clusterID && (
            <div className="card p-3 text-xs text-warning border-warning/40 bg-warning/5 inline-flex items-start gap-2">
              <AlertTriangle size={12} className="shrink-0 mt-0.5"/>
              {t("Pick a cluster in the top-right before simulating.")}
            </div>
          )}

          {/* Time selector — empty = live; a past instant dry-runs against
              the nearest feature snapshot. */}
          <div className="card p-3 flex items-center gap-2 flex-wrap text-xs">
            <History size={13} className="text-muted shrink-0"/>
            <span className="text-muted">{t("Simulate as of")}</span>
            <input
              type="datetime-local"
              className="input w-auto py-1 text-xs"
              value={asOf}
              min={localStamp(floor)}
              max={localStamp(now)}
              onChange={e => setAsOf(e.target.value)}
            />
            {asOf && (
              <button
                onClick={() => { setAsOf(""); run(""); }}
                className="text-[11px] text-muted hover:text-text underline underline-offset-2">
                {t("back to live")}
              </button>
            )}
            <button
              onClick={() => run(asOf)}
              disabled={running || !clusterID}
              className="btn btn-primary py-1 inline-flex items-center gap-1.5 disabled:opacity-50">
              {running ? <Loader2 size={12} className="animate-spin"/> : <FlaskConical size={12}/>}
              {result ? t("Re-run") : t("Run")}
            </button>
            <span className="text-[11px] text-muted basis-full">
              {t("Empty = live cluster state. Pick a past time (up to 90 days back) to dry-run against history.")}
            </span>
          </div>

          {err && (
            <div className="card p-3 text-xs text-danger border-danger/40 bg-danger/5">{err}</div>
          )}
          {running && (
            <div className="text-center py-12 text-sm text-muted inline-flex items-center justify-center gap-2 w-full">
              <Loader2 size={14} className="animate-spin"/>
              {asOf ? t("Simulating against historical snapshot…") : t("Simulating against live cluster state…")}
            </div>
          )}
          {!running && result && <ResultBody t={t} result={result}/>}
        </div>

        <footer className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          <div className="text-[11px] text-muted mr-auto italic">
            {t("This is a dry-run. No volumes are migrated.")}
          </div>
          <button onClick={onClose} className="btn">{t("Close")}</button>
        </footer>
      </div>
    </div>
  );
}

function ResultBody({ t, result }: { t: (k: string) => string; result: PolicySimResp }) {
  const params = result.effective_params;
  return (
    <div className="space-y-3">
      {result.as_of && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-warning border border-warning/40 bg-warning/5 rounded-full px-2.5 py-0.5">
          <History size={11}/>
          {t("Time-machine result — snapshot at")} {new Date(result.as_of).toLocaleString()}
        </div>
      )}

      {/* Headline */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label={t("Considered")} value={result.considered_volumes.toLocaleString()} sub={t("in scope")}/>
        <Tile label={t("Would match")} value={result.matched_volumes.toLocaleString()} sub={fmtBytes(result.matched_bytes)} tone="success"/>
        <Tile label={t("Would skip")} value={result.skipped_volumes.toLocaleString()} sub={t("filtered out")} tone="muted"/>
        <Tile
          label={t("Est. monthly saving")}
          value={result.est_monthly_saving > 0
            ? `${result.est_saving_currency} ${result.est_monthly_saving.toFixed(2)}`
            : "—"}
          sub={result.hot_reference_backend ? `vs ${result.hot_reference_backend}` : t("set target_backend + hot ref")}
          tone={result.est_monthly_saving > 0 ? "success" : "muted"}/>
      </section>

      {/* Effective params */}
      <section className="card p-3 text-xs space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-muted">{t("Effective params")}</div>
        <div className="font-mono text-[11px] grid grid-cols-2 gap-x-4 gap-y-0.5">
          <div>min_quiet_days: <span className="text-text">{params.min_quiet_days ?? "—"}</span></div>
          <div>min_size_bytes: <span className="text-text">{params.min_size_bytes ?? "—"}</span></div>
          <div>max_reads_30d: <span className="text-text">{params.max_reads_30d ?? t("unlimited")}</span></div>
          <div>target_backend: <span className="text-text">{params.target_backend ?? "—"}</span></div>
          <div>exclude_readonly: <span className="text-text">{String(params.exclude_readonly ?? false)}</span></div>
          <div>collection_glob: <span className="text-text">{params.collection_glob ?? "—"}</span></div>
        </div>
      </section>

      {/* Skip reasons */}
      {Object.keys(result.skip_reasons).length > 0 && (
        <section className="card p-3 text-xs space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t("Skip reasons")}</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(result.skip_reasons).map(([k, v]) => (
              <span key={k} className="badge text-[10px] border-muted/40 text-muted">
                {k}: {v}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* By collection */}
      {result.by_collection.length > 0 && (
        <section className="card overflow-hidden">
          <header className="px-3 py-2 border-b border-border text-xs font-semibold">{t("Matches by collection")}</header>
          <table className="grid">
            <thead><tr><th>{t("Collection")}</th><th className="text-right">{t("Volumes")}</th><th className="text-right">{t("Bytes")}</th></tr></thead>
            <tbody>
              {result.by_collection.map(c => (
                <tr key={c.collection || "__default__"}>
                  <td className="font-mono text-xs">{c.collection || "(default)"}</td>
                  <td className="text-right font-mono text-xs">{c.volumes.toLocaleString()}</td>
                  <td className="text-right font-mono text-xs">{fmtBytes(c.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Sample matches */}
      {result.samples.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-text">
            {t("Sample matched volumes ({n})").replace("{n}", String(result.samples.length))}
          </summary>
          <table className="grid mt-2">
            <thead><tr>
              <th>{t("Volume")}</th><th>{t("Collection")}</th><th>{t("Server")}</th>
              <th className="text-right">{t("Bytes")}</th><th className="text-right">{t("Quiet days")}</th>
              <th>{t("Reason")}</th>
            </tr></thead>
            <tbody>
              {result.samples.map(s => (
                <tr key={s.volume_id}>
                  <td className="font-mono text-xs">#{s.volume_id}</td>
                  <td className="font-mono text-xs">{s.collection || "(default)"}</td>
                  <td className="font-mono text-[11px] text-muted truncate max-w-[140px]" title={s.server}>{s.server || "—"}</td>
                  <td className="text-right font-mono text-xs">{fmtBytes(s.bytes)}</td>
                  <td className="text-right font-mono text-xs">{s.quiet_days}</td>
                  <td className="text-[11px] text-muted">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {result.matched_volumes === 0 && (
        <div className="card p-3 text-xs text-muted text-center inline-flex items-center justify-center gap-2 w-full">
          <CheckCircle2 size={12}/> {t("No volumes match this policy under current state. Adjust params and retry, or wait for more cold data to accumulate.")}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: "muted" | "success";
}) {
  const valTone = tone === "success" ? "text-success" : "text-text";
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-lg font-semibold mt-1 tabular-nums ${valTone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}
