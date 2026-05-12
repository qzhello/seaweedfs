"use client";

// User menu — small chip in the topbar showing the logged-in user's
// email + role with a dropdown for sign-out. The controller's auth
// model is a long-lived bearer token in localStorage; signing out is
// a client-side concern (drop the token, reload). There is no
// server-side session to invalidate.

import { useEffect, useRef, useState } from "react";
import { LogOut, User as UserIcon, ChevronDown, KeyRound } from "lucide-react";
import Link from "next/link";
import { useCaps } from "@/lib/caps-context";
import { setToken } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function UserMenu() {
  const { t } = useT();
  const { me, loading } = useCaps();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere else. Using mousedown rather than
  // click so a click on a menu item lands before the menu closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const signOut = () => {
    setToken(null);
    // Reload so SWR caches drop and the next /auth/me call gets the
    // un-authed response. Cleaner than trying to clear React state
    // manually across providers.
    if (typeof window !== "undefined") window.location.href = "/";
  };

  if (loading && !me) {
    // Reserve space so the topbar doesn't visibly reflow when /auth/me lands.
    return <div className="h-8 w-32"/>;
  }
  if (!me) {
    return (
      <button onClick={signOut} className="btn text-xs inline-flex items-center gap-1.5" title={t("Not signed in")}>
        <UserIcon size={14}/> {t("Sign in")}
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md border border-border text-xs hover:bg-panel2/60 transition-colors"
        title={`${me.email} (${me.role})`}
      >
        <UserIcon size={14} className="text-muted"/>
        <span className="font-mono truncate max-w-[180px]">{me.email}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted">{me.role}</span>
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}/>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 card p-1 z-40 shadow-xl">
          <div className="px-3 py-2 border-b border-border/40">
            <div className="text-xs font-mono truncate">{me.email}</div>
            <div className="text-[10px] text-muted mt-0.5">
              {me.role} · {me.capabilities.length} {t("capabilities")}
            </div>
          </div>
          <Link
            href="/account/password"
            onClick={() => setOpen(false)}
            className="w-full text-left px-3 py-1.5 rounded text-xs inline-flex items-center gap-2 text-muted hover:text-text hover:bg-panel2/60"
          >
            <KeyRound size={12}/> {t("Change password")}
          </Link>
          <button
            onClick={signOut}
            className="w-full text-left px-3 py-1.5 rounded text-xs inline-flex items-center gap-2 text-rose-300 hover:bg-rose-400/10"
          >
            <LogOut size={12}/> {t("Sign out")}
          </button>
        </div>
      )}
    </div>
  );
}
