"use client";

// Bucket governance editor — sets the controller-side owner / responsible
// person, their user key, and the data-lifecycle retention period for one
// bucket. Retention drives the "expired data" lifecycle scan.

import { useEffect, useState, type ReactNode } from "react";
import { X, Loader2, Save } from "lucide-react";
import { api, type BucketRow } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface Props {
  clusterID: string;
  bucket: BucketRow;
  onClose: (saved: boolean) => void;
}

export function GovernanceDialog({ clusterID, bucket, onClose }: Props) {
  const { t } = useT();
  const [ownerName, setOwnerName] = useState(bucket.owner_name ?? "");
  const [userKey, setUserKey] = useState(bucket.owner_user_key ?? "");
  const [retention, setRetention] = useState(
    bucket.retention_days != null ? String(bucket.retention_days) : "",
  );
  const [notes, setNotes] = useState(bucket.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const trimmed = retention.trim();
    let days: number | null = null;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setErr(t("Retention must be a positive number of days."));
        return;
      }
      days = Math.floor(n);
    }
    setSaving(true);
    setErr("");
    api.upsertBucketGovernance(clusterID, bucket.name, {
      owner_name: ownerName.trim(),
      owner_user_key: userKey.trim(),
      retention_days: days,
      notes: notes.trim(),
    })
      .then(() => onClose(true))
      .catch(e => { setErr((e as Error).message); setSaving(false); });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(false); }}>
      <div className="card w-full max-w-md p-0">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            {t("Bucket governance")}: <span className="font-mono">{bucket.name}</span>
          </h2>
          <button onClick={() => onClose(false)} aria-label={t("Close")} className="text-muted hover:text-text">
            <X size={14}/>
          </button>
        </header>

        <div className="p-4 space-y-3">
          <Field label={t("Owner / responsible person")}>
            <input className="input" value={ownerName} onChange={e => setOwnerName(e.target.value)}
              placeholder={t("name or email")}/>
          </Field>
          <Field label={t("User key (UK)")}>
            <input className="input font-mono" value={userKey} onChange={e => setUserKey(e.target.value)}
              placeholder={t("employee id / S3 identity")}/>
          </Field>
          <Field
            label={t("Retention (days)")}
            hint={t("Data older than this is flagged expired by the lifecycle scan. Empty = no retention.")}>
            <input className="input" type="number" min={0} value={retention}
              onChange={e => setRetention(e.target.value)} placeholder="—"/>
          </Field>
          <Field label={t("Notes")}>
            <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)}/>
          </Field>
          {err && (
            <div className="card p-2 text-xs text-danger border-danger/40 bg-danger/5">{err}</div>
          )}
        </div>

        <footer className="border-t border-border px-5 py-3 flex justify-end gap-2">
          <button onClick={() => onClose(false)} className="btn">{t("Cancel")}</button>
          <button onClick={save} disabled={saving}
            className="btn btn-primary inline-flex items-center gap-1.5 disabled:opacity-50">
            {saving ? <Loader2 size={12} className="animate-spin"/> : <Save size={12}/>}
            {t("Save")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted/70">{hint}</span>}
    </label>
  );
}
