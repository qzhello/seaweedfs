"use client";

// AI token usage panel. Reads pre-aggregated rollups from
// /admin/ai/usage and renders three slices the operator can use
// to answer "what is AI costing me, where, and for whom":
//
//   - A daily-totals chart (input + output tokens stacked per day)
//   - A by-(provider, model) breakdown table with calls / tokens /
//     error rate / avg latency
//   - A top-N users table sorted by call volume
//
// Every number comes from the server; nothing here computes
// aggregates or projections. If the rollup is empty (fresh install
// or AI never invoked), the panel renders a friendly empty state
// rather than a wall of zeros.

import { useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Cpu, Users, Clock, Coins, Brain,
  DollarSign, Trash2, Plus, X, Target, ShieldAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import {
  useAIUsage, useAIPricing, upsertAIPricing, deleteAIPricing,
  useAIBudgets, upsertAIBudget, deleteAIBudget, evaluateAIBudgets,
} from "@/lib/api";
import type {
  AIUsageDailyRow, AIUsageModelTotal, AIUsageTopUser, AIModelPricing,
  AIBudgetState, AIBudget,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

type WindowDays = 7 | 30 | 90;

export function AIUsagePanel() {
  const { t } = useT();
  const [days, setDays] = useState<WindowDays>(7);
  const [showEditor, setShowEditor] = useState(false);
  const { data, error, isLoading, mutate } = useAIUsage(days);

  const totals = useMemo(() => {
    if (!data) return null;
    return data.by_model.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        errors: acc.errors + r.errors,
        input: acc.input + r.input_tokens,
        output: acc.output + r.output_tokens,
      }),
      { calls: 0, errors: 0, input: 0, output: 0 },
    );
  }, [data]);

  if (error) {
    return (
      <div className="card p-4 border-danger/40 bg-danger/10 text-xs text-danger">
        {t("Failed to load AI usage")}: {String((error as Error).message ?? error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="card p-6 text-sm text-muted">{t("Loading…")}</div>;
  }

  const hasAnyData = data.by_model.length > 0;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
            <Brain size={16}/> {t("AI token usage")}
          </h2>
          <p className="text-xs text-muted">
            {t("Per-call accounting captured from provider responses. Zero tokens means the vendor did not report.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            {([7, 30, 90] as WindowDays[]).map((d, i) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 transition-colors ${i > 0 ? "border-l border-border" : ""} ${
                  days === d ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowEditor(v => !v)}
            className="btn inline-flex items-center gap-1 text-xs"
            title={t("Edit per-model token prices")}
          >
            <DollarSign size={11}/> {t("Pricing")}
          </button>
        </div>
      </header>

      {showEditor && (
        <PricingEditor
          currency={data?.currency ?? "USD"}
          onClose={() => setShowEditor(false)}
          onChange={() => mutate()}
        />
      )}

      {!hasAnyData ? (
        <EmptyState
          icon={Brain}
          title={t("No AI activity yet")}
          hint={t("Token rows are recorded automatically on every Chat / JSONChat call. Use the floating assistant or any AI-backed action to populate this view.")}
        />
      ) : (
        <>
          {totals && (
            <SummaryTiles
              totals={totals}
              models={data.by_model.length}
              cost={data.total_cost}
              currency={data.currency}
              unpriced={data.unpriced_models}
            />
          )}
          <BudgetsSection currency={data.currency} />
          <DailyChart rows={data.by_day} />
          <ModelTable rows={data.by_model} currency={data.currency} />
          {data.top_users.length > 0 && <TopUsersTable rows={data.top_users} currency={data.currency} />}
        </>
      )}
    </div>
  );
}

function SummaryTiles({
  totals,
  models,
  cost,
  currency,
  unpriced,
}: {
  totals: { calls: number; errors: number; input: number; output: number };
  models: number;
  cost: number;
  currency: string;
  unpriced: number;
}) {
  const { t } = useT();
  const errRate = totals.calls > 0 ? (totals.errors / totals.calls) * 100 : 0;
  const costHint = unpriced > 0
    ? `${unpriced} ${t("unpriced models")}`
    : t("all models priced");
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Tile icon={Activity} label={t("Calls")} value={totals.calls.toLocaleString()} hint={`${models} ${t("models")}`} />
      <Tile
        icon={AlertTriangle}
        label={t("Error rate")}
        value={`${errRate.toFixed(1)}%`}
        hint={`${totals.errors.toLocaleString()} ${t("failed")}`}
        tone={errRate > 5 ? "danger" : errRate > 1 ? "warning" : "ok"}
      />
      <Tile icon={Coins} label={t("Input tokens")} value={fmtCompact(totals.input)} />
      <Tile icon={Coins} label={t("Output tokens")} value={fmtCompact(totals.output)} />
      <Tile
        icon={DollarSign}
        label={t("Estimated cost")}
        value={fmtCurrency(cost, currency)}
        hint={costHint}
        tone={unpriced > 0 ? "warning" : undefined}
      />
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warning" | "danger";
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "ok" ? "text-success" : "";
  return (
    <div className="card p-3">
      <div className="text-[11px] text-muted inline-flex items-center gap-1">
        <Icon size={11}/> {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

// DailyChart renders a stacked bar chart of input + output tokens
// per day. Pure CSS / divs — no chart library. The y-axis is the
// max of all bar totals across the window; if all bars are zero we
// skip rendering since the chart would carry no signal.
function DailyChart({ rows }: { rows: AIUsageDailyRow[] }) {
  const { t } = useT();
  const days = useMemo(() => {
    const byDay = new Map<string, { input: number; output: number; calls: number }>();
    for (const r of rows) {
      const key = r.day.slice(0, 10);
      const prev = byDay.get(key) ?? { input: 0, output: 0, calls: 0 };
      byDay.set(key, {
        input: prev.input + r.input_tokens,
        output: prev.output + r.output_tokens,
        calls: prev.calls + r.calls,
      });
    }
    return [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v, total: v.input + v.output }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [rows]);

  const max = Math.max(1, ...days.map(d => d.total));
  if (days.length === 0 || max <= 1) {
    return null;
  }

  return (
    <section className="card p-3">
      <header className="text-xs font-semibold mb-2 inline-flex items-center gap-1.5">
        <Activity size={12}/> {t("Daily tokens (input + output)")}
      </header>
      <div className="flex items-end gap-1 h-32">
        {days.map(d => {
          const totalPct = (d.total / max) * 100;
          const inputPct = d.total > 0 ? (d.input / d.total) * 100 : 0;
          return (
            <div
              key={d.day}
              className="flex-1 flex flex-col justify-end relative group min-w-0"
              title={`${d.day}\n${t("Calls")}: ${d.calls}\n${t("Input")}: ${d.input.toLocaleString()}\n${t("Output")}: ${d.output.toLocaleString()}`}
            >
              <div
                className="flex flex-col justify-end overflow-hidden rounded-sm"
                style={{ height: `${totalPct}%` }}
              >
                <div className="bg-accent/70" style={{ height: `${inputPct}%` }} />
                <div className="bg-accent/40 flex-1" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted mt-1">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted mt-1">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 bg-accent/70 rounded-sm"/> {t("input")}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 bg-accent/40 rounded-sm"/> {t("output")}</span>
      </div>
    </section>
  );
}

function ModelTable({ rows, currency }: { rows: AIUsageModelTotal[]; currency: string }) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold inline-flex items-center gap-2">
        <Cpu size={13}/> {t("By provider × model")}
      </header>
      <div className="overflow-x-auto">
        <table className="grid w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">{t("Provider")}</th>
              <th className="text-left">{t("Model")}</th>
              <th className="num">{t("Calls")}</th>
              <th className="num">{t("Errors")}</th>
              <th className="num">{t("Input")}</th>
              <th className="num">{t("Output")}</th>
              <th className="num">{t("Cost")}</th>
              <th className="num">{t("Avg latency")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const errPct = r.calls > 0 ? (r.errors / r.calls) * 100 : 0;
              return (
                <tr key={`${r.provider}/${r.model}`}>
                  <td className="font-mono text-[11px]">{r.provider}</td>
                  <td className="font-mono text-[11px]">{r.model}</td>
                  <td className="num tabular-nums">{r.calls.toLocaleString()}</td>
                  <td
                    className={`num tabular-nums ${errPct > 5 ? "text-danger" : errPct > 1 ? "text-warning" : "text-muted"}`}
                    title={`${errPct.toFixed(1)}%`}
                  >
                    {r.errors}
                  </td>
                  <td className="num tabular-nums">{fmtCompact(r.input_tokens)}</td>
                  <td className="num tabular-nums">{fmtCompact(r.output_tokens)}</td>
                  <td
                    className={`num tabular-nums ${r.priced ? "" : "text-muted"}`}
                    title={r.priced ? undefined : t("No pricing row for this model — add one to see cost.")}
                  >
                    {r.priced ? fmtCurrency(r.estimated_cost, currency) : "—"}
                  </td>
                  <td className="num tabular-nums text-muted inline-flex items-center gap-1 justify-end">
                    <Clock size={10}/>{r.avg_latency_ms}ms
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopUsersTable({ rows, currency }: { rows: AIUsageTopUser[]; currency: string }) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold inline-flex items-center gap-2">
        <Users size={13}/> {t("Top users")}
        <span className="font-normal text-muted text-[11px]">
          — {t("cost approximated via fleet-average per-token rate")}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="grid w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">{t("User")}</th>
              <th className="num">{t("Calls")}</th>
              <th className="num">{t("Input")}</th>
              <th className="num">{t("Output")}</th>
              <th className="num">{t("Est. cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.user_id}>
                <td className="font-mono text-[11px]">{r.username}</td>
                <td className="num tabular-nums">{r.calls.toLocaleString()}</td>
                <td className="num tabular-nums">{fmtCompact(r.input_tokens)}</td>
                <td className="num tabular-nums">{fmtCompact(r.output_tokens)}</td>
                <td className="num tabular-nums">{fmtCurrency(r.estimated_cost, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// PricingEditor is a small inline manager for ai_model_pricing.
// Surfacing it inside the AI Usage panel keeps "see cost / change
// cost" in one mental hop without spawning yet another nav entry.
function PricingEditor({
  currency,
  onClose,
  onChange,
}: {
  currency: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const { t } = useT();
  const { data, mutate, isLoading } = useAIPricing();
  const [draft, setDraft] = useState<Omit<AIModelPricing, "id" | "updated_at">>({
    provider: "",
    model: "",
    input_price_per_1m_tokens: 0,
    output_price_per_1m_tokens: 0,
    currency,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    if (!draft.provider.trim() || !draft.model.trim()) {
      setErr(t("Provider and model are required"));
      return;
    }
    if (draft.input_price_per_1m_tokens < 0 || draft.output_price_per_1m_tokens < 0) {
      setErr(t("Prices must be >= 0"));
      return;
    }
    setSaving(true);
    try {
      await upsertAIPricing(draft);
      await mutate();
      onChange();
      setDraft({
        provider: "",
        model: "",
        input_price_per_1m_tokens: 0,
        output_price_per_1m_tokens: 0,
        currency,
        notes: "",
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: AIModelPricing) => {
    if (!confirm(`${t("Delete pricing for")} ${p.provider}/${p.model}?`)) return;
    try {
      await deleteAIPricing(p.provider, p.model);
      await mutate();
      onChange();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold inline-flex items-center gap-2 justify-between">
        <span className="inline-flex items-center gap-2">
          <DollarSign size={13}/> {t("Model pricing")}
          <span className="font-normal text-muted">— {t("per 1M tokens")}</span>
        </span>
        <button onClick={onClose} className="text-muted hover:text-text" aria-label={t("Close")}>
          <X size={13}/>
        </button>
      </header>

      {err && (
        <div className="px-3 py-2 text-xs text-danger bg-danger/10 border-b border-danger/30">{err}</div>
      )}

      <div className="overflow-x-auto">
        <table className="grid w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">{t("Provider")}</th>
              <th className="text-left">{t("Model")}</th>
              <th className="num">{t("Input")}</th>
              <th className="num">{t("Output")}</th>
              <th className="text-left">{t("Currency")}</th>
              <th className="text-left">{t("Notes")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map(r => (
              <tr key={r.id}>
                <td className="font-mono text-[11px]">{r.provider}</td>
                <td className="font-mono text-[11px]">{r.model}</td>
                <td className="num tabular-nums">{r.input_price_per_1m_tokens.toFixed(2)}</td>
                <td className="num tabular-nums">{r.output_price_per_1m_tokens.toFixed(2)}</td>
                <td className="text-[11px]">{r.currency}</td>
                <td className="text-[11px] text-muted">{r.notes || "—"}</td>
                <td className="text-right">
                  <button
                    type="button"
                    onClick={() => remove(r)}
                    className="text-muted hover:text-danger"
                    title={t("Delete")}
                  >
                    <Trash2 size={11}/>
                  </button>
                </td>
              </tr>
            ))}
            <tr className="bg-panel2/40">
              <td>
                <input
                  className="input w-24 text-[11px]"
                  placeholder="openai"
                  value={draft.provider}
                  onChange={e => setDraft({ ...draft, provider: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-40 text-[11px]"
                  placeholder="gpt-4o-mini"
                  value={draft.model}
                  onChange={e => setDraft({ ...draft, model: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-20 text-[11px] text-right"
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.input_price_per_1m_tokens}
                  onChange={e =>
                    setDraft({ ...draft, input_price_per_1m_tokens: Number(e.target.value) })
                  }
                />
              </td>
              <td>
                <input
                  className="input w-20 text-[11px] text-right"
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.output_price_per_1m_tokens}
                  onChange={e =>
                    setDraft({ ...draft, output_price_per_1m_tokens: Number(e.target.value) })
                  }
                />
              </td>
              <td>
                <input
                  className="input w-16 text-[11px]"
                  value={draft.currency}
                  onChange={e => setDraft({ ...draft, currency: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-32 text-[11px]"
                  value={draft.notes}
                  onChange={e => setDraft({ ...draft, notes: e.target.value })}
                />
              </td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || isLoading}
                  className="btn text-accent border-accent/40 hover:bg-accent/10 inline-flex items-center gap-1"
                  title={t("Add or update this pricing row")}
                >
                  <Plus size={11}/> {t("Save")}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// fmtCompact renders large counts as 1.2k / 3.4M so the table
// columns stay readable. Exact value is in the tooltip / source row.
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

// fmtCurrency formats spend with the operator's chosen currency
// label. We don't rely on Intl.NumberFormat's currency mode because
// the editor accepts free-form currency codes ("CNY", "JPY", or
// even non-ISO labels like "credit") — we just prefix the code.
function fmtCurrency(n: number, currency: string): string {
  if (n < 0.005 && n > -0.005) return `${currency} 0.00`;
  if (Math.abs(n) >= 1_000) return `${currency} ${n.toFixed(0)}`;
  return `${currency} ${n.toFixed(2)}`;
}

// ----- Budgets -----

// BudgetsSection is the at-a-glance card row plus an inline editor
// for monthly spend caps. Breaches surface as a banner above the
// per-budget bars — operators see "AI Usage is over budget" without
// having to scroll a settings page.
function BudgetsSection({ currency }: { currency: string }) {
  const { t } = useT();
  const { data, mutate, isLoading } = useAIBudgets();
  const [showEditor, setShowEditor] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evalErr, setEvalErr] = useState<string | null>(null);

  const states = data?.rows ?? [];
  const breached = states.filter(s => s.tier !== "ok");

  const runEvaluate = async () => {
    setEvaluating(true);
    setEvalErr(null);
    try {
      await evaluateAIBudgets();
      await mutate();
    } catch (e) {
      setEvalErr(String((e as Error).message ?? e));
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2">
          <Target size={13}/> {t("Budgets")}
          <span className="font-normal text-muted">
            — {states.length} {t("configured")}
          </span>
        </span>
        <div className="inline-flex items-center gap-2">
          {states.length > 0 && (
            <button
              type="button"
              onClick={runEvaluate}
              disabled={evaluating}
              className="btn text-xs"
              title={t("Re-check spend against budgets and fire any pending alerts")}
            >
              {evaluating ? t("Checking…") : t("Re-check now")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowEditor(v => !v)}
            className="btn text-xs inline-flex items-center gap-1"
          >
            <Plus size={11}/> {t("Budget")}
          </button>
        </div>
      </header>

      {evalErr && (
        <div className="px-3 py-2 text-xs text-danger bg-danger/10 border-b border-danger/30">
          {evalErr}
        </div>
      )}

      {breached.length > 0 && (
        <div className={`px-3 py-2 text-xs border-b inline-flex items-center gap-2 w-full ${
          breached.some(b => b.tier === "critical")
            ? "bg-danger/10 border-danger/30 text-danger"
            : "bg-warning/10 border-warning/30 text-warning"
        }`}>
          <ShieldAlert size={12}/>
          {breached.length} {t("budget(s) currently over threshold")}
        </div>
      )}

      {showEditor && (
        <BudgetEditor
          defaultCurrency={currency}
          onClose={() => setShowEditor(false)}
          onSaved={() => { mutate(); setShowEditor(false); }}
        />
      )}

      {states.length === 0 && !showEditor && !isLoading && (
        <div className="p-4 text-xs text-muted text-center">
          {t("No budgets yet. Add one to start tracking AI spend against a monthly cap.")}
        </div>
      )}

      {states.length > 0 && (
        <ul className="divide-y divide-border">
          {states.map(s => (
            <BudgetRow key={s.budget.id} state={s} onChange={() => mutate()}/>
          ))}
        </ul>
      )}
    </section>
  );
}

function BudgetRow({ state, onChange }: { state: AIBudgetState; onChange: () => void }) {
  const { t } = useT();
  const { budget, month_to_date, percent_of_cap, tier } = state;
  const pct = Math.min(100, percent_of_cap);
  const overshoot = percent_of_cap > 100 ? percent_of_cap - 100 : 0;
  const barColor =
    tier === "critical" ? "bg-danger" : tier === "warn" ? "bg-warning" : "bg-accent/60";
  const pctLabel =
    overshoot > 0
      ? `${percent_of_cap.toFixed(0)}%`
      : `${percent_of_cap.toFixed(1)}%`;

  const remove = async () => {
    if (!confirm(`${t("Delete budget")} "${budget.name}"?`)) return;
    try {
      await deleteAIBudget(budget.id);
      onChange();
    } catch (e) {
      alert(String((e as Error).message ?? e));
    }
  };

  return (
    <li className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium inline-flex items-center gap-2">
            {budget.name}
            <ScopeBadge type={budget.scope_type} value={budget.scope_value}/>
            {!budget.active && (
              <span className="text-[10px] text-muted">({t("inactive")})</span>
            )}
          </div>
          <div className="text-[11px] text-muted tabular-nums">
            {fmtCurrency(month_to_date, budget.currency)} {t("of")} {fmtCurrency(budget.monthly_limit, budget.currency)}
            <span className="mx-1 text-muted/60">·</span>
            {state.calendar_month}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs tabular-nums font-semibold ${
            tier === "critical" ? "text-danger" : tier === "warn" ? "text-warning" : "text-muted"
          }`}>
            {pctLabel}
          </span>
          <button
            type="button"
            onClick={remove}
            className="text-muted hover:text-danger"
            title={t("Delete")}
          >
            <Trash2 size={11}/>
          </button>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-panel2 overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }}/>
      </div>
      {overshoot > 0 && (
        <div className="mt-0.5 text-[10px] text-danger">
          +{overshoot.toFixed(0)}% {t("over cap")}
        </div>
      )}
    </li>
  );
}

function ScopeBadge({ type, value }: { type: AIBudget["scope_type"]; value: string }) {
  const { t } = useT();
  let label = t("global");
  if (type === "provider") label = `${t("provider")}: ${value}`;
  if (type === "user") label = `${t("user")}: ${value.slice(0, 8)}…`;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-panel2 text-muted font-mono">
      {label}
    </span>
  );
}

function BudgetEditor({
  defaultCurrency,
  onClose,
  onSaved,
}: {
  defaultCurrency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<Omit<AIBudget, "id" | "created_at" | "updated_at">>({
    name: "",
    scope_type: "global",
    scope_value: "",
    monthly_limit: 100,
    currency: defaultCurrency,
    threshold_warn_pct: 80,
    threshold_critical_pct: 100,
    active: true,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    if (!draft.name.trim()) {
      setErr(t("Name is required"));
      return;
    }
    if (draft.scope_type !== "global" && !draft.scope_value.trim()) {
      setErr(t("Scope value is required for provider/user budgets"));
      return;
    }
    setSaving(true);
    try {
      await upsertAIBudget(draft);
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-border bg-panel2/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold inline-flex items-center gap-1.5">
          <Plus size={12}/> {t("New budget")}
        </span>
        <button onClick={onClose} className="text-muted hover:text-text" aria-label={t("Close")}>
          <X size={13}/>
        </button>
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Name")}</span>
          <input
            className="input"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Scope")}</span>
          <select
            className="input"
            value={draft.scope_type}
            onChange={e => setDraft({ ...draft, scope_type: e.target.value as AIBudget["scope_type"] })}
          >
            <option value="global">{t("global")}</option>
            <option value="provider">{t("provider")}</option>
            <option value="user">{t("user")}</option>
          </select>
        </label>
        {draft.scope_type !== "global" && (
          <label className="flex flex-col gap-0.5">
            <span className="text-muted">
              {draft.scope_type === "provider" ? t("Provider name") : t("User UUID")}
            </span>
            <input
              className="input"
              value={draft.scope_value}
              placeholder={draft.scope_type === "provider" ? "openai" : "00000000-…"}
              onChange={e => setDraft({ ...draft, scope_value: e.target.value })}
            />
          </label>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Monthly limit")}</span>
          <input
            className="input text-right"
            type="number"
            min="0"
            step="1"
            value={draft.monthly_limit}
            onChange={e => setDraft({ ...draft, monthly_limit: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Currency")}</span>
          <input
            className="input"
            value={draft.currency}
            onChange={e => setDraft({ ...draft, currency: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Warn at %")}</span>
          <input
            className="input text-right"
            type="number"
            min="1"
            max="999"
            value={draft.threshold_warn_pct}
            onChange={e => setDraft({ ...draft, threshold_warn_pct: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">{t("Critical at %")}</span>
          <input
            className="input text-right"
            type="number"
            min="1"
            max="999"
            value={draft.threshold_critical_pct}
            onChange={e => setDraft({ ...draft, threshold_critical_pct: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn text-accent border-accent/40 hover:bg-accent/10 inline-flex items-center gap-1"
        >
          <Plus size={11}/> {saving ? t("Saving…") : t("Save")}
        </button>
      </div>
    </div>
  );
}

