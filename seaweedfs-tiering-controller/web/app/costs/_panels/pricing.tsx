"use client";

// Backend pricing CRUD. Operators enter $/TB/month per backend; one row
// must be marked as the hot reference (basis for the counterfactual on
// the Costs Overview tab). Local-disk pseudo-backends are pre-seeded by
// migration 036.

import { useState } from "react";
import {
  DollarSign, Plus, Edit3, Trash2, Star, Save, X, Loader2,
} from "lucide-react";
import { api, usePricing, type BackendPricing } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorPanel } from "@/components/error-panel";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { toast } from "@/lib/toast";

const KINDS: BackendPricing["kind"][] = ["hot", "warm", "cold", "archive"];
const KIND_TONE: Record<BackendPricing["kind"], string> = {
  hot:     "border-danger/40 text-danger bg-danger/5",
  warm:    "border-warning/40 text-warning bg-warning/5",
  cold:    "border-accent/40 text-accent bg-accent/5",
  archive: "border-slate-400/40 text-slate-300 bg-slate-400/5",
};

export function PricingPanel() {
  const { t } = useT();
  return (
    <Can cap="cost.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { data, mutate, isLoading, isValidating, error } = usePricing();
  const [editing, setEditing] = useState<Partial<BackendPricing> | null>(null);
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* Toolbar (no page H1 — the tab strip in /costs provides title context) */}
      <div className="flex items-center justify-end gap-2">
        <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        <Can cap="cost.write">
          <button
            className="btn btn-primary inline-flex items-center gap-1.5 text-xs"
            onClick={() => setEditing({
              name: "", display_name: "", kind: "warm", currency: "USD",
              storage_price_per_tb_month: 0, egress_price_per_tb: 0,
              request_price_per_million: 0, min_billable_bytes: 0,
              replication_factor: 1.0, is_hot_reference: false, notes: "",
            })}
          >
            <Plus size={12}/> {t("New backend price")}
          </button>
        </Can>
      </div>

      {error && <ErrorPanel error={error}/>}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={5} headers={[t("Name"), t("Kind"), t("$/TB/month"), t("Replication"), t("Notes"), ""]}/>
        </section>
      ) : items.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title={t("No pricing configured")}
          hint={t("Click 'New backend price' to add one. Migration 036 seeds local-ssd/local-hdd/local out of the box.")}
        />
      ) : (
        <section className="card overflow-hidden">
          <table className="grid">
            <thead>
              <tr>
                <th>{t("Name")}</th>
                <th>{t("Kind")}</th>
                <th className="text-right">{t("$/TB/month")}</th>
                <th className="text-right">{t("Replication")}</th>
                <th>{t("Notes")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id}>
                  <td>
                    <div className="font-mono text-sm inline-flex items-center gap-1.5">
                      {p.is_hot_reference && (
                        <span title={t("Hot reference (counterfactual basis)")}>
                          <Star size={12} className="text-warning fill-warning"/>
                        </span>
                      )}
                      {p.name}
                    </div>
                    <div className="text-[11px] text-muted">{p.display_name}</div>
                  </td>
                  <td>
                    <span className={`badge text-[10px] ${KIND_TONE[p.kind]}`}>{t(p.kind)}</span>
                  </td>
                  <td className="text-right font-mono text-sm">{p.currency} {p.storage_price_per_tb_month.toFixed(2)}</td>
                  <td className="text-right font-mono text-xs text-muted">×{p.replication_factor.toFixed(2)}</td>
                  <td className="text-[11px] text-muted truncate max-w-[280px]" title={p.notes}>{p.notes || "—"}</td>
                  <td>
                    <div className="flex gap-1 justify-end">
                      <Can cap="cost.write">
                        <button className="btn text-xs inline-flex items-center gap-1" onClick={() => setEditing(p)}>
                          <Edit3 size={11}/> {t("Edit")}
                        </button>
                        <button
                          className="btn text-xs inline-flex items-center"
                          title={t("Delete")}
                          onClick={async () => {
                            if (!(await confirmDlg.danger({ title: t('Delete pricing for "{name}"?').replace("{name}", p.name) }))) return;
                            try {
                              await api.deletePricing(p.id);
                              toast.success(t("Deleted"));
                              mutate();
                            } catch (e) { toast.fromError(e, t("Delete failed")); }
                          }}
                        >
                          <Trash2 size={11}/>
                        </button>
                      </Can>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <PricingModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); mutate(); }}
        />
      )}
    </div>
  );
}

