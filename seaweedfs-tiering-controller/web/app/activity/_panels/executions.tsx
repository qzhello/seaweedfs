"use client";
import { History } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import useSWR from "swr";
import Link from "next/link";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function ExecutionsPanel() {
  const { t } = useT();
  const { data, isLoading, isValidating, mutate } = useSWR("/api/v1/tasks?limit=200", fetcher);
  const recent = (data?.items || []).filter((item: any) => item.status !== "pending" && item.status !== "approved");
  const pg = usePagination<any>(recent, 20);
  return (
    <div className="space-y-6">
      {/* Toolbar only — page title lives in the tab strip */}
      <div className="flex items-center justify-end">
        <RefreshButton loading={isValidating} onClick={() => mutate()}/>
      </div>
      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={6} headers={[t("Task"), t("Volume"), t("Action"), t("Status"), t("Created")]}/>
        ) : (<>
        <table className="grid">
          <thead><tr><th>{t("Task")}</th><th>{t("Volume")}</th><th>{t("Action")}</th><th>{t("Status")}</th><th>{t("Created")}</th></tr></thead>
          <tbody>
            {pg.slice.map((item: any) => (
              <tr key={item.id}>
                <td className="font-mono text-xs"><Link href={`/executions/${item.id}`} className="text-accent hover:underline">{item.id.slice(0,8)}…</Link></td>
                <td className="font-mono">{item.volume_id}</td>
                <td><span className="badge">{item.action}</span></td>
                <td><span className="badge">{item.status}</span></td>
                <td className="text-muted text-xs">{relTime(item.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length === 0 && <EmptyState icon={History} title={t("No executions yet")} hint={t("When tasks run, their step-by-step output and AI postmortem land here.")}/>}
        {recent.length > 0 && <Pagination {...pg}/>}
        </>)}
      </section>
    </div>
  );
}
