"use client";

// Email + password login. POST /api/v1/auth/login returns a fresh
// token that we store in localStorage; subsequent requests use it as
// a bearer. The seed admin's default credentials are admin@local /
// admin — the backend forces a password rotation on first use via
// must_reset_password, which the root layout reads to redirect into
// /account/password.

import { useState } from "react";
import { setToken } from "@/lib/api";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Languages } from "lucide-react";
import { useT } from "@/lib/i18n";

export default function LoginPage() {
  const { t, lang, setLang } = useT();
  const [email, setEmail] = useState("admin@local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!r.ok) {
        setErr(r.status === 401 ? t("Invalid credentials") : `${t("Server error")}: ${r.status}`);
        return;
      }
      const { token } = await r.json() as { token: string };
      setToken(token);
      // The root layout reads /auth/me on mount and will redirect to
      // /account/password if must_reset_password is true; otherwise
      // we land at the dashboard.
      router.replace("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card p-8 w-[420px] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-accent"/>
            <h1 className="text-lg font-semibold tracking-tight">{t("Tiering Console")}</h1>
          </div>
          {/* Language toggle on the login page itself so users can flip
              before they have a session. The useT hook persists the
              choice in localStorage. */}
          <button
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            className="text-[11px] text-muted hover:text-text inline-flex items-center gap-1"
            title={lang === "zh" ? "Switch to English" : "切换到中文"}
          >
            <Languages size={12}/>
            <span className={lang === "zh" ? "text-accent" : ""}>中</span>
            <span className="text-muted/60">/</span>
            <span className={lang === "en" ? "text-accent" : ""}>EN</span>
          </button>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          {t("Sign in to continue. On first boot the default credentials are")}{" "}
          <span className="kbd">admin@local</span> / <span className="kbd">admin</span>
          {t(" — you will be asked to set a new password immediately.")}
        </p>
        <div className="space-y-2">
          <input
            autoFocus
            className="input w-full text-sm"
            placeholder={t("email")}
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <input
            type="password"
            className="input w-full text-sm"
            placeholder={t("password")}
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        </div>
        {err && <div className="text-danger text-xs">{err}</div>}
        <button className="btn btn-primary w-full inline-flex items-center justify-center gap-1.5"
                onClick={submit}
                disabled={busy || !email.trim() || !password}>
          {busy ? <Loader2 size={14} className="animate-spin"/> : null}
          {t("Sign in")}
        </button>
      </div>
    </div>
  );
}