function PricingModal({ initial, onClose, onSaved }: {
  initial: Partial<BackendPricing>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<Partial<BackendPricing>>(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof BackendPricing>(k: K, v: BackendPricing[K]) =>
    setDraft(d => ({ ...d, [k]: v }));

  const save = async () => {
    if (!draft.name?.trim()) {
      toast.warn(t("Name is required"));
      return;
    }
    setSaving(true);
    try {
      await api.upsertPricing(draft);
      toast.success(t("Saved"));
      onSaved();
    } catch (e) {
      toast.fromError(e, t("Save failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl flex flex-col p-0">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <DollarSign size={16}/>
            {initial.id ? t("Edit pricing") : t("New backend price")}
          </h2>
          <button onClick={onClose} aria-label={t("Close")} className="text-muted hover:text-text"><X size={14}/></button>
        </header>
        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("Name (matches RemoteStorageName or local-<disk_type>)")}>
              <input
                value={draft.name ?? ""} onChange={e => set("name", e.target.value)}
                className="input w-full text-sm font-mono"
                placeholder="local-ssd"
                disabled={!!initial.id /* renaming would orphan snapshots */}
              />
            </Field>
            <Field label={t("Display name")}>
              <input value={draft.display_name ?? ""} onChange={e => set("display_name", e.target.value)}
                className="input w-full text-sm" placeholder="Local SSD"/>
            </Field>
            <Field label={t("Kind")}>
              <select value={draft.kind} onChange={e => set("kind", e.target.value as BackendPricing["kind"])}
                className="input w-full text-sm">
                {KINDS.map(k => <option key={k} value={k}>{t(k)}</option>)}
              </select>
            </Field>
            <Field label={t("Currency")}>
              <input value={draft.currency ?? "USD"} onChange={e => set("currency", e.target.value)}
                className="input w-full text-sm" placeholder="USD"/>
            </Field>
            <Field label={t("Storage price ($/TB/month)")}>
              <input type="number" step="0.0001" min="0"
                value={draft.storage_price_per_tb_month ?? 0}
                onChange={e => set("storage_price_per_tb_month", Number(e.target.value))}
                className="input w-full text-sm font-mono"/>
            </Field>
            <Field label={t("Egress price ($/TB)")}>
              <input type="number" step="0.0001" min="0"
                value={draft.egress_price_per_tb ?? 0}
                onChange={e => set("egress_price_per_tb", Number(e.target.value))}
                className="input w-full text-sm font-mono"/>
            </Field>
            <Field label={t("Request price ($ per million)")}>
              <input type="number" step="0.0001" min="0"
                value={draft.request_price_per_million ?? 0}
                onChange={e => set("request_price_per_million", Number(e.target.value))}
                className="input w-full text-sm font-mono"/>
            </Field>
            <Field label={t("Replication factor (cloud-side, leave 1 for local)")}>
              <input type="number" step="0.01" min="0.1"
                value={draft.replication_factor ?? 1}
                onChange={e => set("replication_factor", Number(e.target.value))}
                className="input w-full text-sm font-mono"/>
            </Field>
          </div>
          <Field label={t("Notes")}>
            <textarea value={draft.notes ?? ""} onChange={e => set("notes", e.target.value)}
              rows={2}
              className="input w-full text-sm"
              placeholder={t("Where this number came from. Helps the next operator who picks up.")}/>
          </Field>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={!!draft.is_hot_reference}
              onChange={e => set("is_hot_reference", e.target.checked)}
              className="mt-0.5"/>
            <div>
              <div className="font-medium">{t("Use as hot reference for counterfactual baseline")}</div>
              <div className="text-[11px] text-muted">
                {t("Exactly one row must be the hot reference. Saving this row clears the flag on any other row.")}
              </div>
            </div>
          </label>
        </div>
        <footer className="border-t border-border px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="btn">{t("Cancel")}</button>
          <button onClick={save} disabled={saving} className="btn btn-primary inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin"/> : <Save size={13}/>}
            {t("Save")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}</label>
      {children}
    </div>
  );
}
