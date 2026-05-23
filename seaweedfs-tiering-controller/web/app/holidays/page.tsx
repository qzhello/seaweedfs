"use client";
import { useHolidays } from "@/lib/api";
import { CalendarDays, ShieldAlert } from "lucide-react";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { useT } from "@/lib/i18n";

export default function HolidaysPage() {
  const { t } = useT();
  const { data, mutate, isLoading, isValidating } = useHolidays();
  const inFreeze = data?.freeze_active;
  const items: any[] = data?.items || [];
  const pg = usePagination<any>(items, 20);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold tracking-tight flex items-center gap-2"><CalendarDays size={20}/> {t("Holiday calendar (CN)")}</h1>
        <div className="flex items-center gap-2">
          {inFreeze && (
            <div className="badge border-warning/40 text-warning">
              <ShieldAlert size={12}/> {t("Freeze active:")} {data.freeze_holiday}
            </div>
          )}
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

      <section className="card p-5 text-sm text-muted">
        {t("During the pre/post windows of each holiday the executor **auto-pauses** all migration tasks to avoid IO jitter at peak.")}
        {t("Each holiday's")} <span className="kbd">pre_window_days</span> / <span className="kbd">post_window_days</span> {t("is tunable via SQL.")}
      </section>

      <section className="card overflow-hidden">
        {isLoading && !data ? (
          <TableSkeleton rows={5} headers={[t("Date"), t("Name"), t("Pre window"), t("Post window"), t("Notes")]}/>
        ) : (<>
        <table className="grid">
          <thead><tr><th>{t("Date")}</th><th>{t("Name")}</th><th>{t("Pre window")}</th><th>{t("Post window")}</th><th>{t("Notes")}</th></tr></thead>
          <tbody>
            {pg.slice.map((h: any) => (
              <tr key={h.date}>
                <td className="font-mono">{h.date.slice(0,10)}</td>
                <td className="font-medium">{h.name}</td>
                <td>{h.pre_window_days} {t("days")}</td>
                <td>{h.post_window_days} {t("days")}</td>
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
