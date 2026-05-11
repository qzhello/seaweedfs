// Standardized empty-state block. Pairs an icon, title and optional hint so
// every blank surface reads the same. Drop into any card body.
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  size?: "sm" | "md";
}

export function EmptyState({ icon: Icon = Inbox, title, hint, action, size = "md" }: EmptyStateProps) {
  const pad = size === "sm" ? "py-6" : "py-10";
  const iconSize = size === "sm" ? 20 : 28;
  return (
    <div className={`flex flex-col items-center justify-center text-center ${pad}`}>
      <div className="rounded-full bg-panel2 border border-border p-3 text-muted/70">
        <Icon size={iconSize}/>
      </div>
      <div className="mt-3 text-sm font-medium text-text">{title}</div>
      {hint && <div className="mt-1 text-xs text-muted max-w-md">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
