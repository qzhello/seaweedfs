"use client";

// Lightweight toast system. One module-level store + a hook so any
// component can call `toast.success(...)` without prop-drilling or
// wrapping the tree in yet another provider. Auto-dismisses after 4s
// (or duration override) and de-dupes identical messages fired within
// the same tick.

import { useEffect, useState } from "react";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastMessage {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  duration?: number;
}

type Listener = (msgs: ReadonlyArray<ToastMessage>) => void;

let counter = 0;
let messages: ToastMessage[] = [];
const listeners = new Set<Listener>();

function emit() {
  const snapshot = messages;
  listeners.forEach((l) => l(snapshot));
}

function push(tone: ToastTone, title: string, body?: string, duration = 4000) {
  // de-dupe identical title+tone within a 500ms window — common when a
  // mutation fires twice (React strict mode, double-click, etc.).
  const now = Date.now();
  const recent = messages.find(
    (m) => m.tone === tone && m.title === title && now - m.id < 500
  );
  if (recent) return recent.id;
  const id = ++counter + now * 1000;
  const msg: ToastMessage = { id, tone, title, body, duration };
  messages = [...messages, msg];
  emit();
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

export function dismiss(id: number) {
  messages = messages.filter((m) => m.id !== id);
  emit();
}

export const toast = {
  info:    (title: string, body?: string, duration?: number) => push("info", title, body, duration),
  success: (title: string, body?: string, duration?: number) => push("success", title, body, duration),
  warn:    (title: string, body?: string, duration?: number) => push("warn", title, body, duration),
  error:   (title: string, body?: string, duration?: number) => push("error", title, body, duration ?? 6000),
  // Best-effort error toast for unknown rejections — narrows `unknown`
  // to a readable string so callers don't have to.
  fromError(err: unknown, fallback = "Action failed") {
    const msg =
      err instanceof Error ? err.message
      : typeof err === "string" ? err
      : fallback;
    return push("error", fallback, msg, 6000);
  },
  dismiss,
};

export function useToasts(): ReadonlyArray<ToastMessage> {
  const [snap, setSnap] = useState<ReadonlyArray<ToastMessage>>(messages);
  useEffect(() => {
    const l: Listener = (m) => setSnap(m);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return snap;
}
