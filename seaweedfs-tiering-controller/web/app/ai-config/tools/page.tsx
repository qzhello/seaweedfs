"use client";

// AI assistant tool authorization — operators decide which of the
// assistant's tools the LLM is allowed to call autonomously. Tools
// where ai_allowed=false never appear in the model's tool spec, so it
// physically cannot pick them. Read tools default ON; write and
// destructive tools default OFF and require explicit opt-in here.

import { useState } from "react";
import useSWR, { mutate as swrMutate } from "swr";
import Link from "next/link";
import {
  ShieldCheck, Wrench, AlertTriangle, Loader2, ArrowLeft, Save, CheckCircle2,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { ErrorPanel } from "@/components/error-panel";

interface ToolPolicy {
  tool_name: string;
  description: string;
  risk_level: "read" | "write" | "destructive";
  ai_allowed: boolean;
  note: string;
  updated_by?: string;
  orphan?: boolean;
}

const BASE = "/api/v1";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const t = window.localStorage.getItem("tier.token");
    if (t) h["Authorization"] = `Bearer ${t}`;
  }
  return h;
}

async function fetcher(url: string) {
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export default function AIToolPoliciesPage() {
  const { t } = useT();
  const { data, error, isLoading } = useSWR<{ items: ToolPolicy[] }>(
    `${BASE}/ai/tool-policies`, fetcher);
  const [savingTool, setSavingTool] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState<string | null>(null);

  const items = data?.items ?? [];

  // Group by risk so the dangerous toggles never hide under "read".
  const grouped = {
    read: items.filter(p => p.risk_level === "read" && !p.orphan),
    write: items.filter(p => p.risk_level === "write" && !p.orphan),
    destructive: items.filter(p => p.risk_level === "destructive" && !p.orphan),
    orphans: items.filter(p => p.orphan),
  };

  const upsert = async (row: ToolPolicy, patch: Partial<ToolPolicy>) => {
    setErr(null);
    setSavingTool(row.tool_name);
    try {
      const r = await fetch(`${BASE}/ai/tool-policies`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          tool_name: row.tool_name,
          ai_allowed: patch.ai_allowed ?? row.ai_allowed,
          note: patch.note ?? row.note,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `${r.status}`);
      }
      await swrMutate(`${BASE}/ai/tool-policies`);
      setOkFlash(row.tool_name);
      setTimeout(() => setOkFlash(p => p === row.tool_name ? null : p), 1200);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingTool(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-muted">
            <Link href="/ai-config" className="inline-flex items-center gap-1 hover:underline">
              <ArrowLeft size={11}/> {t("Back to AI config")}
            </Link>
          </div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2 mt-1">
            <ShieldCheck size={16}/> {t("Assistant tool authorization")}
          </h1>
          <p className="text-xs text-muted max-w-2xl mt-1">
            {t("Each row is a tool the floating AI assistant could call. Flip the switch to control whether the AI is allowed to invoke it autonomously. Tools that are off never appear in the model's tool spec — it physically cannot choose them. Operators can still invoke any tool directly through the controller UI; this gate is only for AI.")}
          </p>
        </div>
      </header>

      {err && <ErrorPanel error={err}/>}

      {isLoading && !data && (
        <div className="card p-6 text-sm text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin"/> {t("Loading…")}
        </div>
      )}
      {error && <div className="card p-4 text-danger text-xs">{String(error)}</div>}

      <Section
        title={t("Read tools — safe, default on")}
        subtitle={t("Query-only tools. The assistant uses these to look up cluster state and SOPs.")}
        rows={grouped.read}
        savingTool={savingTool}
        okFlash={okFlash}
        onToggle={(r, v) => upsert(r, { ai_allowed: v })}
        tone="ok"
      />
      <Section
        title={t("Write tools — reversible, default off")}
        subtitle={t("Mutating tools that change platform state but can be rolled back. Turn on only if you trust the assistant to manage these.")}
        rows={grouped.write}
        savingTool={savingTool}
        okFlash={okFlash}
        onToggle={(r, v) => upsert(r, { ai_allowed: v })}
        tone="warn"
      />
      <Section
        title={t("Destructive tools — irreversible, default off")}
        subtitle={t("Tools whose effects cannot be undone (deletes, decode, etc). Strongly recommended to keep off and only invoke from the controller UI with explicit confirmation.")}
        rows={grouped.destructive}
        savingTool={savingTool}
        okFlash={okFlash}
        onToggle={(r, v) => upsert(r, { ai_allowed: v })}
        tone="err"
      />
      {grouped.orphans.length > 0 && (
        <Section
          title={t("Orphaned policies")}
          subtitle={t("These tools exist in the database but the running binary no longer registers them. Safe to ignore — they are not exposed to the assistant. Clean them up after a deploy when you're sure they're gone for good.")}
          rows={grouped.orphans}
          savingTool={savingTool}
          okFlash={okFlash}
          onToggle={() => Promise.resolve()}
          tone="muted"
          readOnly
        />
      )}
    </div>
  );
}

function Section({ title, subtitle, rows, savingTool, okFlash, onToggle, tone, readOnly }: {
  title: string;
  subtitle: string;
  rows: ToolPolicy[];
  savingTool: string | null;
  okFlash: string | null;
  onToggle: (r: ToolPolicy, v: boolean) => Promise<void>;
  tone: "ok" | "warn" | "err" | "muted";
  readOnly?: boolean;
}) {
  if (rows.length === 0) return null;
  const toneColor = {
    ok:    "border-success/40",
    warn:  "border-warning/40",
    err:   "border-danger/40",
    muted: "border-border",
  }[tone];
  return (
    <section className={`card border ${toneColor}`}>
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted mt-0.5">{subtitle}</p>
      </div>
      <div className="divide-y divide-border">
        {rows.map(r => (
          <PolicyRow
            key={r.tool_name}
            row={r}
            saving={savingTool === r.tool_name}
            flash={okFlash === r.tool_name}
            onToggle={onToggle}
            readOnly={readOnly}
          />
        ))}
      </div>
    </section>
  );
}

function PolicyRow({ row, saving, flash, onToggle, readOnly }: {
  row: ToolPolicy;
  saving: boolean;
  flash: boolean;
  onToggle: (r: ToolPolicy, v: boolean) => Promise<void>;
  readOnly?: boolean;
}) {
  const { t } = useT();
  const Icon = row.risk_level === "destructive" ? AlertTriangle : Wrench;
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-mono inline-flex items-center gap-1.5">
          <Icon size={11}/> {row.tool_name}
          <span className={`badge text-[10px] py-0 ${
            row.risk_level === "read"  ? "border-success/40 text-success" :
            row.risk_level === "write" ? "border-warning/40 text-warning" :
                                          "border-danger/40 text-danger"
          }`}>
            {row.risk_level}
          </span>
          {row.orphan && (
            <span className="badge text-[10px] py-0 border-muted/40 text-muted">{t("orphan")}</span>
          )}
        </div>
        {row.description && (
          <div className="text-xs text-muted mt-1">{row.description}</div>
        )}
        {row.note && (
          <div className="text-[11px] text-muted mt-1 italic">{row.note}</div>
        )}
        {row.updated_by && (
          <div className="text-[10px] text-muted/60 mt-1">{t("Last toggled by")}: {row.updated_by}</div>
        )}
      </div>
      <label className="inline-flex items-center gap-2 shrink-0 cursor-pointer select-none">
        <span className="text-xs text-muted">
          {row.ai_allowed ? t("AI allowed") : t("AI blocked")}
        </span>
        <input
          type="checkbox"
          className="accent-accent"
          disabled={saving || readOnly}
          checked={row.ai_allowed}
          onChange={e => onToggle(row, e.target.checked)}
        />
        {saving && <Loader2 size={11} className="animate-spin text-muted"/>}
        {flash && <CheckCircle2 size={11} className="text-success"/>}
      </label>
    </div>
  );
}
