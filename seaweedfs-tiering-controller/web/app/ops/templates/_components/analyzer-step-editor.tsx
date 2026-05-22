"use client";

import Link from "next/link";
import { Trash2, FileCode2, Tag } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { OpsStep, AnalyzerScript } from "@/lib/api";

// AnalyzerStepEditor is the right-panel detail editor when the
// selected step has kind="analyzer". Lets the operator pick a script
// from the platform library, choose which upstream step's stdout
// feeds it, and fill declared params (with placeholder substitution
// — same as shell args).
//
// Falls back to a "go author one" CTA when no scripts exist so a
// fresh install still has a discoverable next step.
export function AnalyzerStepEditor({
  step, stepIdx, allSteps, analyzerScripts, onChange, onRemove,
}: {
  step: OpsStep;
  stepIdx: number;
  allSteps: OpsStep[];
  analyzerScripts: AnalyzerScript[];
  onChange: (patch: Partial<OpsStep>) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const cfg = step.analyzer ?? { script_name: "", from_step: "", params: {} };
  const updateCfg = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    onChange({ analyzer: next, command: "analyzer:" + (next.script_name || "") });
  };

  const selected = analyzerScripts.find(s => s.name === cfg.script_name);
  const enabledScripts = analyzerScripts.filter(s => s.enabled);

  // Candidate "from step" options: any step earlier than this one,
  // by source-array index. Empty string = "use last completed
  // dependency at runtime".
  const upstreamSteps = allSteps.slice(0, stepIdx).filter(s => s.id);

  // Render params editor based on the selected script's declared
  // params. We render an input per declared param; operators can
  // type literal values or `{{var}}` references.
  const params = selected?.params ?? [];

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <FileCode2 size={14} className="text-accent shrink-0"/>
        <span className="text-xs font-medium">{t("Analyzer step")}</span>
        <button onClick={onRemove} className="p-1 text-muted hover:text-rose-300 ml-auto" title={t("Delete step")}>
          <Trash2 size={14}/>
        </button>
      </div>

      {enabledScripts.length === 0 ? (
        <div className="text-[11px] text-muted italic border border-border/40 rounded-md p-2">
          No analyzer scripts are available. Visit{" "}
          <Link href="/scripts" className="text-accent hover:underline">Analyzer Scripts</Link>{" "}
          to author one — or run the seed migration to load the system library.
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Script")}</label>
            <select
              value={cfg.script_name}
              onChange={(e) => updateCfg({ script_name: e.target.value })}
              className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm font-mono"
            >
              <option value="">{t("— pick a script —")}</option>
              {enabledScripts.map(s => (
                <option key={s.id} value={s.name}>
                  {s.name}
                  {s.for_commands.length > 0 ? `  (${s.for_commands.join(", ")})` : ""}
                </option>
              ))}
            </select>
            {selected && (
              <div className="text-[11px] text-muted mt-1">
                <div>{selected.title}</div>
                {selected.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {selected.tags.map(tg => (
                      <span key={tg} className="badge text-[10px] inline-flex items-center gap-1">
                        <Tag size={9}/>{tg}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted">
              {t("Input from step")}
              <span className="text-muted/70 normal-case tracking-normal text-[10px] ml-1">
                {t("(empty = use last completed dependency)")}
              </span>
            </label>
            <select
              value={cfg.from_step ?? ""}
              onChange={(e) => updateCfg({ from_step: e.target.value || undefined })}
              className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
            >
              <option value="">({t("auto")})</option>
              {upstreamSteps.map(s => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.kind === "analyzer" ? `analyzer:${s.analyzer?.script_name ?? ""}` : s.command}
                </option>
              ))}
            </select>
          </div>

          {params.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted">{t("Params")}</div>
              {params.map(p => (
                <div key={p.name} className="space-y-0.5">
                  <label className="text-[10px] text-muted/80 inline-flex items-center gap-1">
                    <code className="font-mono text-text">{p.name}</code>
                    <span className="text-[9px] uppercase">{p.type}</span>
                    {p.required && <span className="text-rose-400">*</span>}
                  </label>
                  <input
                    value={(cfg.params ?? {})[p.name] ?? ""}
                    onChange={(e) => updateCfg({
                      params: { ...(cfg.params ?? {}), [p.name]: e.target.value },
                    })}
                    placeholder={
                      p.default !== undefined
                        ? `${t("default")}: ${String(p.default)}`
                        : p.doc || p.name
                    }
                    className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs font-mono"
                  />
                  {p.doc && (
                    <div className="text-[10px] text-muted/70">{p.doc}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border/40 pt-2 mt-2 text-[10px] text-muted">
            <div className="font-medium mb-1">{t("How to use the result")}</div>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>
                {t("Downstream steps can reference the JSON via")}{" "}
                <code className="font-mono text-text">
                  {`{{${step.id ?? "sN"}.analyzer}}`}
                </code>
              </li>
              <li>
                {t("Top-level object keys are exposed individually, e.g.")}{" "}
                <code className="font-mono text-text">
                  {`{{${step.id ?? "sN"}.analyzer.max_node}}`}
                </code>
              </li>
              <li>
                {t("Add a Capture below to pull regex matches out of the JSON the same way as shell output.")}
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
