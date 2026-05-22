"use client";

// Capacity incidents — the dashboard surface of the auto-pause closed
// loop. When a cluster hits a capacity wall the controller auto-pauses
// tiering for it and opens an incident. This banner surfaces every open
// incident; the modal runs the AI analyst brief and lets the operator
// resolve it (which resumes tiering for that cluster).

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, X, Loader2, Sparkles, CheckCircle2 } from "lucide-react";
import {
  api, useCapacityIncidents,
  type CapacityIncident, type IncidentReport, type IncidentAction,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

export function CapacityIncidentsBanner() {
  const { t } = useT();
  const { data, mutate } = useCapacityIncidents("open");
  const [openID, setOpenID] = useState<string | null>(null);

  const incidents = data?.items ?? [];
  if (incidents.length === 0) return null;

  const active = incidents.find(i => i.id === openID) ?? null;

  return (
    <section className="card border-danger/40 bg-danger/5 p-4 space-y-3">
      <header className="inline-flex items-center gap-2 text-sm font-semibold text-danger">
        <AlertTriangle size={16}/>
        {t("Capacity incidents — tiering auto-paused")}
        <span className="badge border-danger/40 text-danger">{incidents.length}</span>
      </header>
      <ul className="space-y-1.5">
        {incidents.map(inc => (
          <li key={inc.id}>
            <button
              onClick={() => setOpenID(inc.id)}
              className="w-full text-left rounded-lg border border-danger/25 hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors px-3 py-2 flex items-center gap-3">
              <span className="font-mono text-xs text-text shrink-0">
                {inc.cluster_name || inc.cluster_id.slice(0, 8)}
              </span>
              <span className="text-[11px] text-muted truncate flex-1" title={inc.failure_message}>
                {inc.failure_message || t("capacity exhausted")}
              </span>
              {inc.ai_report
                ? <span className="badge border-accent/40 text-accent shrink-0 text-[10px]">
                    <Sparkles size={10} className="inline mr-1"/>{t("brief ready")}
                  </span>
                : <span className="badge border-muted/40 text-muted shrink-0 text-[10px]">
                    {t("not analysed")}
                  </span>}
              <span className="text-[11px] text-muted shrink-0">
                {new Date(inc.triggered_at).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <IncidentModal
          incident={active}
          onClose={() => setOpenID(null)}
          onChanged={() => mutate()}
        />
      )}
    </section>
  );
}

interface IncidentModalProps {
  incident: CapacityIncident;
  onClose: () => void;
  onChanged: () => void;
}

function IncidentModal({ incident, onClose, onChanged }: IncidentModalProps) {
  const { t } = useT();
  const [report, setReport] = useState<IncidentReport | null>(incident.ai_report ?? null);
  const [analyzing, setAnalyzing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [err, setErr] = useState("");
  const ranRef = useRef(false);

  const analyze = useCallback(() => {
    setAnalyzing(true);
    setErr("");
    api.analyzeIncident(incident.id)
      .then(r => {
        if (r.ok && r.report) setReport(r.report);
        else setErr(r.error || t("AI analysis failed"));
      })
      .catch(e => setErr((e as Error).message))
      .finally(() => setAnalyzing(false));
  }, [incident.id, t]);

  // Auto-run the analyst the first time an un-analysed incident is
  // opened — the operator opened it because they want answers now.
  useEffect(() => {
    if (!ranRef.current && !report) {
      ranRef.current = true;
      analyze();
    }
  }, [report, analyze]);

  // Escape closes the modal — but not mid-resolve, so we never unmount
  // while the resolve request is still in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !resolving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, resolving]);

  const resolve = () => {
    setResolving(true);
    setErr("");
    api.resolveIncident(incident.id)
      .then(() => { onChanged(); onClose(); })
      .catch(e => { setErr((e as Error).message); setResolving(false); });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget && !resolving) onClose(); }}>
      <div className="card w-full max-w-3xl max-h-[90vh] flex flex-col p-0">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <AlertTriangle size={16} className="text-danger"/>
            {t("Capacity incident")}:{" "}
            <span className="font-mono">{incident.cluster_name || incident.cluster_id.slice(0, 8)}</span>
          </h2>
          <button onClick={onClose} aria-label={t("Close")} className="text-muted hover:text-text">
            <X size={14}/>
          </button>
        </header>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <section className="card p-3 text-xs space-y-1">
            <div className="text-muted">
              {t("Triggered")}:{" "}
              <span className="text-text">{new Date(incident.triggered_at).toLocaleString()}</span>
            </div>
            <div className="text-muted">
              {t("Failure")}:{" "}
              <span className="font-mono text-danger break-all">{incident.failure_message || "—"}</span>
            </div>
            <div className="text-[11px] text-muted italic">
              {t("Tiering is paused for this cluster until the incident is resolved.")}
            </div>
          </section>

          {err && (
            <div className="card p-3 text-xs text-danger border-danger/40 bg-danger/5">{err}</div>
          )}

          {analyzing && (
            <div className="text-center py-10 text-sm text-muted inline-flex items-center justify-center gap-2 w-full">
              <Loader2 size={14} className="animate-spin"/>
              {t("AI analyst is reviewing capacity, growth and pricing…")}
            </div>
          )}

          {!analyzing && report && <ReportBody t={t} report={report}/>}
        </div>

        <footer className="border-t border-border px-5 py-3 flex items-center gap-2">
          <button
            onClick={analyze}
            disabled={analyzing}
            className="btn inline-flex items-center gap-1.5 disabled:opacity-50">
            {analyzing ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
            {report ? t("Re-analyse") : t("Analyse")}
          </button>
          <div className="flex-1"/>
          <button onClick={onClose} disabled={resolving} className="btn disabled:opacity-50">{t("Close")}</button>
          <button
            onClick={resolve}
            disabled={resolving}
            className="btn btn-primary inline-flex items-center gap-1.5 disabled:opacity-50">
            {resolving ? <Loader2 size={12} className="animate-spin"/> : <CheckCircle2 size={12}/>}
            {t("Resolve & resume tiering")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ReportBody({ t, report }: { t: (k: string) => string; report: IncidentReport }) {
  return (
    <div className="space-y-3">
      <section className="card p-3 space-y-1.5">
        <div className="text-[11px] uppercase tracking-wide text-muted">{t("Root cause")}</div>
        <div className="text-sm text-text">{report.root_cause}</div>
        {report.summary && <div className="text-xs text-muted">{report.summary}</div>}
      </section>

      <div className="text-[11px] uppercase tracking-wide text-muted">{t("Recommended actions")}</div>
      <div className="space-y-2">
        {(report.actions ?? []).map((a, i) => <ActionCard key={a.title || i} idx={i} a={a}/>)}
      </div>

      {report.provider && (
        <div className="text-[10px] text-muted text-right italic">
          {t("Analysed by")} {report.provider}
          {report.analyzed_at ? ` · ${new Date(report.analyzed_at).toLocaleString()}` : ""}
        </div>
      )}
    </div>
  );
}

function ActionCard({ idx, a }: { idx: number; a: IncidentAction }) {
  const riskTone =
    a.risk === "high" ? "border-danger/40 text-danger"
    : a.risk === "medium" ? "border-warning/40 text-warning"
    : "border-muted/40 text-muted";
  return (
    <div className="card p-3 space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="text-sm font-semibold tabular-nums text-accent shrink-0">{idx + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{a.title}</div>
          <div className="text-xs text-muted mt-0.5">{a.detail}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        {a.kind && <span className="badge border-accent/30 text-accent text-[10px]">{a.kind}</span>}
        {a.risk && <span className={`badge text-[10px] ${riskTone}`}>risk: {a.risk}</span>}
        {a.est_cost && <span className="badge border-muted/40 text-muted text-[10px]">{a.est_cost}</span>}
        {a.est_eta && <span className="badge border-muted/40 text-muted text-[10px]">ETA {a.est_eta}</span>}
      </div>
    </div>
  );
}
