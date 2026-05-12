"use client";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { History, GitFork, AlertTriangle, Wand2, FileCode2 } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { SOPEditor, type SOPDraft } from "@/components/sop-editor";
import {
  SkillWizard, type WizardDraft, type SkillDefinition, type RiskLevel,
} from "@/components/skill-wizard";
import { api, useSkills } from "@/lib/api";
import Link from "next/link";

interface SkillRow {
  key: string;
  name: string;
  scope: "system" | "custom";
  risk_level: RiskLevel;
  category: string;
  version: number;
  definition: object;
}

type Mode = "wizard" | "json";

export default function EditSkillPage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const { data, error } = useSkills();
  const items: SkillRow[] = data?.items ?? [];
  const skill = items.find(s => s.key === decodeURIComponent(key));
  const [mode, setMode] = useState<Mode>("wizard");

  const initialWizard: WizardDraft | null = useMemo(() => {
    if (!skill) return null;
    return {
      meta: {
        key: skill.key,
        name: skill.name,
        category: skill.category,
        risk_level: skill.risk_level,
        change_note: "",
      },
      definition: skill.definition as SkillDefinition,
    };
  }, [skill]);

  if (error) return <div className="card p-5 text-danger">Failed to load skills.</div>;
  if (!data) return <div className="card p-5 text-muted">Loading…</div>;
  if (!skill || !initialWizard) {
    return <div className="card p-5">Skill <span className="font-mono">{key}</span> not found.</div>;
  }

  // System skills are read-only here. Surface the Fork CTA so the operator
  // doesn't hit a dead end.
  if (skill.scope === "system") {
    return (
      <div className="space-y-4">
        <Breadcrumb items={[
          { label: "Skills", href: "/skills" },
          { label: skill.key, href: `/skills/${encodeURIComponent(skill.key)}` },
          { label: "Edit" },
        ]}/>
        <div className="card p-5 space-y-3">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle size={16}/>
            <span className="font-medium">This is a system skill</span>
          </div>
          <p className="text-sm text-muted">
            <span className="font-mono text-text">{skill.key}</span> ships with the controller and
            cannot be modified in place. Fork it into a custom skill — your forked copy is
            fully editable and runs in place of the system one if the engine resolves your
            custom key first.
          </p>
          <div className="pt-1">
            <Link href={`/skills/new?fork=${encodeURIComponent(skill.key)}`}
              className="btn btn-primary inline-flex items-center gap-1">
              <GitFork size={14}/> Fork to custom
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const onSaveWizard = async (d: WizardDraft) => {
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

  const sopDraft: SOPDraft = {
    key:         initialWizard.meta.key,
    name:        initialWizard.meta.name,
    category:    initialWizard.meta.category,
    risk_level:  initialWizard.meta.risk_level,
    change_note: initialWizard.meta.change_note,
    definition:  JSON.stringify(initialWizard.definition, null, 2),
  };
  const onSaveJson = async (sd: SOPDraft) => {
    await api.upsertSkill({
      key: sd.key, name: sd.name, category: sd.category, risk_level: sd.risk_level,
      definition: JSON.parse(sd.definition), change_note: sd.change_note,
    });
    router.push(`/skills/${encodeURIComponent(sd.key)}`);
  };

  return (
    <div className="space-y-5">
      <Breadcrumb items={[
        { label: "Skills", href: "/skills" },
        { label: skill.key, href: `/skills/${encodeURIComponent(skill.key)}` },
        { label: "Edit" },
      ]}/>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight">
            Edit <span className="font-mono text-base text-accent">{skill.key}</span>
            <span className="text-muted ml-2 text-base">v{skill.version} → v{skill.version + 1}</span>
          </h1>
          <p className="text-sm text-muted mt-1">
            Saving creates a new version. The latest version is what runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button onClick={() => setMode("wizard")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
                mode === "wizard" ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
              }`}>
              <Wand2 size={12}/> Wizard
            </button>
            <button onClick={() => setMode("json")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
                mode === "json" ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
              }`}>
              <FileCode2 size={12}/> JSON
            </button>
          </div>
          <Link href={`/skills/${encodeURIComponent(skill.key)}/history`} className="btn">
            <History size={14}/> Version history
          </Link>
        </div>
      </header>

      {mode === "wizard" ? (
        <SkillWizard initial={initialWizard} isEdit={true} onSave={onSaveWizard}
          onSwitchToJSON={() => setMode("json")}/>
      ) : (
        <SOPEditor initial={sopDraft} isEdit={true} onSave={onSaveJson}/>
      )}
    </div>
  );
}
