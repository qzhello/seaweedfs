"use client";
import { Nav } from "@/components/nav";
import { ClusterSwitcher } from "@/components/cluster-switcher";
import { ClusterProvider } from "@/lib/cluster-context";
import { usePathname } from "next/navigation";
import { SWRConfig } from "swr";

// Shell renders the sidebar+main layout for everything except the /login page.
// SWRConfig at this level is what makes page navigation feel instant: every
// useXxx() hook in the app reuses the same cache, falls back to stale data
// while revalidating, and stops re-fetching every time the tab regains focus.
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path?.startsWith("/login") || path?.startsWith("/wall")) {
    return <>{children}</>;
  }
  return (
    <SWRConfig
      value={{
        // Show cached data immediately on navigation; revalidate in the
        // background so the screen doesn't flash a Loading… spinner every
        // time the user switches pages.
        keepPreviousData: true,
        // Tab focus re-fetches are a major source of perceived lag on a
        // dashboard that lives in a browser tab all day. Per-hook
        // refreshInterval still drives freshness.
        revalidateOnFocus: false,
        revalidateIfStale: true,
        // Coalesce duplicate requests within a 5s window — pages that mount
        // the same hook twice (subcomponents) should only hit the network
        // once.
        dedupingInterval: 5_000,
        // Auto-retry transient 5xx without thrashing.
        errorRetryCount: 2,
        errorRetryInterval: 3_000,
      }}
    >
      <ClusterProvider>
        <div className="flex min-h-screen">
          <Nav />
          <div className="flex-1 flex flex-col min-w-0">
            {/* Sticky topbar: global cluster picker on the right so the
                operator can switch context from any page without
                hunting for a per-page select. */}
            <header className="sticky top-0 z-30 border-b border-border bg-panel/80 backdrop-blur px-8 py-2 flex items-center justify-end">
              <ClusterSwitcher />
            </header>
            <main className="flex-1 px-8 py-6 max-w-[1600px]">{children}</main>
          </div>
        </div>
      </ClusterProvider>
    </SWRConfig>
  );
}
