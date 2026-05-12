"use client";
import { useBackends, api } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { useEffect, useState } from "react";
import { Cloud, Plus, Trash2, Plug, CheckCircle2, XCircle, Lock, AlertTriangle, X } from "lucide-react";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";

const KINDS = ["s3", "oss", "obs", "cos", "minio"];
const ENCRYPTIONS = ["", "sse-s3", "sse-kms", "aes256"];

export default function BackendsPage() {
  const { t } = useT();
  const { data, mutate, isLoading, isValidating } = useBackends();
  const [editing, setEditing] = useState<any | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const items: any[] = data?.items || [];
  const pg = usePagination<any>(items, 20);
  const loadingFirst = isLoading && !data;

  const blank = {
    name: "", kind: "s3", endpoint: "", region: "", bucket: "", path_prefix: "",
    access_key_id: "", secret_access_key: "",
    encryption: "", force_path_style: false, notes: "", enabled: true,
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <Cloud size={20}/> {t("Storage backends")}
          </h1>
          <p className="text-sm text-muted mt-1">{t("S3-compatible destinations the controller can upload cold-tier data to.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <button className="btn btn-primary flex items-center gap-1.5" onClick={() => setEditing(blank)}>
            <Plus size={14}/> {t("New backend")}
          </button>
        </div>
      </header>

      <section className="card p-4 text-xs text-muted flex items-start gap-2">
        <Lock size={14} className="text-warning shrink-0 mt-0.5"/>
        <span>
          {t("Access keys are encrypted with")} <span className="kbd">AES-256-GCM</span>;
          {" "}{t("the master key comes from")} <span className="kbd">TIER_MASTER_KEY</span>{" "}
          {t("(32 bytes hex). The console never shows plaintext keys.")}
        </span>
      </section>

      <section className="card overflow-hidden">
        {loadingFirst ? (
          <TableSkeleton rows={5} headers={[t("Name"), t("Kind"), t("Endpoint"), t("Bucket"), t("Secret"), t("Last test"), ""]}/>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Cloud}
            title={t("No backends configured")}
            hint={t("Wire an S3/GCS bucket so cold-tier moves have a destination.")}
            action={
              <button className="btn btn-primary flex items-center gap-1.5" onClick={() => setEditing(blank)}>
                <Plus size={14}/> {t("New backend")}
              </button>
            }
          />
        ) : (
          <>
            <table className="grid">
              <thead><tr>
                <th>{t("Name")}</th>
                <th>{t("Kind")}</th>
                <th>{t("Endpoint")}</th>
                <th>{t("Bucket")}</th>
                <th>{t("Secret")}</th>
                <th>{t("Last test")}</th>
                <th></th>
              </tr></thead>
              <tbody>
                {pg.slice.map((b: any) => (
                  <tr key={b.id}>
                    <td>
                      <div className="font-medium">{b.name}</div>
                      {b.notes && <div className="text-xs text-muted">{b.notes}</div>}
                    </td>
                    <td><span className="badge">{b.kind}</span></td>
                    <td className="font-mono text-xs">{b.endpoint}</td>
                    <td className="font-mono text-xs">{b.bucket}</td>
                    <td>
                      {b.has_secret
                        ? <span className="badge border-success/40 text-success"><Lock size={10}/> {t("stored")}</span>
                        : <span className="badge border-warning/40 text-warning"><AlertTriangle size={10}/> {t("none")}</span>}
                    </td>
                    <td>
                      {b.last_test_at ? (
                        <div className="text-xs">
                          {b.last_test_ok
                            ? <span className="text-success flex items-center gap-1"><CheckCircle2 size={12}/> {t("ok")}</span>
                            : <span className="text-danger flex items-center gap-1" title={b.last_test_error}><XCircle size={12}/> {t("failed")}</span>}
                          <span className="text-muted">{relTime(b.last_test_at)}</span>
                        </div>
                      ) : <span className="text-muted text-xs">—</span>}
                      {testResult[b.id] && (
                        <div className={`text-xs mt-1 flex items-center gap-1 ${testResult[b.id].ok ? "text-success" : "text-danger"}`}>
                          {testResult[b.id].ok ? <><CheckCircle2 size={12}/> {t("just now")}</> : testResult[b.id].error}
                        </div>
                      )}
                    </td>
                    <td className="text-right space-x-1 whitespace-nowrap">
                      <button className="btn" disabled={testing === b.id} onClick={async () => {
                        setTesting(b.id);
                        try {
                          const r = await api.testBackend(b.id);
                          setTestResult({ ...testResult, [b.id]: { ok: r.ok, error: r.error } });
                          mutate();
                        } finally { setTesting(null); }
                      }}><Plug size={12}/> {t("Test")}</button>
                      <button className="btn" onClick={() => setEditing({ ...b, secret_access_key: "" })}>{t("Edit")}</button>
                      <button className="btn btn-danger" onClick={async () => {
                        if (confirm(t("Delete backend {name}?").replace("{name}", b.name))) {
                          await api.deleteBackend(b.id);
                          mutate();
                        }
                      }}><Trash2 size={12}/></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pg}/>
          </>
        )}
      </section>

      {editing && <EditModal initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); mutate(); }}/>}
    </div>
  );
}

