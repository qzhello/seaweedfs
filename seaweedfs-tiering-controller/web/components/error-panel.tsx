"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

// ErrorPanel is the shared visual for an inline "this failed, here's
// why" message. Replaces ad-hoc <div className="card border-danger…">
// blocks scattered across the codebase. Three sizes match common
// callsites: inline (chip-sized, beside a button), block (full-width
// card), and section (full card with title + optional retry).
//
// Pass `error` as either a string or an unknown — we'll narrow safely
// so callers don't need to repeat the same `instanceof Error` dance.

export interface ErrorPanelProps {
  error: unknown;
  /** Visual layout. block = card row, inline = compact chip, section = full card. */
  variant?: "block" | "inline" | "section";
  /** Optional title shown above the message; only renders for `section`. */
  title?: string;
  /** Optional retry action — renders a small button next to the message. */
  onRetry?: () => void;
  /** Override the retry button label. */
  retryLabel?: string;
  /** Extra Tailwind class names. */
  className?: string;
}

function messageOf(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  // Some fetchers surface { error: string } / { message: string }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") return o.message;
  }
  return String(err);
}

export function ErrorPanel({
  error, variant = "block", title, onRetry, retryLabel, className = "",
}: ErrorPanelProps) {
  const msg = messageOf(error);
  if (!msg) return null;

  if (variant === "inline") {
    return (
      <div className={`inline-flex items-center gap-2 px-2 py-1 rounded-md bg-danger/10 border border-danger/30 text-danger text-xs ${className}`}>
        <AlertTriangle size={12}/>
        <span className="font-mono break-all">{msg}</span>
        {onRetry && (
          <button onClick={onRetry} className="text-danger/80 hover:text-danger inline-flex items-center gap-1">
            <RefreshCw size={11}/> {retryLabel ?? "Retry"}
          </button>
        )}
      </div>
    );
  }

  if (variant === "section") {
    return (
      <section className={`card p-4 border-danger/40 bg-danger/5 ${className}`}>
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0"/>
          <div className="flex-1 min-w-0">
            {title && <div className="text-sm font-medium text-danger">{title}</div>}
            <div className="text-xs text-danger/90 font-mono whitespace-pre-wrap break-words mt-0.5">{msg}</div>
          </div>
          {onRetry && (
            <button onClick={onRetry} className="btn border-danger/40 text-danger hover:bg-danger/10 inline-flex items-center gap-1.5 shrink-0">
              <RefreshCw size={12}/> {retryLabel ?? "Retry"}
            </button>
          )}
        </div>
      </section>
    );
  }

  // block: the most common shape — one card row, no title.
  return (
    <div className={`card p-3 border-danger/40 bg-danger/10 text-danger text-xs flex items-start gap-2 ${className}`}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0"/>
      <div className="flex-1 font-mono whitespace-pre-wrap break-words">{msg}</div>
      {onRetry && (
        <button onClick={onRetry} className="text-danger/80 hover:text-danger inline-flex items-center gap-1 shrink-0">
          <RefreshCw size={11}/> {retryLabel ?? "Retry"}
        </button>
      )}
    </div>
  );
}
