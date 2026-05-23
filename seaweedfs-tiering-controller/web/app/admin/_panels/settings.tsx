"use client";
// Settings page — master/detail layout.
//   Left rail: groups (with item counts and a search box).
//   Right pane: header + entries list for the active group, each card
//   showing description, impact, current value, version + audit, and an
//   inline editor. All copy is wrapped in t() for the zh/en toggle.

import { useConfig, useConfigHistory, api } from "@/lib/api";
import { CardSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";
import { EmptyState } from "@/components/empty-state";
import { useEffect, useMemo, useState } from "react";
import {
  Flame, Snowflake, History as HistoryIcon, Save, Undo2,
  AlertTriangle, Eye, EyeOff, Clock, Search, Settings as SettingsIcon, X,
} from "lucide-react";
import { relTime } from "@/lib/utils";

type Entry = {
  key: string; group_name: string; value: unknown; value_type: string;
  is_hot: boolean; is_sensitive: boolean; description: string; impact: string;
  schema: unknown; updated_by: string; updated_at: string; version: number;
};

const ACTIVE_GROUP_KEY = "tier.settings.activeGroup";

export function SettingsPanel() {
  const { t } = useT();
  const { data, mutate } = useConfig();
  const groups = (data?.groups || {}) as Record<string, Entry[]>;
  const groupNames = useMemo(() => Object.keys(groups).sort(), [groups]);

  const [active, setActive] = useState<string>("");
  const [search, setSearch] = useState("");
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  // Restore last picked group; fall back to the first available.
  useEffect(() => {
    if (active || groupNames.length === 0) return;
    const saved = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_GROUP_KEY) : null;
    setActive(saved && groupNames.includes(saved) ? saved : groupNames[0]);
  }, [active, groupNames]);

  const onPickGroup = (g: string) => {
    setActive(g);
    if (typeof window !== "undefined") localStorage.setItem(ACTIVE_GROUP_KEY, g);
  };

  const entries = useMemo<Entry[]>(() => {
    const items = groups[active] || [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(e =>
      e.key.toLowerCase().includes(q) ||
      (e.description || "").toLowerCase().includes(q) ||
      (e.impact || "").toLowerCase().includes(q),
    );
  }, [groups, active, search]);

  // Aggregate badges per group (hot count, sensitive count) for the rail.
  const groupMeta = useMemo(() => {
    const meta: Record<string, { count: number; hot: number; sensitive: number; critical: boolean }> = {};
    for (const g of groupNames) {
      const items = groups[g] || [];
      meta[g] = {
        count: items.length,
        hot: items.filter(e => e.is_hot).length,
        sensitive: items.filter(e => e.is_sensitive).length,
        critical: items.some(e => e.key === "safety.emergency_stop"),
      };
    }
    return meta;
  }, [groups, groupNames]);

  return (
    <div className="space-y-4">
      {/* Page H1 lives in TabsLayout — keep only the inline legend (hot/restart). */}
      <div className="text-xs text-muted">
        {t("All runtime config lives here.")}{" "}
        <Flame size={11} className="inline text-warning -mt-0.5"/> {t("hot reload")}
        {" · "}
        <Snowflake size={11} className="inline text-muted -mt-0.5"/> {t("restart required")}
      </div>

      {groupNames.length === 0 ? (
        <CardSkeleton lines={4}/>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
          {/* Left rail */}
          <aside className="card p-2 self-start sticky top-4">
            <div className="text-[10px] uppercase tracking-wider text-muted px-2 py-1.5">
              {t("Configuration groups")}
            </div>
            <nav className="space-y-0.5">
              {groupNames.map(g => {
                const m = groupMeta[g];
                const isActive = g === active;
                return (
                  <button
                    key={g}
                    onClick={() => onPickGroup(g)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between gap-2 transition-colors ${
                      isActive
                        ? "bg-accent/15 text-accent border border-accent/30"
                        : "hover:bg-bg/60 border border-transparent"
                    }`}>
                    <span className="capitalize truncate">
                      {t(g)}
                      {m.critical && (
                        <AlertTriangle
                          size={10}
                          className="inline ml-1 -mt-0.5 text-danger"
                          aria-label={t("Contains critical setting")}
                        />
                      )}
                    </span>
                    <span className="text-[10px] text-muted shrink-0">{m.count}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Right detail */}
          <section className="space-y-3">
            <div className="card p-3 flex items-center gap-2">
              <div className="flex-1">
                <h2 className="text-sm font-medium capitalize">{active ? t(active) : "—"}</h2>
                <div className="text-[11px] text-muted mt-0.5">
                  {entries.length} / {(groups[active] || []).length} {t("entries")}
                </div>
              </div>
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted"/>
                <input
                  className="input pl-7 pr-7 py-1.5 text-xs w-56"
                  placeholder={t("Search keys / description")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    aria-label={t("Clear")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                    onClick={() => setSearch("")}>
                    <X size={12}/>
                  </button>
                )}
              </div>
            </div>

            {entries.length === 0 ? (
              <div className="card p-6">
                <EmptyState
                  icon={Search}
                  title={t("No matching configuration")}
                  hint={t("Adjust the search or pick another group.")}
                />
              </div>
            ) : (
              <div className="space-y-2">
                {entries.map(e => (
                  <ConfigRow
                    key={e.key}
                    entry={e}
                    onSaved={() => mutate()}
                    onShowHistory={() => setHistoryKey(e.key)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {historyKey && (
        <HistoryDrawer
          keyName={historyKey}
          onClose={() => setHistoryKey(null)}
          onRollback={async (id) => {
            await api.rollbackConfig(historyKey, id);
            await mutate();
            setHistoryKey(null);
          }}
        />
      )}
    </div>
  );
}

function ConfigRow({
  entry, onSaved, onShowHistory,
}: { entry: Entry; onSaved: () => void; onShowHistory: () => void }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => JSON.stringify(entry.value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const original = JSON.stringify(entry.value);
  const changed = draft !== original;
  const masked = entry.is_sensitive && !showSecret;
  const isCritical = entry.key === "safety.emergency_stop";

  return (
    <div className={`border rounded-lg p-3 ${isCritical ? "border-danger/40 bg-danger/5" : "border-border/60"}`}>
      {/* Header row: key + badges + audit */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm break-all">{entry.key}</span>
            {entry.is_hot ? (
              <span title={t("hot reload")} className="badge border-warning/40 text-warning">
                <Flame size={10}/> {t("hot")}
              </span>
            ) : (
              <span title={t("restart required")} className="badge border-border text-muted">
                <Snowflake size={10}/> {t("restart")}
              </span>
            )}
            {entry.is_sensitive && (
              <span className="badge border-border text-muted">
                <Eye size={10}/> {t("sensitive")}
              </span>
            )}
            {isCritical && (
              <span className="badge border-danger/40 text-danger">
                <AlertTriangle size={10}/> {t("CRITICAL")}
              </span>
            )}
          </div>
          {entry.description && (
            <div className="text-xs text-muted mt-1">{t(entry.description)}</div>
          )}
          {entry.impact && (
            <div className="text-xs text-warning/80 mt-0.5">↳ {t(entry.impact)}</div>
          )}
        </div>
        <div className="text-[10px] text-muted text-right shrink-0">
          v{entry.version}
          <div>{t("edited by")} {entry.updated_by} {relTime(entry.updated_at)}</div>
        </div>
      </div>

      {/* Value + actions row */}
      <div className="flex items-center gap-2 flex-wrap mt-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <ValueEditor entry={entry} value={draft} onChange={setDraft}/>
          ) : (
            <code className="font-mono text-xs px-2 py-1.5 rounded bg-bg border border-border block break-all">
              {masked ? "•••••••" : original}
            </code>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {entry.is_sensitive && !editing && (
            <button
              className="btn"
              aria-label={showSecret ? t("Hide") : t("Show")}
              onClick={() => setShowSecret(!showSecret)}>
              {showSecret ? <EyeOff size={12}/> : <Eye size={12}/>}
            </button>
          )}
          {!editing ? (
            <>
              <button
                className="btn"
                onClick={() => { setDraft(original); setEditing(true); setErr(null); }}>
                {t("Edit")}
              </button>
              <button
                className="btn inline-flex items-center gap-1"
                onClick={onShowHistory}
                title={t("History")}>
                <HistoryIcon size={12}/>
              </button>
            </>
          ) : (
            <>
              {changed && (
                <button
                  className="btn btn-primary inline-flex items-center gap-1"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true); setErr(null);
                    try {
                      const parsed = JSON.parse(draft);
                      await api.setConfig(entry.key, { value: parsed, expected_version: entry.version });
                      setEditing(false); onSaved();
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : String(e));
                    } finally { setSaving(false); }
                  }}>
                  <Save size={12}/> {saving ? t("Saving…") : t("Save")}
                </button>
              )}
              <button className="btn" onClick={() => { setEditing(false); setErr(null); }}>
                {t("Cancel")}
              </button>
            </>
          )}
        </div>
      </div>

      {editing && changed && (
        <div className="mt-2 text-[11px] text-muted">
          <span className="font-mono">{original}</span> → <span className="font-mono text-warning">{draft}</span>
        </div>
      )}
      {err && <div className="mt-2 text-xs text-danger">{err}</div>}
    </div>
  );
}

function ValueEditor({ entry, value, onChange }: { entry: Entry; value: string; onChange: (s: string) => void }) {
  const { t } = useT();
  if (entry.value_type === "bool") {
    const v = value.trim() === "true";
    return (
      <button
        className={`btn ${v ? "btn-primary" : ""}`}
        onClick={() => onChange(v ? "false" : "true")}>
        {v ? t("true") : t("false")}
      </button>
    );
  }
  return (
    <input
      className="input font-mono text-xs w-full"
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function HistoryDrawer({
  keyName, onClose, onRollback,
}: { keyName: string; onClose: () => void; onRollback: (id: number) => void }) {
  const { t } = useT();
  const { data } = useConfigHistory(keyName);
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex justify-end" onClick={onClose}>
      <div
        className="w-[600px] max-w-full bg-panel border-l border-border h-full p-5 overflow-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium font-mono break-all">
            {keyName} <span className="text-xs text-muted">— {t("History")}</span>
          </h3>
          <button className="btn" onClick={onClose} aria-label={t("Close")}>
            <X size={12}/>
          </button>
        </div>
        <div className="space-y-2">
          {(data?.items || []).map((h: { id: number; version: number; changed_by: string; changed_at: string; old_value: unknown; new_value: unknown }) => (
            <div key={h.id} className="border border-border/60 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted">
                  v{h.version} · {h.changed_by} · {relTime(h.changed_at)}
                </span>
                <button
                  className="btn inline-flex items-center gap-1"
                  onClick={() => onRollback(h.id)}>
                  <Undo2 size={12}/> {t("Restore")}
                </button>
              </div>
              <div className="text-xs space-y-1">
                {h.old_value !== null && (
                  <div>
                    <span className="text-muted">{t("old:")}</span>{" "}
                    <code className="font-mono">{JSON.stringify(h.old_value)}</code>
                  </div>
                )}
                <div>
                  <span className="text-muted">{t("new:")}</span>{" "}
                  <code className="font-mono">{JSON.stringify(h.new_value)}</code>
                </div>
              </div>
            </div>
          ))}
          {(!data?.items || !data.items.length) && (
            <EmptyState
              icon={Clock}
              title={t("No config history")}
              hint={t("Edits to system_config appear here with version + actor.")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