function EditModal({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [d, setD] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = !!initial.id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-4 md:p-8"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-3xl my-auto shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">
              {isEdit ? t("Edit backend") : t("New backend")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {t("Connect an S3-compatible bucket where cold volumes can be offloaded.")}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-panel2 text-muted hover:text-text" title={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className="px-5 py-5 grid grid-cols-2 gap-3 max-h-[70vh] overflow-y-auto">
          <Field label={t("Name")} hint={t("Short identifier referenced from policies.")}>
            <input className="input w-full" value={d.name}
              placeholder="s3.default"
              onChange={e => setD({ ...d, name: e.target.value })}/>
          </Field>
          <Field label={t("Kind")} hint={t("Backend protocol or vendor.")}>
            <select className="input w-full" value={d.kind}
              onChange={e => setD({ ...d, kind: e.target.value })}>
              {KINDS.map(k => <option key={k}>{k}</option>)}
            </select>
          </Field>

          <Field label={t("Endpoint")} hint={t("Host of the S3 endpoint, without scheme.")} wide>
            <input className="input w-full font-mono text-xs"
              placeholder="oss-cn-hangzhou.aliyuncs.com"
              value={d.endpoint} onChange={e => setD({ ...d, endpoint: e.target.value })}/>
          </Field>

          <Field label={t("Region")} hint={t("AWS region or vendor equivalent.")}>
            <input className="input w-full" placeholder="cn-hangzhou" value={d.region}
              onChange={e => setD({ ...d, region: e.target.value })}/>
          </Field>
          <Field label={t("Bucket")} hint={t("Target S3 bucket name.")}>
            <input className="input w-full font-mono text-xs" value={d.bucket}
              placeholder="seaweed-cold-archive"
              onChange={e => setD({ ...d, bucket: e.target.value })}/>
          </Field>

          <Field label={t("Path prefix")} hint={t("Optional path prefix inside the bucket.")}>
            <input className="input w-full font-mono text-xs" placeholder="cold/2026"
              value={d.path_prefix} onChange={e => setD({ ...d, path_prefix: e.target.value })}/>
          </Field>
          <Field label={t("Encryption")} hint={t("Server-side encryption mode.")}>
            <select className="input w-full" value={d.encryption}
              onChange={e => setD({ ...d, encryption: e.target.value })}>
              {ENCRYPTIONS.map(k => <option key={k} value={k}>{k || "—"}</option>)}
            </select>
          </Field>

          <Field label={t("Access Key ID")} hint={t("Stored encrypted, never echoed back.")}>
            <input className="input w-full font-mono text-xs" value={d.access_key_id}
              onChange={e => setD({ ...d, access_key_id: e.target.value })}/>
          </Field>
          <Field
            label={isEdit ? t("Secret (leave empty to keep existing)") : t("Secret Access Key")}
            hint={isEdit ? t("Already encrypted on disk. Type a new value to rotate.") : t("Stored encrypted; never displayed again.")}>
            <input type="password" className="input w-full font-mono text-xs"
              value={d.secret_access_key} onChange={e => setD({ ...d, secret_access_key: e.target.value })}/>
          </Field>

          <Field label={t("Notes")} hint={t("Free-form note shown in the backend list.")} wide>
            <input className="input w-full" value={d.notes}
              onChange={e => setD({ ...d, notes: e.target.value })}/>
          </Field>

          <div className="flex items-center gap-6 col-span-2 border-t border-border pt-3 mt-1 text-sm">
            <label className="flex items-center gap-2 select-none">
              <input type="checkbox" checked={d.force_path_style}
                onChange={e => setD({ ...d, force_path_style: e.target.checked })}/>
              <span>{t("Force path style (MinIO)")}</span>
            </label>
            <label className="flex items-center gap-2 select-none">
              <input type="checkbox" checked={d.enabled}
                onChange={e => setD({ ...d, enabled: e.target.checked })}/>
              <span>{t("Enabled")}</span>
            </label>
          </div>

          {err && <div className="col-span-2 text-danger text-sm">{err}</div>}
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-panel2/30">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={async () => {
            setSaving(true); setErr(null);
            try {
              await api.upsertBackend(d);
              onSaved();
            } catch (e: any) {
              setErr(e.message);
            } finally { setSaving(false); }
          }}>
            {saving ? t("Saving…") : isEdit ? t("Save changes") : t("Create backend")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
      <span className="text-xs font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted leading-relaxed">{hint}</span>}
    </label>
  );
}
