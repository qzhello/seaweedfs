"use client";
// Skill detail view — full definition (preconditions, steps, rollback,
// postchecks) rendered so operators can audit what a SOP actually does
// without diving into JSON.
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSkills } from "@/lib/api";
import { explainOp, substituteCommand } from "@/lib/op-catalog";
import {
  ShieldCheck, ShieldAlert, AlertTriangle, ArrowLeft, Pencil, History, Power, GitFork,
} from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";

interface Step { id?: string; op: string; timeout_seconds?: number; on_failure?: string; retry?: { max_attempts: number; backoff_seconds: number }; args?: Record<string, unknown> }
interface Check { check: string; fatal?: boolean; doc?: string }
interface Definition {
  summary?: string;
  description?: string;
  params?: { name: string; type: string; required?: boolean; doc?: string; default?: unknown }[];
  preconditions?: Check[];
  steps?: Step[];
  rollback?: Step[];
  postchecks?: Check[];
}

const RISK_STYLES: Record<string, string> = {
  low:      "bg-success/10 text-success border-success/30",
  medium:   "bg-warning/10 text-warning border-warning/30",
  high:     "bg-danger/15 text-danger border-danger/40",
  critical: "bg-danger/25 text-danger border-danger/60 animate-pulse",
};

export default function SkillDetail() {
  const { key } = useParams<{ key: string }>();
  const decoded = decodeURIComponent(key);
  const { data } = useSkills("");
  const skill = (data?.items ?? []).find((s: { key: string }) => s.key === decoded);

  if (!data) return <div className="text-muted">Loading…</div>;
  if (!skill) {
    return (
      <div className="space-y-4">
        <Link href="/skills" className="inline-flex items-center gap-1 text-muted hover:text-text text-sm">
          <ArrowLeft size={14}/> Skills
        </Link>
        <div className="card p-5 text-danger">Skill not found: {decoded}</div>
      </div>
    );
  }

  const def = skill.definition as Definition;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Skills", href: "/skills" }, { label: decoded }]}/>

      <header className="card p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${RISK_STYLES[skill.risk_level] || ""}`}>
                {skill.risk_level}
              </span>
              <span className="text-xs text-muted">v{skill.version}</span>
              <span className="text-xs text-muted">{skill.scope}</span>
              <span className="text-xs text-muted">· {skill.category}</span>
              {!skill.enabled && (
                <span className="text-xs text-warning border border-warning/40 px-1.5 rounded">DISABLED</span>
              )}
            </div>
            <h1 className="text-base font-semibold tracking-tight">{skill.name}</h1>
            <div className="text-sm text-muted font-mono">{skill.key}</div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Link href={`/skills/${encodeURIComponent(skill.key)}/history`}
              className="px-3 py-1.5 rounded-md border border-border hover:bg-panel2 inline-flex items-center gap-1">
              <History size={14}/> Version history
            </Link>
            {skill.scope === "custom" ? (
              <Link href={`/skills/${encodeURIComponent(skill.key)}/edit`}
                className="px-3 py-1.5 rounded-md border border-accent/40 text-accent hover:bg-accent/10 inline-flex items-center gap-1">
                <Pencil size={14}/> Edit
              </Link>
            ) : (
              <Link href={`/skills/new?fork=${encodeURIComponent(skill.key)}`}
                className="px-3 py-1.5 rounded-md border border-accent/40 text-accent hover:bg-accent/10 inline-flex items-center gap-1"
                title="Fork this system skill into a custom skill you can edit">
                <GitFork size={14}/> Fork to custom
              </Link>
            )}
          </div>
        </div>
        {def.summary && <p className="text-sm">{def.summary}</p>}
        {def.description && <p className="text-sm text-muted whitespace-pre-line">{def.description}</p>}
      </header>

      {(def.params?.length ?? 0) > 0 && (
        <section className="card p-5">
          <h2 className="text-base font-medium mb-3 flex items-center gap-2">
            <Power size={16}/> Parameters
          </h2>
          <div className="space-y-1 text-sm">
            {def.params!.map(p => (
              <div key={p.name} className="flex items-start gap-3 py-1 border-b border-border last:border-0">
                <div className="font-mono text-text w-40 shrink-0">{p.name}</div>
                <div className="w-20 shrink-0 text-muted text-xs">{p.type}{p.required && <span className="text-danger ml-1">*</span>}</div>
                {p.default !== undefined && (
                  <div className="text-xs text-muted font-mono">default: {JSON.stringify(p.default)}</div>
                )}
                {p.doc && <div className="text-xs text-muted flex-1">{p.doc}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {(def.preconditions?.length ?? 0) > 0 && (
        <SectionChecks title="Preconditions" icon={<ShieldCheck size={16} className="text-success"/>}
          items={def.preconditions!}/>
      )}

      {(def.steps?.length ?? 0) > 0 && (
        <SectionSteps title="Steps" steps={def.steps!}/>
      )}

      {(def.rollback?.length ?? 0) > 0 && (
        <SectionSteps title="Rollback" steps={def.rollback!} tone="rollback"/>
      )}

      {(def.postchecks?.length ?? 0) > 0 && (
        <SectionChecks title="Postchecks" icon={<AlertTriangle size={16} className="text-warning"/>}
          items={def.postchecks!}/>
      )}

      <details className="card p-5">
        <summary className="text-sm font-medium cursor-pointer">Raw JSON</summary>
        <pre className="font-mono text-xs whitespace-pre-wrap bg-bg p-3 rounded border border-border max-h-[600px] overflow-auto mt-3">
{JSON.stringify(def, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function SectionChecks({ title, icon, items }: { title: string; icon: React.ReactNode; items: Check[] }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-medium mb-3 flex items-center gap-2">{icon} {title}</h2>
      <ol className="space-y-2 text-sm">
        {items.map((c, i) => {
          const ex = explainOp(c.check);
          return (
            <li key={i} className="flex items-start gap-3 border-l-2 border-border pl-3 py-1">
              <div className="font-mono text-xs text-muted w-6 text-right shrink-0">{i + 1}.</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{ex.title}</span>
                  {c.fatal && <span className="badge border-danger/40 text-danger text-[11px]">fatal</span>}
                  <span className="text-xs text-muted font-mono">/{c.check}</span>
                </div>
                <div className="text-muted text-xs mt-0.5">{c.doc || ex.description}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SectionSteps({ title, steps, tone }: { title: string; steps: Step[]; tone?: "rollback" }) {
  const borderColor = tone === "rollback" ? "border-warning/40" : "border-border";
  return (
    <section className="card p-5">
      <h2 className="text-base font-medium mb-3">{title}</h2>
      <ol className="space-y-3 text-sm">
        {steps.map((s, i) => {
          const ex = explainOp(s.op);
          const cmd = substituteCommand(ex.command, {});
          return (
            <li key={i} className={`border-l-2 ${borderColor} pl-3 py-1`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-muted">{i + 1}.</span>
                <span className="font-medium">{s.id || ex.title}</span>
                {ex.external
                  ? <span className="badge border-accent/40 text-accent text-[11px]">SeaweedFS</span>
                  : <span className="badge text-[11px]">internal</span>}
                <span className="text-xs text-muted font-mono">/{s.op}</span>
                {s.timeout_seconds && (
                  <span className="text-xs text-muted">timeout {fmtSeconds(s.timeout_seconds)}</span>
                )}
                {s.on_failure && (
                  <span className="text-xs text-muted">on_failure: <span className="text-text">{s.on_failure}</span></span>
                )}
                {s.retry && (
                  <span className="text-xs text-muted">retry: {s.retry.max_attempts}× / {s.retry.backoff_seconds}s</span>
                )}
              </div>
              <div className="text-muted text-xs mt-1">{ex.description}</div>
              <pre className="font-mono text-[11px] mt-1 px-2 py-1 bg-bg border border-border rounded overflow-x-auto whitespace-pre-wrap">$ {cmd}</pre>
              {s.args && Object.keys(s.args).length > 0 && (
                <div className="text-[11px] text-muted mt-1 font-mono">args: {JSON.stringify(s.args)}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
