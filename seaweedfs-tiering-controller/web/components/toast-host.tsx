"use client";

// Visual host for the toast system in `lib/toast.tsx`. Mounted once
// at the root layout; reads from the module-level store via the
// useToasts() hook. Bottom-right stack, newest on top, slide+fade
// entry, click-to-dismiss.

import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-react";
import { useToasts, dismiss, type ToastTone } from "@/lib/toast";

const ICONS: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

const TONE_CLASS: Record<ToastTone, string> = {
  info:    "border-accent/40 bg-accent/10 text-accent",
  success: "border-success/40 bg-success/10 text-success",
  warn:    "border-warning/40 bg-warning/10 text-warning",
  error:   "border-danger/40 bg-danger/10 text-danger",
};

export function ToastHost() {
  const items = useToasts();
  if (items.length === 0) return null;
  return (
    <div
      // aria-live=polite: screen readers announce new toasts without
      // stealing focus. role=region keeps the stack discoverable in
      // the AT tree.
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2 max-w-sm pointer-events-none"
    >
      {items.map((m) => {
        const Icon = ICONS[m.tone];
        return (
          <div
            key={m.id}
            className={[
              "pointer-events-auto card border shadow-pop px-3 py-2 flex items-start gap-2 text-xs",
              "animate-in slide-in-from-right-4 fade-in duration-200",
              TONE_CLASS[m.tone],
            ].join(" ")}
          >
            <Icon size={14} className="mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-text">{m.title}</div>
              {m.body && (
                <div className="text-[11px] text-muted mt-0.5 whitespace-pre-wrap break-words">
                  {m.body}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(m.id)}
              className="text-muted hover:text-text shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
