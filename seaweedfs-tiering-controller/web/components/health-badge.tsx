import type { ReactNode } from "react";

export type HealthBadgeTone = "ok" | "warn" | "err";

export interface HealthBadgeProps {
  tone: HealthBadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}

const TONE_CLASS: Record<HealthBadgeTone, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  warn: "border-warning/40 bg-warning/10 text-warning",
  err: "border-danger/40 bg-danger/10 text-danger",
};

export function HealthBadge({ tone, children, className = "", title }: HealthBadgeProps) {
  return (
    <span
      className={`badge inline-flex items-center gap-1 ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`}
      title={title}
    >
      {children}
    </span>
  );
}
