"use client";

import { CheckCircle2, Loader2, X } from "lucide-react";
import { CardSkeleton } from "@/components/table-skeleton";
import { useAudit, type OpsTemplate } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ModalShell } from "./modal-shell";

type AuditRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  payload: Record<string, unknown> | null;
};

// HistoryDialog reads the audit_log rows for a template and groups
// them by run_id, surfacing one card per run with its per-step
// outcomes. Legacy rows without a run_id (pre-DAG era) get bucketed
// under a synthetic key so they still surface.
export function HistoryDialog({
  template, onClose,
}: { template: OpsTemplate; onClose: () => void }) {
  const { t } = useT();
  const { data, isLoading } = useAudit({
    kind: "ops_template",
    targetID: template.id,
    limit: 500,
  });
  const items: AuditRow[] = (data as { items?: AuditRow[] })?.items ?? [];

  const runs = (() => {
    const m = new Map<string, AuditRow[]>();
    for (const it of items) {
      const runId = (it.payload?.run_id as string) || `unknown-${it.id}`;
      const list = m.get(runId) ?? [];
      list.push(it);
      m.set(runId, list);
    }
    const out: { runId: string; entries: AuditRow[]; latest: string }[] = [];
    for (const [runId, entries] of m.entries()) {
      entries.sort((a, b) => a.at.localeCompare(b.at));
      out.push({ runId, entries, latest: entries[entries.length - 1].at });
    }
    out.sort((a, b) => b.latest.localeCompare(a.latest));
    return out;
  })();

  return (
    <ModalShell onClose={onClose} title={`${t("Run history")}: ${template.name}`} wide>
      {isLoading && (
        <CardSkeleton lines={4} title={false}/>
      )}
      {!isLoading && runs.length === 0 && (
        <div className="text-sm text-muted text-center py-8">
          {t("No recorded runs yet for this template.")}
        </div>
      )}
      <div className="space-y-4">
        {runs.map(({ runId, entries }) => {
          const kickoff = entries.find(e => e.action === "ops_template.run_interactive" || e.action === "ops_template.run");
          const steps = entries.filter(e => e.action === "ops_template.step");
          const failed = steps.some(s => s.payload?.ok === false);
          const cluster = (kickoff?.payload?.cluster_id as string) || (steps[0]?.payload?.cluster_id as string) || "";
          return (
            <div key={runId} className="card p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-mono truncate text-muted">
                    {runId.startsWith("unknown-") ? t("(legacy)") : runId.slice(0, 8)}
                  </div>
                  <div className="text-sm">
                    {kickoff?.actor || steps[0]?.actor || "-"}
                    <span className="text-muted"> · {entries[0]?.at.replace("T", " ").slice(0, 19)}</span>
                  </div>
                  {cluster && (
                    <div className="text-[11px] text-muted">cluster: <span className="font-mono">{cluster.slice(0, 8)}</span></div>
                  )}
                </div>
                <span className={`badge ${failed ? "border-danger/40 text-danger" : "border-success/40 text-success"}`}>
                  {failed ? t("failed") : t("ok")} · {steps.length} {t("steps")}
                </span>
              </div>
              {steps.length > 0 && (
                <ol className="space-y-1.5">
                  {steps.map(s => {
                    const p = s.payload || {};
                    const ok = p.ok !== false;
                    const idx = (p.step_index as number | undefined) ?? 0;
                    return (
                      <li key={s.id} className="text-[11px] space-y-1">
                        <div className="font-mono break-all">
                          <span className="text-muted mr-1">{idx + 1}.</span>
                          {ok
                            ? <CheckCircle2 size={11} className="inline text-success mr-1"/>
                            : <X size={11} className="inline text-danger mr-1"/>}
                          <span>{String(p.command || "")}</span>
                          <span className="text-muted"> {String(p.args || "")}</span>
                        </div>
                        {!ok && p.error ? (
                          <div className="text-danger/90 font-mono pl-4 whitespace-pre-wrap break-all">{String(p.error)}</div>
                        ) : null}
                        {p.output ? (
                          <details className="pl-4">
                            <summary className="cursor-pointer text-muted hover:text-text text-[10px]">{t("Show output")}</summary>
                            <pre className="mt-1 bg-panel2 border border-border rounded p-2 whitespace-pre-wrap break-all text-[10px] leading-relaxed max-h-64 overflow-y-auto">
                              {String(p.output)}
                            </pre>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
