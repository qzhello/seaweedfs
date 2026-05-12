"use client";
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { useSkills, api } from "@/lib/api";
import Link from "next/link";
import {
  ShieldCheck, ShieldAlert, AlertTriangle, Activity, Power, Sparkles, Plus, Pencil, History, GitFork,
  Search, X,
} from "lucide-react";
import { RefreshButton } from "@/components/refresh-button";

type Stats = {
  total_7d?: number;
  succeeded_7d?: number;
  failed_7d?: number;
  success_rate?: number;
  avg_duration_ms?: number;
};

interface SkillRow {
  id: string;
  key: string;
  name: string;
  scope: "system" | "custom";
  risk_level: "low" | "medium" | "high" | "critical";
  category: string;
  version: number;
  enabled: boolean;
  definition: Record<string, unknown>;
  updated_at: string;
  updated_by: string;
  stats?: Stats;
}

const RISK_STYLES: Record<SkillRow["risk_level"], string> = {
  low:      "bg-success/10 text-success border-success/30",
  medium:   "bg-warning/10 text-warning border-warning/30",
  high:     "bg-danger/15 text-danger border-danger/40",
  critical: "bg-danger/25 text-danger border-danger/60 animate-pulse",
};

const CATEGORY_ICON: Record<string, JSX.Element> = {
  tiering:     <Sparkles size={14}/>,
  ec:          <ShieldCheck size={14}/>,
  topology:    <Activity size={14}/>,
  maintenance: <Power size={14}/>,
  recovery:    <ShieldAlert size={14}/>,
  integrity:   <AlertTriangle size={14}/>,
};

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
type RiskFilter = "" | typeof RISK_LEVELS[number];

