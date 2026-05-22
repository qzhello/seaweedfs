"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  LayoutDashboard, Database, Server, ShieldCheck, ListChecks, History, Sparkles, ScrollText, CalendarDays, SlidersHorizontal, Cloud, Activity, Bell, ShieldAlert, Tv, Wrench, Layers, Brain, Languages, Terminal, Box, Boxes, PanelLeftClose, PanelLeftOpen, Key, Scale, Plus, Trash2, HardDriveDownload, Copy, LogOut, UserCog, Zap, Eraser, ChevronDown, Grid3x3, Search, Star, X, FileCode2, FolderTree, Thermometer, DollarSign, Network, Recycle, Tags, LayoutTemplate, Shuffle,
  type LucideIcon,
} from "lucide-react";
import { useCaps } from "@/lib/caps-context";
import { useRunningCounts } from "@/lib/use-running-counts";

type NavItem = { href: string; label: string; icon: LucideIcon; cap?: string };
type NavGroup = { label: string; items: NavItem[] };

// Nav groups follow the operator's mental model. Each group is ONE
// concept — kept deliberately small so the rail scans top-down:
//   Overview     — read-only big picture
//   Storage      — the resources you browse (clusters → files → backends)
//   S3           — the S3 gateway subsystem
//   Insights     — analysis & reporting: heat, cohort, cost
//   Operations   — the "do things" surface: shell, playbooks, maintenance
//   Automation   — policies, lifecycle, skills, schedule
//   Activity     — what the system is doing / has done
//   Monitoring   — passive watchers: durability, health, alerts, safety
//   AI           — provider config + learning insights
//   System       — meta config + audit
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
  // Storage holds only the resources an operator browses day to day —
  // analysis views (temperature, cohort, cost) live under Insights, and
  // maintenance jobs (drain, check-disk, path-migrate) under Operations.
  {
    label: "Storage",
    items: [
      { href: "/clusters",    label: "Clusters",     icon: Server,     cap: "cluster.read" },
      { href: "/volumes",     label: "Volumes",      icon: Database,   cap: "volume.read" },
      { href: "/ec",          label: "EC",           icon: Grid3x3,    cap: "volume.read" },
      { href: "/collections", label: "Collections",  icon: Boxes,      cap: "volume.read" },
      { href: "/files",       label: "File Browser", icon: FolderTree, cap: "file.read" },
      { href: "/backends",    label: "Backends",     icon: Cloud },
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
  // Insights = read-only analysis. Pulled out of the old overloaded
  // Storage group so "browse a resource" and "study the data" stay
  // visually separate.
  {
    label: "Insights",
    items: [
      { href: "/temperature", label: "Temperature", icon: Thermometer, cap: "volume.read" },
      { href: "/cohort",      label: "Cohort",      icon: Layers },
      { href: "/costs",       label: "Costs",       icon: DollarSign,  cap: "cost.read" },
      { href: "/pricing",     label: "Pricing",     icon: Tags,        cap: "cost.read" },
    ],
  },
  // One Operations group replaces the old confusing "Operations" +
  // "Cluster Ops" pair. Ordered: ad-hoc tooling first, then specific
  // maintenance jobs. Volume balance/grow/etc. stay on the /volumes
  // toolbar — operators reach them where they pick the cluster filter.
  {
    label: "Operations",
    items: [
      { href: "/ops",                  label: "Ops Console",      icon: Terminal,          cap: "ops.shell.read" },
      { href: "/ops/templates",        label: "Ops Templates",    icon: LayoutTemplate,    cap: "ops.templates.read" },
      { href: "/scripts",              label: "Analyzer Scripts", icon: FileCode2 },
      { href: "/clusters/check-disk",  label: "Check disk",       icon: HardDriveDownload, cap: "volume.check-disk" },
      { href: "/clusters/replication", label: "Replication",      icon: Copy,              cap: "cluster.replication.configure" },
      { href: "/path-migrate",         label: "Path migrate",     icon: Shuffle,           cap: "file.read" },
      { href: "/clusters/leave",       label: "Drain server",     icon: LogOut,            cap: "cluster.volume-server.leave" },
      { href: "/clusters/drains",      label: "Drain history",    icon: History,           cap: "cluster.volume-server.leave" },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/policies",  label: "Policies",  icon: ShieldCheck },
      { href: "/lifecycle", label: "Lifecycle", icon: Recycle },
      { href: "/skills",    label: "Skills",    icon: Wrench },
      { href: "/holidays",  label: "Holidays",  icon: CalendarDays },
    ],
  },
  {
    label: "Activity",
    items: [
      { href: "/tasks",      label: "Tasks",      icon: ListChecks },
      { href: "/executions", label: "Executions", icon: History },
    ],
  },
  // Durability (the read-only raft + replication health view) belongs
  // with the other passive watchers, not with Operations.
  {
    label: "Monitoring",
    items: [
      { href: "/raft",   label: "Durability", icon: Network,      cap: "volume.read" },
      { href: "/health", label: "Health",     icon: Activity },
      { href: "/alerts", label: "Alerts",     icon: Bell },
      { href: "/safety", label: "Safety",     icon: ShieldAlert },
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
// Pinned favourites — array of hrefs in user-chosen order. We keep order
// so the operator can star "in priority": newest pin lands at the top.
const NAV_FAVS_KEY = "tier.nav.favorites";

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

  // Live badges: poll task counters and render the result on the
  // matching nav rows. Pending tasks (need approval) get a warn pulse;
  // running tasks just an info count. /tasks shows the combined total
  // since the page itself filters between the two.
  const counts = useRunningCounts();
  const badgeFor = (href: string): NavRowBadge | undefined => {
    if (href === "/tasks") {
      const total = counts.pendingTasks + counts.runningTasks;
      if (total === 0) return undefined;
      return {
        count: total,
        tone: counts.pendingTasks > 0 ? "warn" : "info",
        title: counts.pendingTasks > 0
          ? `${counts.pendingTasks} ${t("pending approval")} · ${counts.runningTasks} ${t("running")}`
          : `${counts.runningTasks} ${t("running")}`,
      };
    }
    if (href === "/executions" && counts.runningExecutions > 0) {
      return {
        count: counts.runningExecutions,
        tone: "info",
        title: `${counts.runningExecutions} ${t("running")}`,
      };
    }
    if (href === "/ops/templates" && counts.runningOpsRuns > 0) {
      return {
        count: counts.runningOpsRuns,
        tone: "info",
        title: `${counts.runningOpsRuns} ${t("running")}`,
      };
    }
    return undefined;
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

  // --- Favourites -----------------------------------------------------
  // Array of pinned hrefs, persisted to localStorage. We resolve them
  // against visibleGroups each render so a favourite the operator lost
  // permission to (cap revoked) silently drops out of the list instead
  // of clicking through to a 403.
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_FAVS_KEY);
      if (raw) setFavorites(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
  }, []);
  const persistFavorites = (next: string[]) => {
    setFavorites(next);
    try { localStorage.setItem(NAV_FAVS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const isFavorite = (href: string) => favorites.includes(href);
  const toggleFavorite = (href: string) => {
    persistFavorites(
      favorites.includes(href)
        ? favorites.filter(h => h !== href)
        : [href, ...favorites] // newest first
    );
  };
  // Flat lookup so the favourites strip can render items in pinned order
  // without iterating groups for every hit.
  const itemByHref = (() => {
    const m = new Map<string, NavItem>();
    for (const g of visibleGroups) for (const it of g.items) m.set(it.href, it);
    return m;
  })();
  const favoriteItems = favorites
    .map(h => itemByHref.get(h))
    .filter((x): x is NavItem => !!x);

  // --- Search ---------------------------------------------------------
  // Plain substring match against the translated label OR the raw href
  // (so /clusters/check-disk is findable by typing "check"). Filtering
  // hides group headers and flattens the matches into one list so the
  // operator scans top-down without re-grouping.
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();
  const searchActive = trimmed.length > 0;
  const searchHits: NavItem[] = searchActive
    ? (() => {
        const out: NavItem[] = [];
        const seen = new Set<string>();
        for (const g of visibleGroups) {
          for (const it of g.items) {
            const labelTr = t(it.label).toLowerCase();
            if (
              labelTr.includes(trimmed) ||
              it.label.toLowerCase().includes(trimmed) ||
              it.href.toLowerCase().includes(trimmed)
            ) {
              if (!seen.has(it.href)) {
                seen.add(it.href);
                out.push(it);
              }
            }
          }
        }
        return out;
      })()
    : [];

  // Cmd/Ctrl+K focuses the search input. Standard pattern that
  // operators already expect from Linear / Vercel / GitHub.
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Auto-expand the rail if collapsed so the focused input is
        // actually visible.
        if (collapsed) {
          setCollapsedRaw(false);
          try { localStorage.setItem(NAV_COLLAPSED_KEY, "0"); } catch { /* ignore */ }
        }
        // Defer focus to the next tick so the input is mounted (in
        // case we just expanded).
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed]);

  return (
    <aside className={cn(
      // Solid bg-panel (not translucent) so the rail visually anchors
      // to the page chrome instead of bleeding into content. Width
      // bumped to 64 — current 56 truncated several labels at 14px.
      "shrink-0 border-r border-border bg-panel min-h-screen flex flex-col transition-[width] duration-200",
      collapsed ? "w-14" : "w-64",
    )}>
      {/* --- Brand block ---------------------------------------------
          A small accent-colored square as a logo gives the sidebar a
          visual anchor, replacing the previous pure-text header that
          looked like body copy. Brand + collapse button share a row
          with consistent vertical padding so the rail aligns with
          the page topbar height (52px). */}
      <div className={cn(
        "flex items-center border-b border-border/60",
        collapsed ? "justify-center px-1 h-[52px]" : "justify-between px-3 h-[52px]",
      )}>
        {!collapsed && (
          <Link href="/" className="flex items-center gap-2 min-w-0 group">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-accent/15 text-accent shrink-0
                             group-hover:bg-accent/20 transition-colors">
              <Layers size={15}/>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold tracking-tight truncate leading-none">
                Tiering Console
              </span>
              <span className="block text-[10px] text-muted/80 tracking-wide mt-0.5">
                SeaweedFS · v0.1
              </span>
            </span>
          </Link>
        )}
        {collapsed && (
          <Link href="/" className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-accent/15 text-accent hover:bg-accent/20 transition-colors">
            <Layers size={16}/>
          </Link>
        )}
        {!collapsed && (
          <button
            onClick={toggleCollapsed}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-text hover:bg-panel2 transition-colors"
            title={t("Collapse sidebar")}
            aria-label={t("Collapse sidebar")}
          >
            <PanelLeftClose size={14}/>
          </button>
        )}
      </div>

      {/* Expand button gets its own row when collapsed, so the brand
          square stays clickable as the home link. */}
      {collapsed && (
        <button
          onClick={toggleCollapsed}
          className="mx-auto mt-1 inline-flex items-center justify-center w-8 h-7 rounded-md text-muted hover:text-text hover:bg-panel2 transition-colors"
          title={t("Expand sidebar")}
          aria-label={t("Expand sidebar")}
        >
          <PanelLeftOpen size={14}/>
        </button>
      )}

      {/* --- Search box --------------------------------------------- */}
      {/* Hidden in collapsed mode; Cmd+K auto-expands the rail and
          focuses this input. Filtering is purely client-side — the
          full catalog is tiny (~30 items) so we don't need anything
          fancier than substring. */}
      {!collapsed && (
        <div className="px-2.5 pt-2 pb-1">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted/70 pointer-events-none"/>
            <input
              id="nav-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter on a single hit → navigate. Removes "type to
                // narrow → mouse-click" friction on common searches.
                if (e.key === "Enter" && searchHits.length > 0) {
                  e.preventDefault();
                  router.push(searchHits[0].href);
                  setQuery("");
                  searchRef.current?.blur();
                }
              }}
              placeholder={t("Search…")}
              aria-label={t("Search navigation")}
              className="w-full h-9 pl-7 pr-12 rounded-lg bg-panel2 border border-border/60
                         text-[13px] placeholder:text-muted/50
                         focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20
                         transition-colors"
            />
            {/* Right side: a clear ✕ when there's a query, else a
                keyboard shortcut hint. The hint disappears once the
                input is in use, freeing the visual space for the
                clear control. */}
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {searchActive ? (
                <button
                  onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                  className="p-0.5 text-muted/60 hover:text-text rounded"
                  aria-label={t("Clear search")}
                  title={t("Clear")}
                >
                  <X size={12}/>
                </button>
              ) : (
                <kbd className="hidden md:inline-flex items-center text-[9px] text-muted/50 border border-border/60 rounded px-1 py-0 leading-none font-mono">
                  ⌘K
                </kbd>
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- Nav body ------------------------------------------------ */}
      <nav className={cn(
        "flex flex-col flex-1 overflow-y-auto py-2",
        collapsed ? "gap-0.5 items-center px-1" : "gap-1 px-2",
      )}>
        {/* SEARCH RESULTS: replace groups with a flat list while a
            query is active. Empty state explains why nothing shows
            instead of leaving a blank rail. */}
        {searchActive && (
          <>
            <div className="px-2 mt-1 mb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted/75">
              {searchHits.length > 0
                ? `${t("Results")} (${searchHits.length})`
                : t("No matches")}
            </div>
            {searchHits.map((it) => {
              const active = it.href === activeHref;
              return (
                <NavRow
                  key={it.href}
                  item={it}
                  active={active}
                  collapsed={false}
                  favorite={isFavorite(it.href)}
                  onToggleFav={() => toggleFavorite(it.href)}
                  onWarm={warm}
                  t={t}
                  badge={badgeFor(it.href)}
                />
              );
            })}
            {searchHits.length === 0 && (
              <p className="px-2 text-[11px] text-muted/70 italic">
                {t("Nothing matched. Try a shorter keyword.")}
              </p>
            )}
          </>
        )}

        {/* FAVORITES strip — only when not searching and the operator
            has pinned something. Renders before normal groups so the
            shortcut is on top of every page load. */}
        {!searchActive && favoriteItems.length > 0 && (
          <div className={cn("flex flex-col w-full", collapsed ? "items-center" : "")}>
            {!collapsed && (
              <div className="flex items-center gap-1.5 px-2 mt-2 mb-1
                              text-[10px] font-semibold uppercase tracking-[0.09em] text-muted/75">
                <Star size={10} className="text-amber-300 fill-amber-300/80"/>
                <span>{t("Favorites")}</span>
              </div>
            )}
            {favoriteItems.map((it) => {
              const active = it.href === activeHref;
              return (
                <NavRow
                  key={`fav-${it.href}`}
                  item={it}
                  active={active}
                  collapsed={collapsed}
                  favorite
                  onToggleFav={() => toggleFavorite(it.href)}
                  onWarm={warm}
                  t={t}
                  badge={badgeFor(it.href)}
                />
              );
            })}
            {!collapsed && (
              <div className="mt-1 mb-1 mx-2 h-px bg-border/40" aria-hidden/>
            )}
          </div>
        )}

        {/* Regular grouped list — hidden during search. */}
        {!searchActive && visibleGroups.map((g, gi) => {
          const hasActive = g.items.some(it => it.href === activeHref);
          const folded = !collapsed && !hasActive && isGroupCollapsed(g.label);
          return (
            <div key={g.label} className={cn(
              "flex flex-col w-full",
              collapsed ? "items-center" : "",
              collapsed && gi > 0 ? "before:content-[''] before:block before:w-6 before:h-px before:bg-border/60 before:mt-1 before:mb-1" : "",
            )}>
              {!collapsed && (
                <button
                  onClick={() => toggleGroup(g.label)}
                  className={cn(
                    "group/hdr flex items-center justify-between w-full px-2 mb-1 pb-0.5",
                    // Generous top gap = the main visual separator between
                    // groups; the first group hugs the search box.
                    gi === 0 ? "mt-1.5" : "mt-4",
                    "text-[10px] font-semibold uppercase tracking-[0.09em] text-muted/75",
                    "hover:text-text transition-colors",
                  )}
                  title={folded ? t("Expand group") : t("Collapse group")}
                >
                  <span>{t(g.label)}</span>
                  <ChevronDown
                    size={11}
                    className={cn(
                      "opacity-0 group-hover/hdr:opacity-60 transition-all",
                      folded ? "-rotate-90 opacity-60" : "",
                    )}
                  />
                </button>
              )}
              {!folded && g.items.map((it) => {
                const active = it.href === activeHref;
                return (
                  <NavRow
                    key={it.href}
                    item={it}
                    active={active}
                    collapsed={collapsed}
                    favorite={isFavorite(it.href)}
                    onToggleFav={() => toggleFavorite(it.href)}
                    onWarm={warm}
                    t={t}
                    badge={badgeFor(it.href)}
                  />
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* --- Footer: compact language pill --------------------------- */}
      <div className={cn(
        "border-t border-border/60",
        collapsed ? "px-1 py-2" : "px-3 py-2.5",
      )}>
        <button
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          className={cn(
            "rounded-lg text-[11px] text-muted hover:text-text hover:bg-panel2 transition-colors",
            collapsed
              ? "w-10 h-8 mx-auto flex items-center justify-center"
              : "w-full flex items-center gap-2 px-2 py-1.5",
          )}
          title={lang === "zh" ? "Switch to English" : "切换到中文"}>
          {collapsed ? (
            <Languages size={14}/>
          ) : (
            <>
              <Languages size={13} className="opacity-80"/>
              <span className="flex items-center gap-1">
                <span className={cn("transition-colors", lang === "zh" ? "text-accent font-medium" : "")}>中文</span>
                <span className="text-muted/40">/</span>
                <span className={cn("transition-colors", lang === "en" ? "text-accent font-medium" : "")}>EN</span>
              </span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

// NavRow is the per-link row used in three places: regular groups,
// favourites strip, and search results. Pulled out so all three render
// identically (same hover behaviour, same accent rail, same pin button).
// The star button is hover-revealed on the right edge; clicking it
// toggles favourite without navigating away.
// Per-row live counter (running tasks, pending approvals, ...). Rendered
// as a small pill at the right edge — replaces the star button when
// non-zero so the row never grows wider than the rail.
export interface NavRowBadge {
  count: number;
  tone: "info" | "warn" | "danger";
  title?: string;
}

function NavRow({
  item, active, collapsed, favorite, onToggleFav, onWarm, t, badge,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  favorite: boolean;
  onToggleFav: () => void;
  onWarm: (href: string) => void;
  t: (k: string) => string;
  badge?: NavRowBadge;
}) {
  const I = item.icon;
  return (
    <div className={cn(
      "relative group w-full",
      collapsed ? "flex justify-center" : "",
    )}>
      <Link
        href={item.href}
        prefetch
        onMouseEnter={() => onWarm(item.href)}
        onFocus={() => onWarm(item.href)}
        onTouchStart={() => onWarm(item.href)}
        title={collapsed ? t(item.label) : undefined}
        className={cn(
          "relative rounded-lg text-[13px] transition-colors duration-150",
          collapsed
            ? "flex items-center justify-center w-10 h-9"
            // Trailing right padding leaves room for the absolutely-
            // positioned star button so the label never collides with it.
            : "flex items-center gap-2.5 pl-3 pr-7 h-9 w-full",
          active
            ? "bg-accent/15 text-accent font-medium"
            : "text-muted/90 hover:bg-panel2/80 hover:text-text"
        )}
      >
        {active && (
          <span
            aria-hidden
            className="absolute left-0 top-2 bottom-2 w-[3px] bg-accent rounded-full"
          />
        )}
        <I size={15} className={active ? "" : "opacity-80"}/>
        {!collapsed && <span className="truncate">{t(item.label)}</span>}
        {/* Live badge: shows running/pending counts. In collapsed mode
            it becomes a dot in the corner so the operator still sees
            "something is going on". */}
        {badge && badge.count > 0 && (
          collapsed ? (
            <span
              aria-label={badge.title}
              className={cn(
                "absolute top-1 right-1 w-1.5 h-1.5 rounded-full",
                badge.tone === "danger" ? "bg-danger" : badge.tone === "warn" ? "bg-warning" : "bg-accent",
              )}
            />
          ) : (
            <span
              title={badge.title}
              className={cn(
                "ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-[18px] px-1.5",
                "text-[10px] font-semibold rounded-full tabular-nums",
                badge.tone === "danger" ? "bg-danger/15 text-danger" :
                badge.tone === "warn"   ? "bg-warning/15 text-warning" :
                                          "bg-accent/15 text-accent",
              )}
            >
              {badge.count > 99 ? "99+" : badge.count}
            </span>
          )
        )}
      </Link>
      {/* Pin / unpin star. Always visible when already favourited so
          the operator sees the state; otherwise hover-revealed to keep
          the rail visually quiet for unused rows. The button sits
          OUTSIDE the Link so its click doesn't accidentally navigate.
          Hidden when a live badge is showing — pinning collides
          visually with the counter pill. */}
      {!collapsed && !(badge && badge.count > 0) && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFav(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleFav(); } }}
          className={cn(
            "absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded transition-opacity",
            favorite
              ? "opacity-100 text-amber-300 hover:text-amber-200"
              : "opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted/60 hover:text-muted"
          )}
          title={favorite ? t("Unpin from favorites") : t("Pin to favorites")}
          aria-label={favorite ? t("Unpin from favorites") : t("Pin to favorites")}
          aria-pressed={favorite}
        >
          <Star size={12} className={favorite ? "fill-amber-300/80" : ""}/>
        </button>
      )}
    </div>
  );
}
