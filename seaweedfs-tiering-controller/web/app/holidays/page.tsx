"use client";
import { useHolidays } from "@/lib/api";
import { CalendarDays, ShieldAlert } from "lucide-react";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";

export default function HolidaysPage() {
  const { data, mutate, isLoading, isValidating } = useHolidays();
  const inFreeze = data?.freeze_active;
  const items: any[] = data?.items || [];
  const pg = usePagination<any>(items, 20);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold tracking-tight flex items-center gap-2"><CalendarDays size={20}/> Holiday calendar (CN)</h1>
        <div className="flex items-center gap-2">
          {inFreeze && (
            <div className="badge border-warning/40 text-warning">
              <ShieldAlert size={12}/> Freeze active: {data.freeze_holiday}
            </div>
          )}
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

      <section className="card p-5 text-sm text-muted">
        During the pre/post windows of each holiday the executor **auto-pauses** all migration tasks to avoid IO jitter at peak.
        Each holiday's <span className="kbd">pre_window_days</span> / <span className="kbd">post_window_days</span> is tunable via SQL.
      </section>

      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={5} headers={["Date", "Name", "Pre window", "Post window", "Notes"]}/>
        ) : (<>
        <table className="grid">
          <thead><tr><th>Date</th><th>Name</th><th>Pre window</th><th>Post window</th><th>Notes</th></tr></thead>
          <tbody>
            {pg.slice.map((h: any) => (
              <tr key={h.date}>
                <td className="font-mono">{h.date.slice(0,10)}</td>
                <td className="font-medium">{h.name}</td>
                <td>{h.pre_window_days} days</td>
                <td>{h.post_window_days} days</td>
                <td className="text-muted text-xs">{h.notes || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 0 && <Pagination {...pg}/>}
        </>)}
      </section>
    </div>
  );
}
