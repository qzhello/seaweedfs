"use client";

// Inline AI helper for a single wizard section. Operator clicks
// "Suggest with AI" → AI returns just that section, validated server-
// side against the skill schema → operator sees the preview + decides
// to Append / Replace / Discard.
//
// Append vs Replace matters: for steps/rollback/postchecks/preconditions
// the operator may already have a few entries they hand-built and just
// want AI to extend (append). Risk is single-valued so it's always
// replace.

import { useState } from "react";
import { Sparkles, Loader2, X, Plus, RotateCw } from "lucide-react";
import { skillWizardSuggest, type SkillWizardSection } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { WizardDraft, SkillStep, SkillCheck, RiskLevel } from "./skill-wizard";

type RollbackStep = { op: string; args?: Record<string, unknown>; doc?: string };

export interface AISuggestProps {
  section: SkillWizardSection;
  draft: WizardDraft;
  /** Called with the AI's suggestion when the operator picks Append. */
  onAppend?: (suggestion: unknown) => void;
  /** Called with the AI's suggestion when the operator picks Replace. */
  onReplace?: (suggestion: unknown) => void;
}

export function AISuggestButton({ section, draft, onAppend, onReplace }: AISuggestProps) {
  const { t } = useT();
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [hint, setHint]         = useState("");
  const [suggestion, setSuggestion] = useState<unknown>(null);
  const [rationale, setRationale]   = useState("");
  const [provider, setProvider]     = useState("");
  const [error, setError]           = useState<string | null>(null);

  const reset = () => {
    setSuggestion(null); setRationale(""); setError(null);
  };

  const run = async () => {
    setLoading(true); reset();
    try {
      const r = await skillWizardSuggest({ section, draft, extra_context: hint.trim() || undefined });
      if (!r.ok) {
        setError(r.error || t("AI call failed."));
      } else {
        setSuggestion(r.suggestion);
        setRationale(r.rationale || "");
        setProvider(r.provider_name || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const label = SECTION_LABELS[section];

  return (
    <div className="rounded border border-accent/30 bg-accent/5">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-accent">
          <Sparkles size={12}/> {t("Suggest {section} with AI").replace("{section}", t(label))}
        </span>
        <span className="text-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-accent/20 p-3">
          <label className="block text-xs">
            <span className="text-muted">{t("Operator hint (optional)")}</span>
            <input
              className="input w-full"
              placeholder={t("e.g. include EC rebuild, target collection logs-*")}
              value={hint}
              onChange={e => setHint(e.target.value)}
              disabled={loading}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn text-xs" onClick={run} disabled={loading}>
              {loading ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
              {loading ? t("Generating…") : suggestion ? t("Regenerate") : t("Generate")}
            </button>
            <span className="text-[10px] text-muted">
              {t("Validated server-side before preview. You decide whether to apply.")}
            </span>
          </div>

          {error && (
            <div className="rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
              {error}
            </div>
          )}

          {suggestion !== null && !error && (
            <SuggestionPreview
              section={section}
              suggestion={suggestion}
              rationale={rationale}
              provider={provider}
              onAppend={onAppend ? () => { onAppend(suggestion); reset(); setOpen(false); } : undefined}
              onReplace={onReplace ? () => { onReplace(suggestion); reset(); setOpen(false); } : undefined}
              onDiscard={() => reset()}
            />
          )}
        </div>
      )}
    </div>
  );
}

const SECTION_LABELS: Record<SkillWizardSection, string> = {
  steps:         "steps",
  rollback:      "rollback",
  postchecks:    "postchecks",
  preconditions: "preconditions",
  risk:          "risk",
};

function SuggestionPreview({ section, suggestion, rationale, provider, onAppend, onReplace, onDiscard }: {
  section: SkillWizardSection;
  suggestion: unknown;
  rationale: string;
  provider: string;
  onAppend?: () => void;
  onReplace?: () => void;
  onDiscard: () => void;
}) {
  const { t } = useT();
  return (
    <div className="space-y-2 rounded bg-panel2 p-2 text-xs">
      {rationale && (
        <p className="text-muted">
          <span className="font-medium text-text">{t("Why")}: </span>{rationale}
          {provider && <span className="ml-1 text-[10px]">· {provider}</span>}
        </p>
      )}
      <div className="rounded border border-divider bg-panel p-2">
        {renderSuggestion(section, suggestion, t)}
      </div>
      <div className="flex flex-wrap gap-2">
        {onAppend && (
          <button type="button" className="btn text-xs bg-accent/15 text-accent border-accent/40"
                  onClick={onAppend}>
            <Plus size={12}/> {t("Append")}
          </button>
        )}
        {onReplace && (
          <button type="button" className="btn text-xs" onClick={onReplace}>
            <RotateCw size={12}/> {t("Replace")}
          </button>
        )}
        <button type="button" className="btn text-xs" onClick={onDiscard}>
          <X size={12}/> {t("Discard")}
        </button>
      </div>
    </div>
  );
}

function renderSuggestion(section: SkillWizardSection, s: unknown, t: (k: string) => string): React.ReactNode {
  if (section === "risk") {
    const r = String(s) as RiskLevel;
    const cls = {
      low:      "text-success",
      medium:   "text-warning",
      high:     "text-danger",
      critical: "text-danger font-bold",
    }[r] ?? "text-muted";
    return <span className={`font-mono ${cls}`}>{r}</span>;
  }
  if (!Array.isArray(s) || s.length === 0) {
    return <span className="text-muted">{t("(empty)")}</span>;
  }
  if (section === "steps") {
    return (
      <ol className="space-y-1">
        {(s as SkillStep[]).map((step, i) => (
          <li key={i} className="font-mono text-[11px]">
            <span className="text-muted">{i + 1}.</span> <span className="text-accent">{step.op}</span>
            {step.id && <span className="text-muted"> #{step.id}</span>}
            {step.on_failure && step.on_failure !== "abort" && (
              <span className="ml-1 text-[10px] text-warning">on_failure={step.on_failure}</span>
            )}
            {step.doc && <div className="ml-3 text-muted">{step.doc}</div>}
          </li>
        ))}
      </ol>
    );
  }
  if (section === "rollback") {
    return (
      <ol className="space-y-1">
        {(s as RollbackStep[]).map((r, i) => (
          <li key={i} className="font-mono text-[11px]">
            <span className="text-muted">{i + 1}.</span> <span className="text-accent">{r.op}</span>
            {r.doc && <div className="ml-3 text-muted">{r.doc}</div>}
          </li>
        ))}
      </ol>
    );
  }
  // postchecks / preconditions — both SkillCheck[]
  return (
    <ol className="space-y-1">
      {(s as SkillCheck[]).map((c, i) => (
        <li key={i} className="font-mono text-[11px]">
          <span className="text-muted">{i + 1}.</span> <span className="text-accent">{c.check}</span>
          {c.fatal && <span className="ml-1 text-[10px] text-danger">fatal</span>}
          {c.doc && <div className="ml-3 text-muted">{c.doc}</div>}
        </li>
      ))}
    </ol>
  );
}