export default function SkillsPage() {
  const { t } = useT();
  const [scope, setScope] = useState<"" | "system" | "custom">("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("");
  const [risk, setRisk] = useState<RiskFilter>("");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const { data, mutate, error, isLoading, isValidating } = useSkills(scope);
  const items: SkillRow[] = data?.items ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach(s => set.add(s.category));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(s => {
      if (category && s.category !== category) return false;
      if (risk && s.risk_level !== risk) return false;
      if (enabledOnly && !s.enabled) return false;
      if (!q) return true;
      const def = s.definition as { summary?: string; description?: string };
      return (
        s.name.toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q) ||
        (def.summary ?? "").toLowerCase().includes(q) ||
        (def.description ?? "").toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
      );
    });
  }, [items, query, category, risk, enabledOnly]);

  const grouped = filtered.reduce<Record<string, SkillRow[]>>((acc, s) => {
    (acc[s.category] ||= []).push(s);
    return acc;
  }, {});

  const activeFilters = (category ? 1 : 0) + (risk ? 1 : 0) + (enabledOnly ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight">{t("Skills")}</h1>
          <p className="text-sm text-muted">{t("Declarative op catalog — every Skill is a playbook with preconditions, steps, postchecks, and rollback.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <Link href="/skills/new" className="px-3 py-1.5 rounded-md border border-accent/40 text-accent hover:bg-accent/10 flex items-center gap-1 text-sm">
            <Plus size={14}/> {t("New SOP")}
          </Link>
        </div>
      </header>

      {/* Filter bar — single compact row */}
      <div className="card px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
        <div className="relative w-64 max-w-full">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("Search by name, key, or description…")}
            className="input w-full pl-7 pr-7 py-1 text-xs"
          />
          {query && (
            <button onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-panel2 text-muted"
              title={t("Clear")}>
              <X size={11}/>
            </button>
          )}
        </div>

        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {(["", "system", "custom"] as const).map(s => (
            <button key={s || "all"}
              className={`px-2 py-1 transition-colors ${scope === s ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"} ${s !== "custom" ? "border-r border-border/60" : ""}`}
              onClick={() => setScope(s)}>
              {s === "" ? t("All") : s === "system" ? t("System") : t("Custom")}
            </button>
          ))}
        </div>

        <select className="input py-1 text-xs w-32" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">{t("All categories")}</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="input py-1 text-xs w-28" value={risk} onChange={e => setRisk(e.target.value as RiskFilter)}>
          <option value="">{t("Any risk")}</option>
          {RISK_LEVELS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>

        <label className="flex items-center gap-1 text-muted select-none cursor-pointer hover:text-text whitespace-nowrap">
          <input type="checkbox" checked={enabledOnly} onChange={e => setEnabledOnly(e.target.checked)}/>
          {t("Enabled only")}
        </label>

        {activeFilters > 0 && (
          <button
            onClick={() => { setQuery(""); setCategory(""); setRisk(""); setEnabledOnly(false); }}
            className="text-muted hover:text-accent flex items-center gap-1 whitespace-nowrap"
          >
            <X size={11}/> {t("Reset")}
          </button>
        )}

        <span className="text-muted ml-auto tabular-nums">
          {filtered.length} / {items.length}
        </span>
      </div>

      {error && <div className="card p-4 text-danger">Error: {String(error)}</div>}

      {isLoading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card p-5 h-48 animate-pulse bg-panel2/40"/>
          ))}
        </div>
      )}

      {filtered.length === 0 && items.length > 0 && (
        <div className="card p-8 text-center text-sm text-muted">
          {t("No skills match the current filter.")}
        </div>
      )}

      {Object.entries(grouped).map(([cat, list]) => (
        <section key={cat}>
          <div className="flex items-center gap-2 mb-3 text-sm uppercase tracking-wider text-muted">
            {CATEGORY_ICON[cat] ?? <Sparkles size={14}/>}
            <span>{cat}</span>
            <span className="text-xs">({list.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {list.map(s => (
              <SkillCard key={s.id} s={s} onToggle={async () => {
                await api.toggleSkill(s.key, !s.enabled);
                mutate();
              }}/>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SkillCard({ s, onToggle }: { s: SkillRow; onToggle: () => void }) {
  const { t } = useT();
  const def = s.definition as { summary?: string; description?: string; steps?: unknown[]; rollback?: unknown[] };
  const stats = s.stats || {};
  const total = stats.total_7d ?? 0;
  const rate = stats.success_rate != null ? Math.round(stats.success_rate * 100) : null;

  return (
    <div className={`card p-5 flex flex-col gap-3 ${!s.enabled ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/skills/${encodeURIComponent(s.key)}`} className="min-w-0 flex-1 group">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${RISK_STYLES[s.risk_level]}`}>
              {s.risk_level}
            </span>
            <span className="text-xs text-muted">v{s.version}</span>
            <span className="text-xs text-muted">{s.scope}</span>
          </div>
          <div className="font-semibold truncate group-hover:text-accent">{s.name}</div>
          <div className="text-xs text-muted font-mono truncate">{s.key}</div>
        </Link>
        <button onClick={onToggle}
          title={s.enabled ? t("Disable") : t("Enable")}
          className={`shrink-0 p-1.5 rounded-md border ${s.enabled ? "border-success/40 text-success hover:bg-success/10" : "border-muted/40 text-muted hover:bg-panel2"}`}>
          <Power size={16}/>
        </button>
      </div>

      <Link href={`/skills/${encodeURIComponent(s.key)}`} className="block hover:text-text">
        <p className="text-sm text-muted line-clamp-2">{def.summary}</p>
      </Link>

      <div className="flex items-center gap-4 text-xs">
        <span>steps <span className="text-text">{def.steps?.length ?? 0}</span></span>
        {!!def.rollback?.length && <span>rollback <span className="text-text">{def.rollback.length}</span></span>}
        <span className="ml-auto text-muted">{new Date(s.updated_at).toLocaleDateString("zh-CN")}</span>
      </div>

      {total > 0 ? (
        <div className="flex items-center gap-3 text-xs border-t border-border pt-3">
          <SuccessBar rate={rate ?? 0}/>
          <span className="text-muted">{stats.succeeded_7d}/{total} · 7d</span>
          {stats.avg_duration_ms != null && (
            <span className="text-muted ml-auto">avg {Math.round(stats.avg_duration_ms / 1000)}s</span>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted border-t border-border pt-3">No runs in last 7 days.</div>
      )}

      <div className="flex items-center gap-3 text-xs">
        <Link href={`/skills/${encodeURIComponent(s.key)}`} className="flex items-center gap-1 text-accent hover:underline">
          {t("Details")} →
        </Link>
        <span className="text-muted">|</span>
        {s.scope === "custom" ? (
          <Link href={`/skills/${encodeURIComponent(s.key)}/edit`}
            className="flex items-center gap-1 text-muted hover:text-accent">
            <Pencil size={12}/> {t("Edit")}
          </Link>
        ) : (
          <Link href={`/skills/new?fork=${encodeURIComponent(s.key)}`}
            className="flex items-center gap-1 text-muted hover:text-accent"
            title="Copy this system skill into a custom skill you can edit">
            <GitFork size={12}/> {t("Fork")}
          </Link>
        )}
        <Link href={`/skills/${encodeURIComponent(s.key)}/history`}
          className="flex items-center gap-1 text-muted hover:text-accent">
          <History size={12}/> {t("History")}
        </Link>
      </div>
    </div>
  );
}

function SuccessBar({ rate }: { rate: number }) {
  const tone = rate >= 95 ? "bg-success" : rate >= 80 ? "bg-warning" : "bg-danger";
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <div className="h-1.5 rounded-full bg-panel2 flex-1 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${rate}%` }}/>
      </div>
      <span className="text-xs tabular-nums">{rate}%</span>
    </div>
  );
}
