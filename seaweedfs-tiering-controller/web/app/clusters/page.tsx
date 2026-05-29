"use client";
import { useClusters, api, type FleetHealthResult } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { HealthBadge } from "@/components/health-badge";
import { Plus, Trash2, Power, ExternalLink, Server, Pencil, X, Loader2, Activity } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";
import { confirm as confirmDlg } from "@/lib/confirm";
import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { KpiStrip } from "@/components/kpi-strip";

const DOMAINS = ["flight","train","hotel","car_rental","attraction","logs","finance","backup","other"];

function healthTone(status: string): "ok" | "warn" | "err" {
  return status === "green" ? "ok" : status === "red" ? "err" : "warn";
}

function healthLabel(status: string, t: (s: string) => string): string {
  switch (status) {
    case "green": return t("healthy");
    case "red": return t("down");
    case "skipped": return t("skipped");
    default: return t("warning");
  }
}

type ClusterRow = {
  id: string;
  name: string;
  master_addr: string;
  filer_addr: string;
  business_domain: string;
  description: string;
  grpc_tls: boolean;
  enabled: boolean;
  weed_bin_path?: string;
  filer_jwt?: string;
};

export default function ClustersPage() {
  const { t } = useT();
  const { data, mutate, isLoading, isValidating } = useClusters();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClusterRow | null>(null);
  const items: ClusterRow[] = data?.items || [];
  const pg = usePagination<ClusterRow>(items, 20);
  const loadingFirst = isLoading && !data;

  const [health, setHealth] = useState<Record<string, FleetHealthResult> | null>(null);
  const [healthSummary, setHealthSummary] = useState<{ green: number; yellow: number; red: number; skipped: number; total: number } | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function runFleetCheck() {
    setChecking(true);
    setHealthErr(null);
    try {
      const res = await api.fleetHealthCheck();
      const byId: Record<string, FleetHealthResult> = {};
      for (const r of res.results) byId[r.cluster_id] = r;
      setHealth(byId);
      setHealthSummary(res.summary);
    } catch (e) {
      setHealthSummary(null);
      setHealthErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  const openCreate = () => { setEditing(null); setOpen(true); };
  const openEdit = (c: ClusterRow) => { setEditing(c); setOpen(true); };

  return (
    <div className="space-y-6">
      <PageHeader title={t("Clusters")} subtitle={t("SeaweedFS clusters managed by this controller.")}/>
      <KpiStrip items={[
        { label: t("Registered"), value: items.length, tone: "muted" },
        { label: t("Enabled"),    value: items.filter(c => c.enabled).length, tone: "success" },
        { label: t("Disabled"),   value: items.filter(c => !c.enabled).length, tone: items.some(c => !c.enabled) ? "warning" : "muted" },
      ]}/>
      <PageToolbar
        actions={
          <>
            <RefreshButton loading={isValidating} onClick={() => mutate()}/>
            <button className="btn flex items-center gap-1.5" onClick={runFleetCheck} disabled={checking}>
              {checking ? <Loader2 size={14} className="animate-spin"/> : <Activity size={14}/>}
              {t("Check all")}
            </button>
            <button className="btn btn-primary flex items-center gap-1.5" onClick={openCreate}>
              <Plus size={14}/> {t("New cluster")}
            </button>
          </>
        }
      />

      {healthErr && (
        <div className="text-xs text-danger">{healthErr}</div>
      )}
      {healthSummary && (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <HealthBadge tone="ok">{healthSummary.green} {t("healthy")}</HealthBadge>
          {healthSummary.yellow > 0 && <HealthBadge tone="warn">{healthSummary.yellow} {t("warning")}</HealthBadge>}
          {healthSummary.red > 0 && <HealthBadge tone="err">{healthSummary.red} {t("down")}</HealthBadge>}
          {healthSummary.skipped > 0 && <span className="text-muted">{healthSummary.skipped} {t("skipped")}</span>}
        </div>
      )}

      <section className="card overflow-hidden">
        {loadingFirst ? (
          <TableSkeleton rows={5} headers={[t("Name"), t("Master"), t("weed binary"), t("Domain"), t("Status"), t("Health"), ""]}/>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Server}
            title={t("No clusters yet")}
            hint={t("Register a SeaweedFS master to start tiering.")}
            action={
              <button className="btn btn-primary flex items-center gap-1.5" onClick={openCreate}>
                <Plus size={14}/> {t("New cluster")}
              </button>
            }
          />
        ) : (
          <>
            <table className="grid">
              <thead><tr>
                <th>{t("Name")}</th>
                <th>{t("Master")}</th>
                <th>{t("weed binary")}</th>
                <th>{t("Domain")}</th>
                <th>{t("Status")}</th>
                <th>{t("Health")}</th>
                <th></th>
              </tr></thead>
              <tbody>
                {pg.slice.map(c => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.name}</td>
                    <td className="font-mono text-xs">{c.master_addr}</td>
                    <td className="font-mono text-[11px] text-muted truncate max-w-[240px]" title={c.weed_bin_path || t("global fallback")}>
                      {c.weed_bin_path || <span className="text-muted/60">{t("global")}</span>}
                    </td>
                    <td><span className="badge">{c.business_domain}</span></td>
                    <td>
                      <span className={`badge ${c.enabled ? "border-success/40 text-success" : "border-muted text-muted"}`}>
                        <Power size={12}/> {c.enabled ? t("Enabled") : t("Disabled")}
                      </span>
                    </td>
                    <td>
                      {health?.[c.id] ? (
                        <HealthBadge
                          tone={healthTone(health[c.id].status)}
                          title={health[c.id].reasons.length ? health[c.id].reasons.join("\n") : t("All signals OK")}
                        >
                          {healthLabel(health[c.id].status, t)}
                        </HealthBadge>
                      ) : (
                        <span className="text-muted/60">—</span>
                      )}
                    </td>
                    <td className="text-right space-x-1 whitespace-nowrap">
                      <Link href={`/clusters/${c.id}`} className="btn">
                        <ExternalLink size={14}/> {t("Open")}
                      </Link>
                      <button className="btn" onClick={() => openEdit(c)} title={t("Edit")}>
                        <Pencil size={14}/>
                      </button>
                      <button className="btn btn-danger"
                        onClick={async () => {
                          // type-to-confirm: deleting a cluster wipes its metadata
                          // and all associated tasks — high blast radius, force the
                          // operator to type the cluster name.
                          const ok = await confirmDlg.danger({
                            title: t("Delete cluster {name}?").replace("{name}", c.name),
                            body: t("This removes the cluster from the controller. SeaweedFS data is not touched, but tasks, alerts and history tied to this cluster will be detached."),
                            typeToConfirm: c.name,
                            confirmLabel: t("Delete"),
                          });
                          if (!ok) return;
                          await api.deleteCluster(c.id);
                          await mutate();
                        }}
                        title={t("Delete")}>
                        <Trash2 size={14}/>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pg}/>
          </>
        )}
      </section>

      {open && (
        <ClusterDialog
          initial={editing}
          onClose={() => setOpen(false)}
          onSaved={async () => { await mutate(); setOpen(false); }}
        />
      )}
    </div>
  );
}

function ClusterDialog({ initial, onClose, onSaved }: {
  initial: ClusterRow | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useT();
  const isEdit = !!initial;
  const [d, setD] = useState({
    id: initial?.id,
    name: initial?.name ?? "",
    master_addr: initial?.master_addr ?? "",
    filer_addr: initial?.filer_addr ?? "",
    business_domain: initial?.business_domain ?? "other",
    description: initial?.description ?? "",
    grpc_tls: initial?.grpc_tls ?? false,
    enabled: initial?.enabled ?? true,
    weed_bin_path: initial?.weed_bin_path ?? "",
    filer_jwt: initial?.filer_jwt ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!d.name.trim() || !d.master_addr.trim()) {
      setErr(t("Name and master address are required."));
      return;
    }
    setSaving(true);
    setErr("");
    try {
      await api.upsertCluster(d);
      await onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-4 md:p-8"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-3xl my-auto shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">
              {isEdit ? t("Edit cluster") : t("New cluster")}
            </h2>
            <p className="text-xs text-muted mt-0.5">{t("Register a SeaweedFS master so the controller can talk to it.")}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-panel2 text-muted hover:text-text" title={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className="px-5 py-5 grid grid-cols-2 gap-3 max-h-[70vh] overflow-y-auto">
          <Field label={t("Name")} hint={t("Short identifier, e.g. prod-flight-bj.")}>
            <input className="input w-full" value={d.name}
              placeholder="prod-flight-bj"
              onChange={e => setD({ ...d, name: e.target.value })}/>
          </Field>
          <Field label={t("Primary business domain")} hint={t("Used by cohort baselines and routing.")}>
            <select className="input w-full" value={d.business_domain}
              onChange={e => setD({ ...d, business_domain: e.target.value })}>
              {DOMAINS.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field label={t("Master address")} hint={t("host:9333 of the SeaweedFS master.")}>
            <input className="input w-full font-mono text-xs"
              placeholder="10.0.0.1:9333"
              value={d.master_addr}
              onChange={e => setD({ ...d, master_addr: e.target.value })}/>
          </Field>
          <Field label={t("Filer address")} hint={t("Optional. host:8888 of the SeaweedFS filer.")}>
            <input className="input w-full font-mono text-xs"
              placeholder="10.0.0.1:8888"
              value={d.filer_addr}
              onChange={e => setD({ ...d, filer_addr: e.target.value })}/>
          </Field>
          <Field label={t("Description")} hint={t("Free-form note shown in the cluster list.")}>
            <input className="input w-full" value={d.description}
              onChange={e => setD({ ...d, description: e.target.value })}/>
          </Field>
          <Field
            label={t("weed binary path (optional)")}
            hint={t("Absolute path used for `weed shell` calls against this cluster. Leave empty to fall back to $WEED_BIN / $PATH.")}>
            <input className="input w-full font-mono text-xs"
              placeholder="/opt/seaweedfs/weed/weed"
              value={d.weed_bin_path}
              onChange={e => setD({ ...d, weed_bin_path: e.target.value })}/>
          </Field>
          <Field
            label={t("Filer JWT signing secret (optional)")}
            hint={t("Paste the `key =` value from security.toml under [jwt.filer_signing] (or [jwt.signing] for older builds). The controller signs a short-lived HS256 token per request — DO NOT paste a JWT here, paste the HMAC secret. Location: typically /etc/seaweedfs/security.toml or ~/.seaweedfs/security.toml on the filer host; check `weed filer -h` for the active path. Leave empty if your filer has JWT disabled.")}>
            <input className="input w-full font-mono text-xs"
              type="password"
              placeholder="abc123def456…  (HMAC secret, not a JWT)"
              value={d.filer_jwt}
              onChange={e => setD({ ...d, filer_jwt: e.target.value })}/>
          </Field>
          <div className="col-span-2 flex items-center gap-6 text-sm border-t border-border pt-3 mt-1">
            <label className="flex items-center gap-2 select-none">
              <input type="checkbox" checked={d.grpc_tls}
                onChange={e => setD({ ...d, grpc_tls: e.target.checked })}/>
              <span>{t("Use gRPC TLS")}</span>
            </label>
            <label className="flex items-center gap-2 select-none">
              <input type="checkbox" checked={d.enabled}
                onChange={e => setD({ ...d, enabled: e.target.checked })}/>
              <span>{t("Enabled")}</span>
            </label>
          </div>
          {err && (
            <div className="col-span-2 text-xs text-danger">{err}</div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-panel2/30">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" onClick={save}
            disabled={saving || !d.name.trim() || !d.master_addr.trim()}>
            {saving ? t("Saving…") : isEdit ? t("Save changes") : t("Create cluster")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted leading-relaxed">{hint}</span>}
    </label>
  );
}
