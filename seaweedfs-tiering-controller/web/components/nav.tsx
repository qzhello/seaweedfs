"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  LayoutDashboard, Database, Server, ShieldCheck, ListChecks, History, Sparkles, ScrollText, CalendarDays, SlidersHorizontal, Cloud, Activity, Bell, ShieldAlert, Tv, Wrench, Layers, Brain, Languages, Terminal, Box, Boxes,
  type LucideIcon,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

// Nav groups follow the operator's mental model:
//   Overview      — read-only big picture
//   Storage       — primary resources you manage on a daily basis
//   Operations    — *do things* surface: ad-hoc shell + saved playbooks
//   Automation    — policies, skills, schedule
//   Activity      — what the system is doing / has done
//   Monitoring    — passive watchers + alerts + safety
//   AI            — provider config + learning insights
//   System        — meta config + audit
//
// Order within a group goes from most-frequently-used to least.
const GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/",     label: "Dashboard", icon: LayoutDashboard },
      { href: "/wall", label: "NOC Wall",  icon: Tv },
    ],
  },
  {
    label: "Storage",
    items: [
      { href: "/clusters",    label: "Clusters",    icon: Server },
      { href: "/volumes",     label: "Volumes",     icon: Database },
      { href: "/buckets",     label: "Buckets",     icon: Box },
      { href: "/collections", label: "Collections", icon: Boxes },
      { href: "/backends",    label: "Backends",    icon: Cloud },
      { href: "/cohort",      label: "Cohort",      icon: Layers },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/ops",           label: "Ops Console",   icon: Terminal },
      { href: "/ops/templates", label: "Ops Templates", icon: Sparkles },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/policies", label: "Policies", icon: ShieldCheck },
      { href: "/skills",   label: "Skills",   icon: Wrench },
      { href: "/holidays", label: "Holidays", icon: CalendarDays },
    ],
  },
  {
    label: "Activity",
    items: [
      { href: "/tasks",      label: "Tasks",      icon: ListChecks },
      { href: "/executions", label: "Executions", icon: History },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { href: "/health", label: "Health", icon: Activity },
      { href: "/alerts", label: "Alerts", icon: Bell },
      { href: "/safety", label: "Safety", icon: ShieldAlert },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/ai-config",   label: "AI Config",   icon: Sparkles },
      { href: "/ai-learning", label: "AI Learning", icon: Brain },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: SlidersHorizontal },
      { href: "/audit",    label: "Audit",    icon: ScrollText },
    ],
  },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const { lang, setLang, t } = useT();
  // Routes we've already asked Next to compile/prefetch this session. In
  // dev mode <Link> does NOT prefetch, so the first click on a route eats
  // the on-demand webpack/Turbopack compile cost (~300–1500ms). We bypass
  // that by calling router.prefetch ourselves the moment the user hovers a
  // nav item — by the time they click, the chunk is ready.
  const warmed = useRef<Set<string>>(new Set());

  // Also warm the most common routes ~200ms after first paint so even a
  // direct click (no hover) is cheap. We delay to keep first-paint fast.
  useEffect(() => {
    const tid = setTimeout(() => {
      ["/", "/clusters", "/volumes", "/tasks", "/executions", "/skills"].forEach(href => {
        if (!warmed.current.has(href)) {
          warmed.current.add(href);
          router.prefetch(href);
        }
      });
    }, 200);
    return () => clearTimeout(tid);
  }, [router]);

  const warm = (href: string) => {
    if (warmed.current.has(href)) return;
    warmed.current.add(href);
    router.prefetch(href);
  };

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-panel/60 backdrop-blur min-h-screen p-3 flex flex-col">
      <div className="px-3 py-4">
        <div className="text-sm font-semibold tracking-tight">Tiering Console</div>
        <div className="text-xs text-muted">SeaweedFS · v0.1</div>
      </div>
      <nav className="flex flex-col gap-3 flex-1 overflow-y-auto">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div className="px-3 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
              {t(g.label)}
            </div>
            {g.items.map((it) => {
              const active = path === it.href || (it.href !== "/" && path.startsWith(it.href));
              const I = it.icon;
              return (
                <Link key={it.href} href={it.href} prefetch
                  onMouseEnter={() => warm(it.href)}
                  onFocus={() => warm(it.href)}
                  onTouchStart={() => warm(it.href)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                    active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                  )}>
                  <I size={16} />
                  {t(it.label)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      {/* Language toggle pinned to the bottom of the sidebar. */}
      <div className="mt-3 px-1">
        <button
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted hover:text-text hover:bg-panel2 transition-colors"
          title={lang === "zh" ? "Switch to English" : "切换到中文"}>
          <Languages size={14}/>
          <span className={lang === "zh" ? "text-accent" : ""}>中</span>
          <span className="text-muted">/</span>
          <span className={lang === "en" ? "text-accent" : ""}>EN</span>
        </button>
      </div>
    </aside>
  );
}
