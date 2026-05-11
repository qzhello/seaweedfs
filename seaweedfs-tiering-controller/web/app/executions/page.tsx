"use client";
import { History } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import useSWR from "swr";
import Link from "next/link";
import { relTime } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export default function ExecutionsList() {
  const { data, isLoading, isValidating, mutate } = useSWR("/api/v1/tasks?limit=200", fetcher);
  const recent = (data?.items || []).filter((t: any) => t.status !== "pending" && t.status !== "approved");
  const pg = usePagination<any>(recent, 20);
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Executions</h1>
        <RefreshButton loading={isValidating} onClick={() => mutate()}/>
      </header>
      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={6} headers={["Task", "Volume", "Action", "Status", "Created"]}/>
        ) : (<>
        <table className="grid">
          <thead><tr><th>Task</th><th>Volume</th><th>Action</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {pg.slice.map((t: any) => (
              <tr key={t.id}>
                <td className="font-mono text-xs"><Link href={`/executions/${t.id}`} className="text-accent hover:underline">{t.id.slice(0,8)}…</Link></td>
                <td className="font-mono">{t.volume_id}</td>
                <td><span className="badge">{t.action}</span></td>
                <td><span className="badge">{t.status}</span></td>
                <td className="text-muted text-xs">{relTime(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length === 0 && <EmptyState icon={History} title="No executions yet" hint="When tasks run, their step-by-step output and AI postmortem land here."/>}
        {recent.length > 0 && <Pagination {...pg}/>}
        </>)}
      </section>
    </div>
  );
}
