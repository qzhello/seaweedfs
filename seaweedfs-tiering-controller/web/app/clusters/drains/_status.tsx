"use client";

// Shared status badge for drain rows. Lives outside the page file
// because Next.js forbids non-default exports from `page.tsx`.

import { CheckCircle2, AlertTriangle, Clock, X, Loader2, RefreshCw } from "lucide-react";
import type { DrainStatus } from "@/lib/api";

export function StatusBadge({ status, t }: { status: DrainStatus; t: (k: string) => string }) {
  const map: Record<DrainStatus, { icon: React.ReactNode; cls: string; label: string }> = {
    pending:   { icon: <Clock size={10}/>,                              cls: "border-muted/40 text-muted",             label: t("pending") },
    running:   { icon: <Loader2 size={10} className="animate-spin"/>,   cls: "border-accent/40 text-accent",           label: t("running") },
    verifying: { icon: <RefreshCw size={10}/>,                          cls: "border-sky-400/40 text-sky-300",         label: t("verifying") },
    done:      { icon: <CheckCircle2 size={10}/>,                       cls: "border-emerald-400/40 text-emerald-300", label: t("done") },
    failed:    { icon: <AlertTriangle size={10}/>,                      cls: "border-rose-400/40 text-rose-300",       label: t("failed") },
    cancelled: { icon: <X size={10}/>,                                  cls: "border-amber-400/40 text-amber-300",     label: t("cancelled") },
  };
  const s = map[status];
  return (
    <span className={`badge text-[10px] inline-flex items-center gap-1 ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  );
}
