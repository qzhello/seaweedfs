"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  LayoutDashboard, Database, Server, ShieldCheck, ListChecks, History, Sparkles, ScrollText, CalendarDays, SlidersHorizontal, Cloud, Activity, Bell, ShieldAlert, Tv, Wrench, Layers, Brain, Languages, Terminal, Box, Boxes, PanelLeftClose, PanelLeftOpen, Key, Scale, Plus, Trash2, HardDriveDownload, Copy, LogOut, UserCog, Zap, Eraser, ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { useCaps } from "@/lib/caps-context";

type NavItem = { href: string; label: string; icon: LucideIcon; cap?: string };
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
      { href: "/clusters",    label: "Clusters",    icon: Server,  cap: "cluster.read" },
      { href: "/volumes",     label: "Volumes",     icon: Database, cap: "volume.read" },
      { href: "/collections", label: "Collections", icon: Boxes,    cap: "volume.read" },
      { href: "/backends",    label: "Backends",    icon: Cloud },
      { href: "/cohort",      label: "Cohort",      icon: Layers },
    ],
  },
  {
    label: "Volume Ops",
    items: [
      { href: "/volumes/balance",      label: "Balance",       icon: Scale,  cap: "volume.balance" },
      { href: "/volumes/grow",         label: "Grow",          icon: Plus,   cap: "volume.grow" },
      { href: "/volumes/delete-empty", label: "Delete empty",  icon: Trash2, cap: "volume.delete-empty" },
    ],
  },
  {
    label: "Cluster Ops",
    items: [
      { href: "/clusters/check-disk",  label: "Check disk",    icon: HardDriveDownload, cap: "volume.check-disk" },
      { href: "/clusters/replication", label: "Replication",   icon: Copy,              cap: "cluster.replication.configure" },
      { href: "/clusters/leave",       label: "Drain server",  icon: LogOut,            cap: "cluster.volume-server.leave" },
    ],
  },
  {
    label: "S3",
    items: [
      { href: "/buckets",            label: "Buckets",          icon: Box,        cap: "s3.read" },
      { href: "/s3/configure",       label: "Identities",       icon: UserCog,    cap: "s3.configure" },
      { href: "/s3/circuit-breaker", label: "Circuit breaker",  icon: Zap,        cap: "s3.circuit-breaker" },
      { href: "/s3/clean-uploads",   label: "Clean uploads",    icon: Eraser,     cap: "s3.clean-uploads" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/ops",           label: "Ops Console",   icon: Terminal,  cap: "ops.shell.read" },
      { href: "/ops/templates", label: "Ops Templates", icon: Sparkles,  cap: "ops.templates.read" },
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
      { href: "/ai-config",   label: "AI Config",   icon: Sparkles, cap: "ai.config" },
      { href: "/ai-learning", label: "AI Learning", icon: Brain,    cap: "ai.learning" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings",             label: "Settings",    icon: SlidersHorizontal, cap: "settings.read" },
      { href: "/settings/permissions", label: "Permissions", icon: Key,               cap: "permissions.write" },
      { href: "/audit",                label: "Audit",       icon: ScrollText,        cap: "audit.read" },
    ],
  },
];

const NAV_COLLAPSED_KEY = "tier.nav.collapsed";
const NAV_GROUP_COLLAPSED_KEY = "tier.nav.groups.collapsed";

// Groups that start collapsed by default. Overview/Storage stay open so
// the operator lands on something useful; everything else folds to keep
// the rail short on smaller laptops.
const DEFAULT_OPEN = new Set(["Overview", "Storage"]);

function loadCollapsedGroups(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(NAV_GROUP_COLLAPSED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const { lang, setLang, t } = useT();
  const { has, loading: capsLoading } = useCaps();

  // Hide nav items whose required capability the user lacks. Items
  // without a `cap` field are always visible (back-compat for pages
  // that haven't been gated yet). While /auth/me is still in flight
  // we show everything so the operator doesn't see a flash of an
  // empty rail.
  const visibleGroups = GROUPS
    .map(g => ({
      ...g,
      items: g.items.filter(it => !it.cap || capsLoading || has(it.cap)),
    }))
    .filter(g => g.items.length > 0);

  // Collapsed = icon-only rail. Surfaces like /volumes that open a
  // right-side drawer want all the horizontal room they can get, so
  // they dispatch `tier:nav-collapse` to request a fold. The operator
  // can also toggle it manually via the chevron at the top of the nav.
  const [collapsed, setCollapsedRaw] = useState(false);
  useEffect(() => {
    try { setCollapsedRaw(localStorage.getItem(NAV_COLLAPSED_KEY) === "1"); } catch { /* ignore */ }
    const handler = (e: Event) => {
      const v = (e as CustomEvent<{ collapsed: boolean }>).detail?.collapsed;
      if (typeof v === "boolean") {
        setCollapsedRaw(v);
        try { localStorage.setItem(NAV_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* ignore */ }
      }
    };
    window.addEventListener("tier:nav-collapse", handler);
    return () => window.removeEventListener("tier:nav-collapse", handler);
  }, []);
  // Per-group folding. A group is "collapsed" if either the saved map
  // says so, or there's no saved entry AND the group isn't in DEFAULT_OPEN.
  // Active route always forces its group open so the operator never has
  // to hunt for where they are.
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => { setGroupCollapsed(loadCollapsedGroups()); }, []);
  const isGroupCollapsed = (label: string) => {
    const v = groupCollapsed[label];
    if (typeof v === "boolean") return v;
    return !DEFAULT_OPEN.has(label);
  };
  const toggleGroup = (label: string) => {
    setGroupCollapsed(prev => {
      const next = { ...prev, [label]: !isGroupCollapsed(label) };
      try { localStorage.setItem(NAV_GROUP_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsedRaw(c => {
      const next = !c;
      try { localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };
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

  // Pick the single most-specific item to highlight. Naive startsWith
  // lights up both /volumes and /volumes/balance when the operator is
  // on /volumes/balance — confusing. We score every item by how long
  // its href matches the current path (treating "/" specially) and
  // pick the longest hit. Ties don't happen because hrefs are unique.
  const activeHref = (() => {
    let best = "";
    for (const g of visibleGroups) {
      for (const it of g.items) {
        const h = it.href;
        const matches = h === "/" ? path === "/" : (path === h || path?.startsWith(h + "/"));
        if (matches && h.length > best.length) best = h;
      }
    }
    return best;
  })();

  return (
    <aside className={cn(
      "shrink-0 border-r border-border bg-panel/60 backdrop-blur min-h-screen flex flex-col transition-[width] duration-150",
      collapsed ? "w-14 p-1" : "w-56 p-3",
    )}>
      <div className={cn("flex items-center justify-between", collapsed ? "px-1 py-3" : "px-3 py-4")}>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight truncate">Tiering Console</div>
            <div className="text-xs text-muted">SeaweedFS · v0.1</div>
          </div>
        )}
        <button
          onClick={toggleCollapsed}
          className="p-1 text-muted hover:text-text"
          title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
          aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
        >
          {collapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}
        </button>
      </div>
      <nav className={cn("flex flex-col flex-1 overflow-y-auto", collapsed ? "gap-1 items-center" : "gap-3")}>
        {visibleGroups.map((g) => {
          // A group containing the active route is force-opened so the
          // operator doesn't see their current location hidden behind a
          // chevron. In icon-rail mode every group is fully expanded since
          // there's no header to click anyway.
          const hasActive = g.items.some(it => it.href === activeHref);
          const folded = !collapsed && !hasActive && isGroupCollapsed(g.label);
          return (
            <div key={g.label} className={cn("flex flex-col w-full", collapsed ? "gap-0.5 items-center" : "gap-0.5")}>
              {!collapsed && (
                <button
                  onClick={() => toggleGroup(g.label)}
                  className="flex items-center justify-between w-full px-3 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70 hover:text-text"
                  title={folded ? t("Expand group") : t("Collapse group")}
                >
                  <span>{t(g.label)}</span>
                  <ChevronDown size={12} className={cn("transition-transform", folded ? "-rotate-90" : "")} />
                </button>
              )}
              {!folded && g.items.map((it) => {
                const active = it.href === activeHref;
                const I = it.icon;
                return (
                  <Link key={it.href} href={it.href} prefetch
                    onMouseEnter={() => warm(it.href)}
                    onFocus={() => warm(it.href)}
                    onTouchStart={() => warm(it.href)}
                    title={collapsed ? t(it.label) : undefined}
                    className={cn(
                      "rounded-md text-sm transition-colors",
                      collapsed
                        ? "flex items-center justify-center w-10 h-9"
                        : "flex items-center gap-2 px-3 py-1.5",
                      active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
                    )}>
                    <I size={16} />
                    {!collapsed && t(it.label)}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      {/* Language toggle pinned to the bottom of the sidebar. */}
      <div className={cn("mt-3", collapsed ? "px-1" : "px-1")}>
        <button
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          className={cn(
            "rounded-md border border-border text-xs text-muted hover:text-text hover:bg-panel2 transition-colors",
            collapsed
              ? "w-10 h-9 mx-auto flex items-center justify-center"
              : "w-full flex items-center justify-center gap-2 px-3 py-2",
          )}
          title={lang === "zh" ? "Switch to English" : "切换到中文"}>
          {collapsed ? (
            <span className="text-[11px]">{lang === "zh" ? "中" : "EN"}</span>
          ) : (
            <>
              <Languages size={14}/>
              <span className={lang === "zh" ? "text-accent" : ""}>中</span>
              <span className="text-muted">/</span>
              <span className={lang === "en" ? "text-accent" : ""}>EN</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
