"use client";

import Link from "next/link";
import { CardSkeleton } from "@/components/table-skeleton";
import { useParams, usePathname } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { useClusterTopology } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
// Context + hook live in a sibling file because Next.js disallows
// any non-default export on a layout module.
import { ClusterDetailContext } from "./_context";

interface ClusterTab {
  // Label is an i18n key — wrapped at render time so the active language
  // change re-renders the tab strip without remounting the whole layout.
  label: string;
  href: string;
  visible: (args: { loading: boolean; has: (cap: string) => boolean; isAdmin: boolean }) => boolean;
}

const TABS: ClusterTab[] = [
  { label: "Overview", href: "", visible: ({ loading, has }) => loading || has("cluster.read") },
  { label: "Topology", href: "/topology", visible: ({ loading, has }) => loading || has("cluster.read") },
  { label: "Masters", href: "/masters", visible: ({ loading, has }) => loading || has("cluster.read") },
  { label: "Filers", href: "/filers", visible: ({ loading, has }) => loading || has("cluster.read") },
  { label: "EC Shards", href: "/ec-shards", visible: ({ loading, has }) => loading || has("volume.read") },
  { label: "File browser", href: "/files", visible: ({ loading, has }) => loading || has("file.read") },
  { label: "Tags", href: "/tags", visible: ({ loading, has }) => loading || has("cluster.read") },
  { label: "Shell", href: "/shell", visible: ({ loading, isAdmin }) => loading || isAdmin },
];

export default function ClusterDetailLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { me, has, loading: capsLoading } = useCaps();
  const { t } = useT();
  const basePath = `/clusters/${id}`;
  const isOverviewRoute = pathname === basePath;
  const isTopologyRoute = pathname === `${basePath}/topology`;
  const isMastersRoute = pathname === `${basePath}/masters`;
  const isFilersRoute = pathname === `${basePath}/filers`;
  const isEcShardsRoute = pathname === `${basePath}/ec-shards`;
  const isFilesRoute = pathname?.startsWith(`${basePath}/files`) ?? false;
  const isTagsRoute = pathname === `${basePath}/tags`;
  const isShellRoute = pathname === `${basePath}/shell`;
  const isReadSurface = isOverviewRoute || isTopologyRoute || isMastersRoute || isFilersRoute || isEcShardsRoute || isFilesRoute || isTagsRoute;
  const canReadCluster = has("cluster.read");
  const canUseShell = me?.role === "admin";
  const shouldFetchTopology = !capsLoading && ((isReadSurface && canReadCluster) || (isShellRoute && canUseShell));
  const { data, error } = useClusterTopology(shouldFetchTopology ? id : undefined);

  if (!data && !error) {
    if (capsLoading) return null;
    if (isReadSurface && !canReadCluster) {
      return <div className="card p-6 text-sm text-muted">{t("You do not have permission to view this cluster.")}</div>;
    }
    if (isShellRoute && !canUseShell) {
      return <div className="card p-6 text-sm text-muted">{t("You do not have permission to use this shell console.")}</div>;
    }
    return <CardSkeleton lines={3} title={false}/>;
  }

  const cluster = data?.cluster || null;
  const topology = data?.topology || null;
  const visibleTabs = TABS.filter((tab) => tab.visible({
    loading: capsLoading,
    has,
    isAdmin: me?.role === "admin",
  }));

  return (
    <ClusterDetailContext.Provider value={{ id, cluster, topology, topologyError: error ? String(error) : null }}>
      <div className="space-y-6">
        <Breadcrumb items={[{ label: "Clusters", href: "/clusters" }, { label: cluster?.name || id }]}/>
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-base font-semibold tracking-tight">{cluster?.name || id}</h1>
            <p className="text-sm text-muted font-mono">{cluster?.master_addr || "master unavailable"}</p>
          </div>
          {cluster && (
            <div className="flex items-center gap-2">
              <span className="badge">{cluster.business_domain}</span>
              <span className={`badge ${cluster.enabled ? "border-success/40 text-success" : "border-muted text-muted"}`}>
                {cluster.enabled ? t("enabled") : t("disabled")}
              </span>
            </div>
          )}
        </header>

        <nav className="border-b border-border/60">
          <div className="flex items-center gap-2 overflow-x-auto pb-2">
            {visibleTabs.map((tab) => {
              const href = `${basePath}${tab.href}`;
              const active = tab.href ? pathname === href : pathname === basePath;
              const className = `inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors ${active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"}`;
              return (
                <Link key={tab.label} href={href} className={className}>
                  {t(tab.label)}
                </Link>
              );
            })}
          </div>
        </nav>

        {children}
      </div>
    </ClusterDetailContext.Provider>
  );
}
