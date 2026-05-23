"use client";

// TabsLayout — page-level tabs for merged surfaces. URL-driven (?tab=key) so
// refresh/share preserve the active tab, and deep links like
// /activity?tab=executions point straight to the panel.
//
// Why URL state and not local: operators bookmark and share. A purely local
// tab loses the operator's place on refresh and makes link-sharing brittle.
// Why we re-mount panels on switch (instead of CSS hide+keep-alive): cleaner
// memory profile, no stale SWR caches firing background fetches for a panel
// the operator may not return to. The first-paint cost is negligible for our
// panel sizes.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export interface Tab {
  key: string;
  label: string;
  icon?: LucideIcon;
  // Translated badge text on the tab (e.g. running count). Kept as a string
  // so the tab strip stays styled consistently — no arbitrary nodes inside.
  badge?: string;
  panel: React.ReactNode;
}

interface TabsLayoutProps {
  // Title + subtitle render in the page header above the tab strip. Skip
  // either to keep the chrome short.
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  // Right-aligned slot in the header — refresh button, primary actions, etc.
  // Should usually be empty: per-tab actions belong inside the panel, not
  // above all tabs, to avoid stale context.
  toolbar?: React.ReactNode;
  tabs: Tab[];
  // Default active tab key when ?tab is missing. Falls back to the first tab.
  defaultTab?: string;
}

export function TabsLayout({ title, subtitle, toolbar, tabs, defaultTab }: TabsLayoutProps) {
  const { t } = useT();
  const search = useSearchParams();
  const requested = search?.get("tab") || "";
  const active = tabs.find((x) => x.key === requested)
    ?? tabs.find((x) => x.key === defaultTab)
    ?? tabs[0];

  // Build href preserving the rest of the query string so existing filters
  // survive a tab switch (e.g. /activity?status=failed&tab=tasks).
  const hrefFor = (key: string) => {
    const params = new URLSearchParams(search?.toString() || "");
    params.set("tab", key);
    return `?${params.toString()}`;
  };

  return (
    <div className="space-y-5">
      {(title || subtitle || toolbar) && (
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            {title && <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">{title}</h1>}
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          {toolbar}
        </header>
      )}

      {/* Tab strip — underline style. Border-aligned with the content card
          below so the active tab visually "owns" the panel beneath it. */}
      <div className="border-b border-border/60 -mb-px flex items-end gap-0.5 overflow-x-auto" role="tablist">
        {tabs.map((tab) => {
          const isActive = tab.key === active.key;
          const Icon = tab.icon;
          return (
            <Link
              key={tab.key}
              href={hrefFor(tab.key)}
              role="tab"
              aria-selected={isActive}
              scroll={false}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap",
                "border-b-2 transition-colors -mb-px",
                isActive
                  ? "border-accent text-accent font-medium"
                  : "border-transparent text-muted hover:text-text hover:border-border",
              )}
            >
              {Icon && <Icon size={14} className={isActive ? "" : "opacity-80"}/>}
              <span>{t(tab.label)}</span>
              {tab.badge && (
                <span className={cn(
                  "ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-[18px] px-1.5",
                  "text-[10px] font-semibold rounded-full tabular-nums",
                  isActive ? "bg-accent/15 text-accent" : "bg-panel2 text-muted",
                )}>
                  {tab.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Active panel. key= forces remount when switching so each panel
          starts fresh — no stale fetches from the previous tab. */}
      <div key={active.key} role="tabpanel">{active.panel}</div>
    </div>
  );
}
