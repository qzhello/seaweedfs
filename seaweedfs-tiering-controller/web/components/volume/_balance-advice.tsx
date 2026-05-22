"use client";

// AI balance-advice panel, rendered inside the Volume Balance dialog.
// It asks the backend to analyse the per-server volume spread and
// returns suggested volume.balance runs. Picking one fills the dialog's
// form (data center / writable / collection) — the operator still runs
// the dry-run plan from there.

import { useEffect, useState, useCallback } from "react";
import { Sparkles, RefreshCw, AlertTriangle, X, ArrowRight, CheckCircle2 } from "lucide-react";
import { api, type BalanceAdviceResp, type BalanceRecommendation } from "@/lib/api";
import { useT } from "@/lib/i18n";

const SEVERITY_TONE: Record<string, string> = {
  balanced: "border-success/40 text-success",
  minor: "border-muted/40 text-muted",
  significant: "border-warning/40 text-warning",
  severe: "border-danger/40 text-danger",
};
const CONFIDENCE_TONE: Record<string, string> = {
  high: "border-success/40 text-success",
  medium: "border-warning/40 text-warning",
  low: "border-muted/40 text-muted",
};

export function BalanceAdvicePanel({
  clusterID,
  onApply,
  onClose,
}: {
  clusterID: string;
  onApply: (rec: BalanceRecommendation) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [data, setData] = useState<BalanceAdviceResp | null>(null);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setData(await api.aiBalanceAdvice(clusterID));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [clusterID]);

  useEffect(() => {
    run();
  }, [run]);

  return (
    <div className="card border-accent/40 bg-accent/[0.03] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold inline-flex items-center gap-1.5">
          <Sparkles size={13} className="text-accent" /> {t("AI balance advice")}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={run}
            disabled={loading}
            className="p-1 rounded hover:bg-panel2 text-muted hover:text-text disabled:opacity-40"
            title={t("Re-analyse")}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-panel2 text-muted hover:text-text"
            title={t("Close")}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {loading && (
        <div className="py-3 flex items-center gap-2 text-xs text-muted">
          <Sparkles size={14} className="text-accent animate-pulse" />
          {t("Analysing volume distribution…")}
        </div>
      )}

      {!loading && err && (
        <div className="text-xs text-danger flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <div>
            {t("AI analysis failed.")}
            <div className="opacity-80 mt-0.5 font-mono break-all">{err}</div>
          </div>
        </div>
      )}

      {!loading && !err && data && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`badge text-[10px] ${SEVERITY_TONE[data.severity] ?? SEVERITY_TONE.minor}`}
            >
              {t(`balance:${data.severity}`)}
            </span>
            {data.summary && <span className="text-xs text-muted">{data.summary}</span>}
          </div>

          {data.recommendations.length === 0 ? (
            <div className="text-xs text-success inline-flex items-center gap-1.5">
              <CheckCircle2 size={13} /> {t("Cluster is already balanced — no run needed.")}
            </div>
          ) : (
            <div className="space-y-1.5">
              {data.recommendations.map((rec, i) => (
                <div
                  key={i}
                  className="rounded border border-border bg-bg/50 p-2 space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium">{rec.title}</span>
                        <span
                          className={`badge text-[10px] ${
                            CONFIDENCE_TONE[rec.confidence] ?? CONFIDENCE_TONE.medium
                          }`}
                        >
                          {t(rec.confidence)}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted mt-0.5 flex gap-2 flex-wrap font-mono">
                        <span>dc={rec.data_center || "*"}</span>
                        <span>collection={rec.collection || "*"}</span>
                        <span>writable={String(rec.writable)}</span>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary text-[11px] py-1 px-2 inline-flex items-center gap-1 shrink-0"
                      onClick={() => onApply(rec)}
                    >
                      {t("Apply to form")} <ArrowRight size={11} />
                    </button>
                  </div>
                  <p className="text-[11px] text-muted leading-relaxed">{rec.rationale}</p>
                </div>
              ))}
            </div>
          )}

          {data.provider && (
            <p className="text-[10px] text-muted text-right">
              {t("Generated by")} <span className="font-mono">{data.provider}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
