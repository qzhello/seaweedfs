"use client";

// Capability context — fetches /auth/me once on boot and exposes
// `useCaps()` for components that need to gate UI by capability.
//
// The frontend never re-derives capabilities locally; whatever the
// backend says is authoritative. The wildcard "*" is honoured here
// just like in the Go middleware so an admin sees everything.

import {
  createContext, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";

interface Me {
  user_id: string;
  email: string;
  role: string;
  capabilities: string[];
  must_reset_password?: boolean;
}

interface CapsContextValue {
  me: Me | null;
  loading: boolean;
  has: (cap: string) => boolean;
  hasAny: (...caps: string[]) => boolean;
}

const Ctx = createContext<CapsContextValue>({
  me: null,
  loading: true,
  has: () => false,
  hasAny: () => false,
});

// Same relative base as lib/api.ts so this fetch hits the Next dev
// rewrite (and the same-origin production path) instead of trying to
// reach the controller directly on a hard-coded port.
const API_BASE = "/api/v1";

export function CapsProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (typeof window !== "undefined") {
          const token = window.localStorage.getItem("tier.token");
          if (token) headers["Authorization"] = `Bearer ${token}`;
        }
        const r = await fetch(`${API_BASE}/auth/me`, { headers });
        if (!r.ok) throw new Error(`${r.status}`);
        const data = (await r.json()) as Me;
        if (!cancelled) setMe(data);
      } catch {
        // Unauthenticated or backend down — degrade to an empty cap set.
        // Pages that need a capability will hide their UI; the user
        // can still see the login banner / debug endpoints.
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<CapsContextValue>(() => {
    const set = new Set(me?.capabilities || []);
    const has = (cap: string) => set.has("*") || set.has(cap);
    const hasAny = (...caps: string[]) => caps.some(has);
    return { me, loading, has, hasAny };
  }, [me, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCaps() {
  return useContext(Ctx);
}
