"use client";

// Role × capability matrix. Each cell is a checkbox; admin row is
// pinned and shows the wildcard cap as enforced (backend rejects
// dropping "*" from admin). Save is per-row so the operator can edit
// roles independently and see immediate feedback.

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ShieldCheck, Save, Loader2, AlertTriangle, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useCaps } from "@/lib/caps-context";
import { Can } from "@/components/can";

type Cap = { name: string; category: string; label: string; description: string };
type RC  = { role: string; capability: string };
type Data = { capabilities: Cap[]; role_capabilities: RC[]; roles: string[] };

export default function PermissionsPage() {
  const { t } = useT();
  return (
    <Can
      cap="permissions.write"
      fallback={
        <div className="card p-6 text-sm text-muted">
          <AlertTriangle size={14} className="inline mr-1 text-warning"/>
          {t("You don't have permission to view this page.")}
        </div>
      }
    >
      <Matrix/>
    </Can>
  );
}

function Matrix() {
  const { t } = useT();
  const { data, mutate, isLoading } = useSWR<Data>("permissions", () => api.listPermissions());
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});

  // Seed `edits` from the server snapshot the first time we get data
  // so the operator's pending changes survive subsequent re-fetches.
  useEffect(() => {
    if (!data) return;
    setEdits(prev => {
      if (Object.keys(prev).length) return prev;
      const next: Record<string, Set<string>> = {};
      for (const role of data.roles) next[role] = new Set();
      for (const rc of data.role_capabilities) {
        next[rc.role] ??= new Set();
        next[rc.role].add(rc.capability);
      }
      return next;
    });
  }, [data]);

  // Group capabilities by category for readable layout. System caps
  // (incl. the wildcard) go to the bottom — admin-y stuff that we
  // want operators to scroll past, not stumble onto first.
  const groups = useMemo(() => {
    const by: Record<string, Cap[]> = {};
    for (const c of data?.capabilities || []) {
      (by[c.category] ??= []).push(c);
    }
    const order = ["volume", "cluster", "s3", "ops", "ai", "system", "misc"];
    return order
      .filter(k => by[k]?.length)
      .map(k => ({ category: k, caps: by[k] }));
  }, [data]);

  if (isLoading || !data) {
    return <div className="card p-6 text-sm text-muted">{t("Loading…")}</div>;
  }

  const has = (role: string, cap: string) => edits[role]?.has(cap) ?? false;
  const toggle = (role: string, cap: string) => {
    setEdits(prev => {
      const next = { ...prev };
      const set = new Set(next[role] || []);
      if (set.has(cap)) set.delete(cap); else set.add(cap);
      next[role] = set;
      return next;
    });
  };

  // Diff the current row against what came from the server so we can
  // disable Save when there's nothing to send and show a clear count.
  const initialFor = (role: string) => {
    const set = new Set<string>();
    for (const rc of data.role_capabilities) if (rc.role === role) set.add(rc.capability);
    return set;
  };
  const dirtyCount = (role: string) => {
    const cur = edits[role] || new Set<string>();
    const init = initialFor(role);
    let n = 0;
    cur.forEach(c => { if (!init.has(c)) n++; });
    init.forEach(c => { if (!cur.has(c)) n++; });
    return n;
  };

  const saveRow = async (role: string) => {
    setSaving(role);
    try {
      const caps = [...(edits[role] || new Set())];
      await api.setRolePermissions(role, caps);
      setSavedAt(prev => ({ ...prev, [role]: Date.now() }));
      // Refetch authoritative state to confirm what the backend applied
      // (the admin-wildcard guard could have rejected a row).
      await mutate();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <ShieldCheck size={16}/> {t("Permissions")}
          </h1>
          <p className="text-xs text-muted mt-1">
            {t("Assign capabilities to roles. Admin always retains the '*' wildcard.")}
          </p>
        </div>
      </header>

      <div className="card overflow-x-auto">
        <table className="grid w-full">
          <thead>
            <tr>
              <th className="text-left sticky left-0 bg-panel z-10 min-w-[280px]">{t("Capability")}</th>
              {data.roles.map(r => (
                <th key={r} className="text-center min-w-[100px]">{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <CapGroup
                key={g.category}
                category={g.category}
                caps={g.caps}
                roles={data.roles}
                has={has}
                toggle={toggle}
              />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="text-right text-xs text-muted">{t("Save changes per role")}:</td>
              {data.roles.map(r => {
                const dirty = dirtyCount(r);
                const recent = savedAt[r] && Date.now() - savedAt[r] < 2000;
                return (
                  <td key={r} className="text-center">
                    <button
                      className="btn inline-flex items-center gap-1 text-xs"
                      onClick={() => saveRow(r)}
                      disabled={saving === r || dirty === 0}
                    >
                      {saving === r
                        ? <Loader2 size={12} className="animate-spin"/>
                        : recent
                          ? <Check size={12} className="text-emerald-300"/>
                          : <Save size={12}/>}
                      {dirty > 0 ? `${dirty}` : recent ? t("Saved") : t("Save")}
                    </button>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function CapGroup({
  category, caps, roles, has, toggle,
}: {
  category: string;
  caps: Cap[];
  roles: string[];
  has: (role: string, cap: string) => boolean;
  toggle: (role: string, cap: string) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={1 + roles.length} className="bg-panel2/40 text-[10px] uppercase tracking-wider text-muted/80 font-semibold py-1.5">
          {category}
        </td>
      </tr>
      {caps.map(c => (
        <tr key={c.name}>
          <td className="sticky left-0 bg-panel z-0">
            <div className="font-mono text-xs">{c.name}</div>
            <div className="text-[11px] text-muted truncate" title={c.description}>{c.label || c.description}</div>
          </td>
          {roles.map(r => (
            <td key={r} className="text-center">
              <input
                type="checkbox"
                checked={has(r, c.name)}
                onChange={() => toggle(r, c.name)}
                disabled={r === "admin" && c.name === "*"}
                className="accent-accent cursor-pointer"
                title={r === "admin" && c.name === "*" ? "Required to retain admin recovery" : c.name}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
