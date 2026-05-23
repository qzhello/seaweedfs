"use client";

// Themed replacement for window.confirm(). Promise-based so call sites
// can keep their if-not-confirm-return shape: just `await confirm(...)`
// instead of `confirm(...)`. The host (components/confirm-host.tsx)
// renders one modal at a time; concurrent calls queue.
//
// Why not a context provider: we want it callable from event handlers
// inside any component without prop-drilling or hook gymnastics. A
// module-level store mirrors the toast system already in lib/toast.tsx.

import { useEffect, useState } from "react";

export type ConfirmTone = "danger" | "warning" | "default";

export interface ConfirmRequest {
  id: number;
  title: string;
  body?: string;
  // Word the user has to type before the primary button enables. Useful
  // for genuinely destructive things ("delete-cluster-prod"). Omit for
  // ordinary confirmations.
  typeToConfirm?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type Pending = ConfirmRequest & { resolve: (v: boolean) => void };

let counter = 0;
let queue: Pending[] = [];
const listeners = new Set<(q: ReadonlyArray<Pending>) => void>();

function emit() {
  const snapshot = queue;
  listeners.forEach((l) => l(snapshot));
}

export function useConfirmQueue(): ReadonlyArray<Pending> {
  const [snap, setSnap] = useState<ReadonlyArray<Pending>>(queue);
  useEffect(() => {
    const l = (q: ReadonlyArray<Pending>) => setSnap(q);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return snap;
}

function open(req: Omit<ConfirmRequest, "id">): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = ++counter + Date.now() * 1000;
    queue = [...queue, { id, tone: "default", ...req, resolve }];
    emit();
  });
}

export function resolveConfirm(id: number, value: boolean) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  queue = queue.filter((q) => q.id !== id);
  emit();
  item.resolve(value);
}

// Public API — shaped like toast.* so it's easy to remember.
export const confirm = Object.assign(
  (req: Omit<ConfirmRequest, "id">) => open(req),
  {
    danger: (req: Omit<ConfirmRequest, "id" | "tone">) =>
      open({ ...req, tone: "danger" }),
    warning: (req: Omit<ConfirmRequest, "id" | "tone">) =>
      open({ ...req, tone: "warning" }),
  }
);
