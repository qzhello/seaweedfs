"use client";

import type { ReactNode } from "react";
import { useCaps } from "@/lib/caps-context";

interface CanProps {
  // Single capability or array — render children only if the user has
  // at least one. Empty / missing cap = always render (escape hatch).
  cap?: string;
  anyOf?: string[];
  // Optional fallback to render when the capability check fails. The
  // default is to render nothing, which is right for buttons but wrong
  // for pages — wrap pages in <Can fallback={<NoAccess/>}>.
  fallback?: ReactNode;
  children: ReactNode;
}

export function Can({ cap, anyOf, fallback = null, children }: CanProps) {
  const { has, hasAny, loading } = useCaps();
  // While the initial /auth/me request is in flight we suppress the UI
  // entirely — flashing a "no permission" placeholder on every page load
  // would be jarring and is rarely correct.
  if (loading) return null;
  if (!cap && !anyOf) return <>{children}</>;
  const ok = cap ? has(cap) : hasAny(...(anyOf || []));
  return <>{ok ? children : fallback}</>;
}
