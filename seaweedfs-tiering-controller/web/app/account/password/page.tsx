"use client";

// Change password. Used both for the forced first-login rotation
// (must_reset_password=true) and for ad-hoc password changes after
// that. The backend skips the current-password check while the
// must_reset flag is set, but the UI always shows the field so the
// experience stays consistent.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { setToken } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";

export default function PasswordPage() {
  const { t } = useT();
  const { me } = useCaps();
  const router = useRouter();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const forced = !!me?.must_reset_password;

  const submit = async () => {
    if (next.length < 6) { setErr(t("Password must be at least 6 characters")); return; }
    if (next !== confirm) { setErr(t("New password does not match confirmation")); return; }
    setBusy(true); setErr(null);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("tier.token") : null;
      const r = await fetch("/api/v1/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ current_password: cur, new_password: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j?.error || `${t("Server error")}: ${r.status}`);
        return;
      }
      const { token: newToken } = await r.json() as { token: string };
      // Backend rotated the api_token; swap to it so subsequent requests
      // don't 401, then full-reload so SWR / caps caches re-resolve.
      setToken(newToken);
      window.location.href = "/";
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 max-w-lg">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <KeyRound size={16}/> {t("Change password")}
        </h1>
        {forced ? (
          <p className="text-xs text-amber-300 mt-1 inline-flex items-center gap-1">
            <AlertTriangle size={12}/> {t("You must set a new password before continuing.")}
          </p>
        ) : (
          <p className="text-xs text-muted mt-1">{t("Rotate the password for your account.")}</p>
        )}
      </header>

      <section className="card p-5 space-y-3">
        {!forced && (
          <Field label={t("Current password")}>
            <input type="password" autoFocus value={cur} onChange={e => setCur(e.target.value)} className="input w-full"/>
          </Field>
        )}
        <Field label={t("New password")} hint={t("At least 6 characters.")}>
          <input type="password" autoFocus={forced} value={next} onChange={e => setNext(e.target.value)} className="input w-full"/>
        </Field>
        <Field label={t("Confirm new password")}>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} className="input w-full"/>
        </Field>
        {err && <div className="text-xs text-rose-300 inline-flex items-center gap-1"><AlertTriangle size={12}/> {err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          {!forced && <button className="btn" onClick={() => router.back()} disabled={busy}>{t("Cancel")}</button>}
          <button className="btn bg-accent/15 text-accent border-accent/40 inline-flex items-center gap-1.5"
                  onClick={submit}
                  disabled={busy || !next || !confirm || (!forced && !cur)}>
            {busy ? <Loader2 size={14} className="animate-spin"/> : <ShieldCheck size={14}/>}
            {t("Save password")}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted/80">{hint}</p>}
    </div>
  );
}
