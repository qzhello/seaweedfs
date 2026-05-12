"use client";
import { useState, useMemo } from "react";
import { useT } from "@/lib/i18n";
import { useAudit, useAuditFacets } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/table-skeleton";
import { ScrollText, X, Search, Clock } from "lucide-react";
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

export default function AuditPage() {
  const { t } = useT();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [kind, setKind] = useState("");
  const [text, setText] = useState("");
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

  // Client-side free-text filter — runs after the server filter so the user
  // can type ad-hoc keywords without waiting for a refetch.
  const filtered = useMemo(() => {
    if (!text) return items;
    const t = text.toLowerCase();
    return items.filter(e => {
      const hay = `${e.actor} ${e.action} ${e.target_kind} ${e.target_id} ${JSON.stringify(e.payload)}`.toLowerCase();
      return hay.includes(t);
    });
  }, [items, text]);

  const pg = usePagination(filtered, 50);

  const chips: { key: string; label: string; clear: () => void }[] = [
    actor  && { key: "actor",  label: `actor=${actor}`,   clear: () => setActor("") },
    action && { key: "action", label: `action=${action}`, clear: () => setAction("") },
    kind   && { key: "kind",   label: `kind=${kind}`,     clear: () => setKind("") },
    text   && { key: "text",   label: `"${text}"`,        clear: () => setText("") },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  const clearAll = () => { setActor(""); setAction(""); setKind(""); setText(""); };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <ScrollText size={22} className="text-accent"/> {t("Audit log")}
          </h1>
          <div className="text-xs text-muted mt-1">
            <span className="font-mono text-text">{filtered.length}</span>
            {filtered.length !== items.length && <span> / {items.length}</span>}
            <span> {t("events")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
            <input
              value={text} onChange={e => setText(e.target.value)}
              placeholder="actor / target / payload"
              className="input w-72 pl-8"
            />
          </div>
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

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
                        <button onClick={() => setActor(e.actor)} className="hover:text-accent transition-colors" title={t("Filter by this actor")}>
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
