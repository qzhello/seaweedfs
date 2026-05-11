"use client";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useT } from "@/lib/i18n";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export function usePagination<T>(items: T[], initialSize = 20) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(initialSize);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));

  // Snap page back into range when items or size change.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const start = (page - 1) * size;
  const slice = useMemo(() => items.slice(start, start + size), [items, start, size]);

  return {
    page, setPage,
    size, setSize,
    total, totalPages,
    start, end: Math.min(start + size, total),
    slice,
  };
}

export function Pagination({
  page, setPage, size, setSize, total, totalPages, start, end,
}: {
  page: number;
  setPage: (n: number) => void;
  size: number;
  setSize: (n: number) => void;
  total: number;
  totalPages: number;
  start: number;
  end: number;
}) {
  const { t } = useT();
  if (total === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-2 py-3 text-xs text-muted flex-wrap">
      <div className="tabular-nums">
        {t("Showing")} <span className="text-text">{start + 1}</span>–<span className="text-text">{end}</span> {t("of")} <span className="text-text">{total}</span>
      </div>

      <div className="flex items-center gap-1">
        <label className="flex items-center gap-1.5 mr-2">
          {t("Per page")}
          <select
            className="input text-xs py-1 pl-2 pr-6"
            value={size}
            onChange={e => { setSize(Number(e.target.value)); setPage(1); }}
          >
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <PageBtn onClick={() => setPage(1)} disabled={page === 1} title={t("First page")}>
          <ChevronsLeft size={14}/>
        </PageBtn>
        <PageBtn onClick={() => setPage(page - 1)} disabled={page === 1} title={t("Previous page")}>
          <ChevronLeft size={14}/>
        </PageBtn>

        <span className="px-2 tabular-nums">
          <span className="text-text">{page}</span> / {totalPages}
        </span>

        <PageBtn onClick={() => setPage(page + 1)} disabled={page === totalPages} title={t("Next page")}>
          <ChevronRight size={14}/>
        </PageBtn>
        <PageBtn onClick={() => setPage(totalPages)} disabled={page === totalPages} title={t("Last page")}>
          <ChevronsRight size={14}/>
        </PageBtn>
      </div>
    </div>
  );
}

function PageBtn({ onClick, disabled, title, children }: {
  onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1.5 rounded-md border border-border text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
