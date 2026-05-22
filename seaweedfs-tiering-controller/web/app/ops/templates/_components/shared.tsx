"use client";

import { AlertTriangle, Eye, ShieldAlert } from "lucide-react";
import type { OpsStep, OpsTemplate } from "@/lib/api";

// Risk colour tokens shared by editor, run dialog, and approval card.
// Lifted out of page.tsx so split components stay in sync on one
// source of truth.
export const RISK_BADGE = {
  read:        "badge border-emerald-400/40 text-emerald-300",
  mutate:      "badge border-amber-400/40 text-amber-300",
  destructive: "badge border-rose-400/40 text-rose-300",
} as const;

export const RISK_ICON = {
  read:        <Eye size={12} />,
  mutate:      <AlertTriangle size={12} />,
  destructive: <ShieldAlert size={12} />,
} as const;

// stepsOf flattens whatever the server returned for `steps` into an
// OpsStep[]. The Go side serialises jsonb as embedded JSON — pgx
// returns it as a JSON-encoded string, so we may receive either an
// array or its string form. Normalise both shapes here so callers
// don't care.
export function stepsOf(t: OpsTemplate | null | undefined): OpsStep[] {
  if (!t) return [];
  if (Array.isArray(t.steps)) return t.steps;
  try { return JSON.parse(String(t.steps)) as OpsStep[]; } catch { return []; }
}

// Step run status shared between RunDialog and ApprovalCard. Lives
// here so both files can import without one importing the other.
export type StepStatus = "pending" | "running" | "done" | "error";

// PendingConfirm — payload of one paused-on-approval step emitted by
// the interactive runner over SSE. Field names mirror the wire JSON
// so we don't need a translation layer.
export interface PendingConfirm {
  index: number;
  command: string;
  reason?: string;
  /** Server-rendered args with the AI's proposed values substituted.
   *  Useful as the initial display, but it freezes the AI proposal —
   *  the UI re-renders args_template against the live form values to
   *  keep the preview in sync with what the operator is editing. */
  rendered_args: string;
  /** Raw step args with `{{X}}` placeholders intact. */
  args_template: string;
  proposed_vars: Record<string, string>;
  /** Markdown rationale from the LLM. */
  analysis?: string;
  required_vars: string[];
  /** Catalog risk class ("readonly" | "mutate" | "destructive" | ""). */
  risk?: string;
}
