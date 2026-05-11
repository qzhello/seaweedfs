"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { GitFork, Wand2, FileCode2, ClipboardPaste } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { SOPEditor, type SOPDraft } from "@/components/sop-editor";
import { SkillImportCard } from "@/components/skill-import-card";
import {
  SkillWizard, type WizardDraft, type SkillMeta, type SkillDefinition, type RiskLevel,
} from "@/components/skill-wizard";
import { api, useSkills } from "@/lib/api";

// Three authoring modes share a single in-memory draft so the operator can
// flip between them without losing work:
//   Wizard — guided step-by-step (default)
//   JSON   — raw schema editor (power users / paste-ready content)
//   Paste  — paste an existing SOP and convert via AI or direct JSON

interface SkillRow {
  key: string;
  name: string;
  scope: "system" | "custom";
  risk_level: RiskLevel;
  category: string;
  definition: object;
}

type Mode = "wizard" | "json" | "paste";

const BLANK_DEF: SkillDefinition = {
  summary: "",
  params: [],
  preconditions: [],
  steps: [],
  rollback: [],
  postchecks: [],
};

export default function NewSkillPage() {
  const router = useRouter();
  const params = useSearchParams();
  const forkKey = params.get("fork") || "";
  const { data } = useSkills();
  const items: SkillRow[] = data?.items ?? [];
  const source = forkKey ? items.find(s => s.key === forkKey) : undefined;

  // Default draft — either a fork copy or a blank slate.
  const baseDraft: WizardDraft = useMemo(() => {
    if (source) {
      return {
        meta: {
          key: `custom.${source.key.replace(/^[a-z]+\./, "")}`,
          name: `${source.name} (custom)`,
          category: source.category,
          risk_level: source.risk_level,
          change_note: `Forked from ${source.key}`,
        },
        definition: source.definition as SkillDefinition,
      };
    }
    return {
      meta: { key: "", name: "", category: "general", risk_level: "low", change_note: "Initial version" },
      definition: BLANK_DEF,
    };
  }, [source]);

  // Single source of truth across all three modes.
  const [draft, setDraft] = useState<WizardDraft>(baseDraft);
  const [mode, setMode] = useState<Mode>("wizard");

  // When source resolves async (clusters list races SWR), re-seed once.
  useMemo(() => { setDraft(baseDraft); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [baseDraft]);

  const onSave = async (d: WizardDraft) => {
    await api.upsertSkill({
      key: d.meta.key,
      name: d.meta.name,
      category: d.meta.category,
      risk_level: d.meta.risk_level,
      definition: d.definition,
      change_note: d.meta.change_note,
    });
    router.push(`/skills/${encodeURIComponent(d.meta.key)}`);
  };

  // --- mode adapters: marshal WizardDraft <-> SOPDraft for the JSON editor
  const sopDraft: SOPDraft = useMemo(() => ({
    key:         draft.meta.key,
    name:        draft.meta.name,
    category:    draft.meta.category,
    risk_level:  draft.meta.risk_level,
    change_note: draft.meta.change_note,
    definition:  JSON.stringify(draft.definition, null, 2),
  }), [draft]);

  const onJsonSave = async (sd: SOPDraft) => {
    await onSave({
      meta: {
        key: sd.key, name: sd.name, category: sd.category,
        risk_level: sd.risk_level, change_note: sd.change_note,
      },
      definition: JSON.parse(sd.definition) as SkillDefinition,
    });
  };

  // Imported draft from SkillImportCard — replace state, jump to wizard so
  // the operator can review the conversion in the guided form.
  const onImport = (sd: SOPDraft) => {
    setDraft({
      meta: {
        key: sd.key, name: sd.name, category: sd.category,
        risk_level: sd.risk_level, change_note: sd.change_note,
      },
      definition: JSON.parse(sd.definition) as SkillDefinition,
    });
    setMode("wizard");
  };

  const headline = source ? `Fork ${source.key}` : "New Skill";
  const subhead = source
    ? "Forking a system skill into a custom one. Tweak the steps, then save under a new key."
    : "Build a Skill the controller can run as a versioned, schema-validated procedure.";

  return (
    <div className="space-y-5">
      <Breadcrumb items={[
        { label: "Skills", href: "/skills" },
        { label: source ? "Fork" : "New" },
      ]}/>

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {source && <GitFork size={20} className="text-accent"/>}
            {headline}
          </h1>
          <p className="text-sm text-muted max-w-2xl mt-1">{subhead}</p>
        </div>
        <ModeTabs mode={mode} onChange={setMode}/>
      </header>

      {forkKey && !source && (
        <div className="card p-4 border-warning/40 bg-warning/10 text-warning text-sm">
          Source skill <span className="font-mono">{forkKey}</span> not found. Starting from a blank template.
        </div>
      )}

      {mode === "wizard" && (
        <SkillWizard
          initial={draft}
          isEdit={false}
          onSave={onSave}
          onSwitchToJSON={() => setMode("json")}
        />
      )}

      {mode === "json" && (
        <SOPEditor initial={sopDraft} isEdit={false} onSave={onJsonSave}/>
      )}

      {mode === "paste" && (
        <SkillImportCard onApply={onImport}/>
      )}
    </div>
  );
}

function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const tabs: { key: Mode; label: string; icon: typeof Wand2 }[] = [
    { key: "wizard", label: "Wizard",     icon: Wand2 },
    { key: "json",   label: "JSON",       icon: FileCode2 },
    { key: "paste",  label: "Paste",      icon: ClipboardPaste },
  ];
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden">
      {tabs.map(t => {
        const Icon = t.icon;
        const active = mode === t.key;
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
              active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
            }`}>
            <Icon size={12}/> {t.label}
          </button>
        );
      })}
    </div>
  );
}
