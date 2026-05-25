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
import { Activity, AlertTriangle, Cpu, Users, Clock, Coins, Brain } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { useAIUsage } from "@/lib/api";
import type { AIUsageDailyRow, AIUsageModelTotal, AIUsageTopUser } from "@/lib/api";
import { useT } from "@/lib/i18n";

type WindowDays = 7 | 30 | 90;

export function AIUsagePanel() {
  const { t } = useT();
  const [days, setDays] = useState<WindowDays>(7);
  const { data, error, isLoading } = useAIUsage(days);

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
      </header>

      {!hasAnyData ? (
        <EmptyState
          icon={Brain}
          title={t("No AI activity yet")}
          hint={t("Token rows are recorded automatically on every Chat / JSONChat call. Use the floating assistant or any AI-backed action to populate this view.")}
        />
      ) : (
        <>
          {totals && <SummaryTiles totals={totals} models={data.by_model.length} />}
          <DailyChart rows={data.by_day} />
          <ModelTable rows={data.by_model} />
          {data.top_users.length > 0 && <TopUsersTable rows={data.top_users} />}
        </>
      )}
    </div>
  );
}

function SummaryTiles({
  totals,
  models,
}: {
  totals: { calls: number; errors: number; input: number; output: number };
  models: number;
}) {
  const { t } = useT();
  const errRate = totals.calls > 0 ? (totals.errors / totals.calls) * 100 : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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

function ModelTable({ rows }: { rows: AIUsageModelTotal[] }) {
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

function TopUsersTable({ rows }: { rows: AIUsageTopUser[] }) {
  const { t } = useT();
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-border px-3 py-2 text-xs font-semibold inline-flex items-center gap-2">
        <Users size={13}/> {t("Top users")}
      </header>
      <div className="overflow-x-auto">
        <table className="grid w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">{t("User")}</th>
              <th className="num">{t("Calls")}</th>
              <th className="num">{t("Input")}</th>
              <th className="num">{t("Output")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.user_id}>
                <td className="font-mono text-[11px]">{r.username}</td>
                <td className="num tabular-nums">{r.calls.toLocaleString()}</td>
                <td className="num tabular-nums">{fmtCompact(r.input_tokens)}</td>
                <td className="num tabular-nums">{fmtCompact(r.output_tokens)}</td>
              </tr>
            ))}
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
