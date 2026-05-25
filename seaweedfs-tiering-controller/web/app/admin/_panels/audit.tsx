"use client";
import { useState, useMemo } from "react";
import { useT } from "@/lib/i18n";
import { useAudit, useAuditFacets, auditSummary } from "@/lib/api";
import type { AuditSummaryResp } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/table-skeleton";
import {
  ScrollText, X, Search, Clock, Sparkles, ChevronDown, ChevronRight,
  AlertTriangle, Loader2, FileText, Bot,
} from "lucide-react";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";

// Audit-log viewer. Reads /api/v1/audit with optional actor/action/target/
// since filters. SWR auto-refreshes every 15s so newly-written rows surface
// without manual reload. Facets (distinct actors/actions/kinds) drive the
// dropdowns and stay in sync as new event types appear.

type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

const RANGES: { key: RangeKey; label: string; ms: number }[] = [
  { key: "1h",  label: "1h",  ms: 60 * 60 * 1000 },
  { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d",  label: "7d",  ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All", ms: 0 },
];

interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  payload: any;
}

export function AuditPanel() {
  const { t } = useT();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [kind, setKind] = useState("");
  const [text, setText] = useState("");
  const [aiOnly, setAIOnly] = useState(false);
  const [range, setRange] = useState<RangeKey>("24h");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const since = useMemo(() => {
    const r = RANGES.find(r => r.key === range);
    if (!r || r.ms === 0) return undefined;
    return new Date(Date.now() - r.ms).toISOString();
  }, [range]);

  const { data, isLoading, isValidating, mutate } = useAudit({ actor, action, kind, since, limit: 500 });
  const { data: facets } = useAuditFacets();
  const items: AuditEntry[] = (data?.items ?? []) as AuditEntry[];

  // Client-side filters — run after the server filter so the user can
  // toggle quickly without waiting for a refetch.
  //
  // aiOnly matches BOTH conventions we use today:
  //   - actor starts with "ai:"     (every assistant_write_tools.go call)
  //   - action starts with "ai."    (catches anything routed through the
  //                                  AI surface even if the actor was a
  //                                  human triggering it, e.g. /audit/summary)
  // Either match is enough — the goal is "show me everything AI touched",
  // not "only autonomous AI actions".
  const filtered = useMemo(() => {
    let out = items;
    if (aiOnly) {
      out = out.filter(e => e.actor.startsWith("ai:") || e.action.startsWith("ai."));
    }
    if (text) {
      const q = text.toLowerCase();
      out = out.filter(e => {
        const hay = `${e.actor} ${e.action} ${e.target_kind} ${e.target_id} ${JSON.stringify(e.payload)}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return out;
  }, [items, text, aiOnly]);

  const pg = usePagination(filtered, 50);

  const chips: { key: string; label: string; clear: () => void }[] = [
    actor  && { key: "actor",  label: `actor=${actor}`,   clear: () => setActor("") },
    action && { key: "action", label: `action=${action}`, clear: () => setAction("") },
    kind   && { key: "kind",   label: `kind=${kind}`,     clear: () => setKind("") },
    text   && { key: "text",   label: `"${text}"`,        clear: () => setText("") },
    aiOnly && { key: "aiOnly", label: t("AI activity only"), clear: () => setAIOnly(false) },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  const clearAll = () => { setActor(""); setAction(""); setKind(""); setText(""); setAIOnly(false); };

  return (
    <div className="space-y-5">
      {/* Page H1 lives in TabsLayout — keep event count + search + refresh controls. */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="text-xs text-muted">
          <span className="font-mono text-text">{filtered.length}</span>
          {filtered.length !== items.length && <span> / {items.length}</span>}
          <span> {t("events")}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
            <input
              value={text} onChange={e => setText(e.target.value)}
              placeholder={t("actor / target / payload")}
              className="input w-72 pl-8"
            />
          </div>
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </div>

      {/* AI summary — collapsible card. Sends the current filters
          plus a free-text "focus" question to /audit/summary so the
          AI's prose is grounded in the same slice the operator is
          looking at. */}
      <AISummarySection
        actor={actor}
        action={action}
        kind={kind}
        range={range}
      />

      {/* Filter bar — single row, wraps on mobile */}
      <section className="card px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select className="select w-auto py-1 text-xs" value={actor} onChange={e => setActor(e.target.value)}>
            <option value="">{t("All actors")}</option>
            {(facets?.actors ?? []).map((a: string) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="select w-auto py-1 text-xs" value={action} onChange={e => setAction(e.target.value)}>
            <option value="">{t("All actions")}</option>
            {(facets?.actions ?? []).map((a: string) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="select w-auto py-1 text-xs" value={kind} onChange={e => setKind(e.target.value)}>
            <option value="">{t("All kinds")}</option>
            {(facets?.kinds ?? []).map((k: string) => <option key={k} value={k}>{k}</option>)}
          </select>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {RANGES.map(r => (
              <button key={r.key} onClick={() => setRange(r.key)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  range === r.key ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                }`}>
                {r.label}
              </button>
            ))}
          </div>
          {/* AI-only quick toggle. Matches any row where the actor was AI
              (ai:<chat-id>) OR the action lives in the ai.* namespace. */}
          <button
            type="button"
            onClick={() => setAIOnly(v => !v)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
              aiOnly
                ? "bg-accent/15 text-accent border-accent/40"
                : "text-muted border-border hover:bg-panel2 hover:text-text"
            }`}
            title={t("Show only AI-initiated actions")}
          >
            <Bot size={12}/> {t("AI only")}
          </button>
          <div className="flex-1"/>
          {chips.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 flex-wrap">
                {chips.map(f => (
                  <button key={f.key} onClick={f.clear}
                    className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/30 text-accent px-2 py-0.5 text-[11px] hover:bg-accent/20 hover:border-accent/50 transition-colors">
                    {f.label}<X size={10}/>
                  </button>
                ))}
              </div>
              <button onClick={clearAll}
                className="text-[11px] text-muted hover:text-text underline underline-offset-2">
                clear
              </button>
            </>
          )}
        </div>
      </section>

      {/* Audit table */}
      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={8} headers={["When", "Actor", "Action", "Target", "Payload"]}/>
        ) : filtered.length === 0 ? (
          items.length === 0 ? (
            <EmptyState icon={Clock} title="No audit events in this range"
              hint="Widen the time range or remove filters. Every UI action and skill execution writes here."/>
          ) : (
            <EmptyState icon={ScrollText} size="sm" title="No events match the current filter"/>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th>{t("When")}</th>
                <th>{t("Actor")}</th>
                <th>{t("Action")}</th>
                <th>{t("Target")}</th>
                <th>{t("Payload")}</th>
              </tr></thead>
              <tbody>
                {pg.slice.map(e => {
                  const open = !!expanded[e.id];
                  const payloadStr = e.payload && Object.keys(e.payload).length > 0
                    ? JSON.stringify(e.payload)
                    : "";
                  return (
                    <tr key={e.id} className="align-top">
                      <td className="text-xs text-muted whitespace-nowrap" title={new Date(e.at).toLocaleString()}>
                        {relTime(e.at)}
                      </td>
                      <td className="text-xs font-mono">
                        <button onClick={() => setActor(e.actor)} className="inline-flex items-center gap-1 hover:text-accent transition-colors" title={t("Filter by this actor")}>
                          {e.actor.startsWith("ai:") && (
                            <Bot size={11} className="text-accent shrink-0" aria-label="AI actor"/>
                          )}
                          {e.actor}
                        </button>
                      </td>
                      <td>
                        <button onClick={() => setAction(e.action)} className="badge hover:border-accent/40 transition-colors" title={t("Filter by this action")}>
                          {e.action}
                        </button>
                      </td>
                      <td className="text-xs">
                        <button onClick={() => setKind(e.target_kind)} className="text-muted hover:text-accent transition-colors" title={t("Filter by this kind")}>
                          {e.target_kind}
                        </button>
                        <span className="text-muted/40 mx-1">/</span>
                        <span className="font-mono">{e.target_id || "—"}</span>
                      </td>
                      <td>
                        {payloadStr ? (
                          <button onClick={() => setExpanded(s => ({ ...s, [e.id]: !open }))}
                            className="text-left max-w-[480px] block">
                            {open ? (
                              <pre className="font-mono text-[11px] bg-bg/60 border border-border rounded px-2 py-1 whitespace-pre-wrap break-all">
{JSON.stringify(e.payload, null, 2)}
                              </pre>
                            ) : (
                              <span className="font-mono text-[11px] text-muted truncate block hover:text-text transition-colors">
                                {payloadStr}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-muted/50">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length > 0 && <Pagination {...pg}/>}
          </div>
        )}
      </section>
    </div>
  );
}

// ---- AI summary ------------------------------------------------------
//
// Collapsible card that asks the AI to summarise the audit slice the
// operator is currently looking at. We send the SAME actor/action/kind
// filters the user picked, so what the AI sees == what the table shows
// (within the 500-row cap on the backend). The "focus" textarea is the
// only freeform input — empty = generic summary.

const RANGE_HOURS: Record<RangeKey, number> = {
  "1h": 1, "24h": 24, "7d": 168, "30d": 720, "all": 720, // "all" capped at 30d for AI prompt budget
};

function AISummarySection({ actor, action, kind, range }: {
  actor: string; action: string; kind: string; range: RangeKey;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading]   = useState(false);
  const [resp, setResp]         = useState<AuditSummaryResp | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setResp(null);
    try {
      const r = await auditSummary({
        hours:       RANGE_HOURS[range] ?? 168,
        actor:       actor || undefined,
        action:      action || undefined,
        target_kind: kind || undefined,
        question:    question.trim() || undefined,
      });
      setResp(r);
      if (!r.ok) setError(r.error ?? "AI did not return a summary.");
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Preset prompts — quick starters operators reach for. Empty strings
  // are intentional: clicking "Generic" just clears the focus input.
  const presets = [
    { label: t("Generic summary"), value: "" },
    { label: t("Focus on S3 changes"),       value: "Focus on S3 (bucket/identity/quota/circuit-breaker) changes." },
    { label: t("Focus on deletions"),        value: "Highlight every delete, drop, and removal action." },
    { label: t("Who did what?"),             value: "Group the narrative by actor — who did how many things and what kind." },
  ];

  return (
    <section className="card overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface/40 transition-colors"
        onClick={() => setExpanded(s => !s)}
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Sparkles size={15} className="text-accent"/>
          {t("AI summary")}
          {resp?.summary && (
            <span className="text-[11px] text-muted ml-1">
              · {t("{n} events").replace("{n}", String(resp.row_count))}
            </span>
          )}
        </span>
        {expanded ? <ChevronDown size={15} className="text-muted"/> : <ChevronRight size={15} className="text-muted"/>}
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <p className="text-[11px] text-muted leading-relaxed">
            {t("Summarises the same audit slice you have filtered. The narrative is AI-generated; the event counts come straight from the database.")}
          </p>

          {/* Preset chips */}
          <div className="flex flex-wrap gap-1.5">
            {presets.map(p => (
              <button
                key={p.label}
                onClick={() => setQuestion(p.value)}
                className={`px-2 py-1 rounded text-[11px] border ${
                  question === p.value
                    ? "bg-accent/15 text-accent border-accent/40"
                    : "text-muted border-border hover:text-text hover:bg-panel2"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Focus (optional)")}</label>
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              rows={2}
              placeholder={t("e.g. 'who changed quotas this week' — empty for a generic summary")}
              className="input w-full resize-none text-xs"
            />
          </div>

          <div>
            <button
              className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40"
              onClick={generate}
              disabled={loading}
            >
              {loading
                ? <><Loader2 size={13} className="animate-spin"/> {t("Summarising…")}</>
                : <><Sparkles size={13}/> {t("Summarise")}</>}
            </button>
          </div>

          {error && (
            <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger inline-flex items-start gap-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0"/> {error}
            </div>
          )}

          {/* Empty window — no AI call was made */}
          {resp?.empty && (
            <div className="text-xs text-muted inline-flex items-center gap-1.5">
              <FileText size={12}/> {t("No audit events in this window — nothing to summarise.")}
            </div>
          )}

          {/* Successful summary */}
          {resp?.ok && resp?.summary && (
            <div className="rounded-md border border-accent/30 bg-accent/[0.04] p-3 space-y-3">
              <h3 className="text-sm font-medium">{resp.summary.headline}</h3>
              <p className="text-[12px] text-text leading-relaxed">{resp.summary.narrative}</p>

              {resp.summary.highlights?.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{t("Highlights")}</div>
                  <ul className="text-[11px] space-y-0.5 list-disc list-inside">
                    {resp.summary.highlights.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                </div>
              )}

              {resp.summary.risks?.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-danger inline-flex items-center gap-1">
                    <AlertTriangle size={10}/> {t("Risks to double-check")}
                  </div>
                  <ul className="text-[11px] space-y-0.5 list-disc list-inside text-danger">
                    {resp.summary.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}

              {/* Facet chips — counted server-side, NOT from the AI. */}
              {resp.facets && (
                <div className="grid grid-cols-3 gap-3 text-[11px] pt-2 border-t border-border/40">
                  <FacetList title={t("By action")} rows={resp.facets.by_action}/>
                  <FacetList title={t("By actor")}  rows={resp.facets.by_actor}/>
                  <FacetList title={t("By kind")}   rows={resp.facets.by_kind}/>
                </div>
              )}

              <div className="text-[10px] text-muted/80 pt-1">
                {resp.truncated && (
                  <span className="text-warning inline-flex items-center gap-1 mr-2">
                    <AlertTriangle size={10}/> {t("AI saw only the most recent 500 rows.")}
                  </span>
                )}
                {resp.provider_name && <>{t("Provider")}: <code className="font-mono">{resp.provider_name}</code></>}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// FacetList renders one column of "X · n" rows — the counted breakdown
// that complements the AI's prose narrative.
function FacetList({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      {rows.length === 0 ? (
        <div className="text-muted/60">—</div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(r => (
            <li key={r.key} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-text">{r.key}</span>
              <span className="text-muted tabular-nums">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
