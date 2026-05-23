"use client";

// Clean unfinished multipart uploads. Classifies each upload as:
//   Abandoned  — certainly dead, safe to delete
//   Suspicious — stuck but might still be active
//   In-flight  — too recent to touch
//
// The original shell-command approach is retained as a "Quick clean"
// fallback at the bottom of the page.

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Trash2, X, RefreshCw, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import { BASE, authHeaders, api } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { useCluster } from "@/lib/cluster-context";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { TableSkeleton } from "@/components/table-skeleton";
import { bytes } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { RefreshButton } from "@/components/refresh-button";

// ---- classification thresholds ----------------------------------------
const ABANDONED_AGE_LONG_H  = 168;  // 7 days — anything older is certainly dead
const ABANDONED_AGE_SMALL_H =  24;  // 1 day for small / nearly-empty uploads
const ABANDONED_SIZE_SMALL  = 5_000_000; // 5 MB
const ABANDONED_AGE_ZERO_H  =  72;  // 3 days with zero bytes transferred
const SUSPICIOUS_AGE_H      =   4;  // > 4 h and not yet abandoned → stuck

// ---- types -------------------------------------------------------------
export interface MultipartUpload {
  bucket:       string;
  key:          string;
  upload_id:    string;
  initiated_at: string; // ISO-8601
  size_so_far:  number; // bytes; 0 if unknown
}

export type Classification = "abandoned" | "suspicious" | "inflight";
export type FilterTab = Classification | "all";

interface ClassifiedUpload extends MultipartUpload {
  ageH:   number;
  bucket: string;
  cls:    Classification;
}

// ---- classification logic ---------------------------------------------
function classify(u: MultipartUpload): ClassifiedUpload {
  const initiated = Date.parse(u.initiated_at);
  const ageH = isNaN(initiated)
    ? ABANDONED_AGE_LONG_H + 1          // unparseable → treat as abandoned
    : (Date.now() - initiated) / 3_600_000;

  const size = u.size_so_far ?? 0;

  let cls: Classification;
  if (
    ageH >= ABANDONED_AGE_LONG_H ||
    (ageH >= ABANDONED_AGE_SMALL_H && size > 0 && size < ABANDONED_SIZE_SMALL) ||
    (ageH >= ABANDONED_AGE_ZERO_H  && size === 0)
  ) {
    cls = "abandoned";
  } else if (ageH >= SUSPICIOUS_AGE_H && size > 0) {
    cls = "suspicious";
  } else {
    cls = "inflight";
  }

  return { ...u, ageH, cls };
}

// ---- SWR fetcher (mirrors the pattern from api.ts) --------------------
async function fetchUploads(url: string): Promise<{ items: MultipartUpload[] }> {
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function abortUpload(
  clusterID: string,
  bucket: string,
  uploadID: string,
): Promise<void> {
  const url = `${BASE}/clusters/${clusterID}/s3/multipart-uploads/${encodeURIComponent(bucket)}/${encodeURIComponent(uploadID)}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
}

// ---- helpers -----------------------------------------------------------
function ageLabel(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

function totalMB(rows: ClassifiedUpload[]): string {
  const total = rows.reduce((acc, r) => acc + (r.size_so_far ?? 0), 0);
  if (total === 0) return "0 B";
  return bytes(total);
}

// ---- main export -------------------------------------------------------
export function CleanUploadsPanel() {
  return (
    <Can
      cap="s3.clean-uploads"
      fallback={
        <div className="card p-6 text-sm text-muted">
          You don&apos;t have permission to view this page.
        </div>
      }
    >
      <Inner />
    </Can>
  );
}

// ---- inner component ---------------------------------------------------
function Inner() {
  const { clusterID } = useCluster();

  const { data, isLoading, isValidating, mutate, error } = useSWR<{ items: MultipartUpload[] }>(
    clusterID ? `${BASE}/clusters/${clusterID}/s3/multipart-uploads` : null,
    fetchUploads,
    { refreshInterval: 0 },
  );

  const allItems: ClassifiedUpload[] = useMemo(
    () => (data?.items ?? []).map(classify),
    [data],
  );

  const abandoned  = useMemo(() => allItems.filter((u) => u.cls === "abandoned"),  [allItems]);
  const suspicious = useMemo(() => allItems.filter((u) => u.cls === "suspicious"), [allItems]);
  const inflight   = useMemo(() => allItems.filter((u) => u.cls === "inflight"),   [allItems]);

  const [filter, setFilter] = useState<FilterTab>("abandoned");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<{
    done: number; total: number; current: string;
  } | null>(null);

  // quick-clean (legacy) state
  const [timeAgo, setTimeAgo] = useState("24h");
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickOut, setQuickOut]   = useState("");
  const [quickErr, setQuickErr]   = useState("");

  if (!clusterID) {
    return (
      <div className="card p-6 text-sm text-muted">
        Pick a cluster in the top-right to start.
      </div>
    );
  }

  // ---- derived current-filter rows -----------------------------------
  const visibleRows: ClassifiedUpload[] =
    filter === "abandoned"  ? abandoned  :
    filter === "suspicious" ? suspicious :
    filter === "inflight"   ? inflight   :
    allItems;

  // ---- selection helpers ---------------------------------------------
  const visibleIds  = visibleRows.map((u) => u.upload_id);
  const allVisible  = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisible = visibleIds.some((id) => selected.has(id));

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisible) {
        visibleIds.forEach((id) => n.delete(id));
      } else {
        visibleIds.forEach((id) => n.add(id));
      }
      return n;
    });

  // ---- bulk delete ---------------------------------------------------
  const bulkDeleteUploads = async (rows: ClassifiedUpload[]) => {
    if (!clusterID || rows.length === 0) return;

    const phrase = `delete ${rows.length}`;
    const ok = await confirmDlg.danger({
      title: `Delete ${rows.length} multipart upload(s)?`,
      body: `All partial data for the selected upload(s) will be permanently destroyed and cannot be recovered. Any client currently uploading these parts will receive errors.\n\nThis cannot be undone.`,
      typeToConfirm: phrase,
      confirmLabel: `Delete ${rows.length} upload(s)`,
    });
    if (!ok) return;

    const failures: { label: string; error: string }[] = [];
    setBulkBusy({ done: 0, total: rows.length, current: `${rows[0].bucket}/${rows[0].key}` });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = `${row.bucket}/${row.key}`;
      setBulkBusy({ done: i, total: rows.length, current: label });
      try {
        await abortUpload(clusterID, row.bucket, row.upload_id);
      } catch (e: unknown) {
        failures.push({ label, error: (e as Error).message || String(e) });
      }
    }

    setBulkBusy(null);
    setSelected(new Set());
    await mutate();

    const succeeded = rows.length - failures.length;
    if (failures.length === 0) {
      toast.success(`Deleted ${succeeded} multipart upload(s)`);
    } else if (succeeded === 0) {
      toast.error(
        "Failed to delete any upload",
        failures.slice(0, 3).map((f) => `${f.label}: ${f.error}`).join("\n"),
      );
    } else {
      toast.warn(
        `Deleted ${succeeded} upload(s), ${failures.length} failed`,
        failures.slice(0, 3).map((f) => `${f.label}: ${f.error}`).join("\n"),
      );
    }
  };

  const handleDeleteSelected = () => {
    const rows = allItems.filter((u) => selected.has(u.upload_id));
    bulkDeleteUploads(rows);
  };

  const handleDeleteAllAbandoned = () => {
    bulkDeleteUploads(abandoned);
  };

  // ---- quick-clean (legacy) ------------------------------------------
  const runQuickClean = async () => {
    if (!timeAgo.trim()) return;
    if (
      !(await confirmDlg.danger({
        title: `Abort all multipart uploads older than ${timeAgo}?`,
      }))
    )
      return;
    setQuickBusy(true);
    setQuickErr("");
    setQuickOut("");
    try {
      const r = await api.s3CleanUploads(clusterID, timeAgo.trim());
      setQuickOut(r.output || "Done — command finished with no output.");
      await mutate();
    } catch (e: unknown) {
      setQuickErr((e as Error).message);
    } finally {
      setQuickBusy(false);
    }
  };

  // ---- empty-state messages ------------------------------------------
  const emptyMessages: Record<FilterTab, string> = {
    abandoned:  "Nothing abandoned — your gateway is clean.",
    suspicious: "No suspicious uploads right now.",
    inflight:   "No uploads in flight at the moment.",
    all:        "No multipart uploads found.",
  };

  // ---- classification badge ------------------------------------------
  function ClsBadge({ cls }: { cls: Classification }) {
    if (cls === "abandoned")
      return (
        <span className="badge border-danger/40 text-danger bg-danger/5 inline-flex items-center gap-1">
          <AlertTriangle size={10} /> Abandoned
        </span>
      );
    if (cls === "suspicious")
      return (
        <span className="badge border-warning/40 text-warning bg-warning/5 inline-flex items-center gap-1">
          <Clock size={10} /> Suspicious
        </span>
      );
    return (
      <span className="badge border-accent/30 text-accent bg-accent/5 inline-flex items-center gap-1">
        <CheckCircle2 size={10} /> In-flight
      </span>
    );
  }

  return (
    <div className="space-y-5">
      {/* progress pill — shown during bulk delete */}
      {bulkBusy && (
        <div className="card px-3 py-2 border-warning/40 bg-warning/5 flex items-center gap-2 text-xs text-warning">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>
            Deleting {bulkBusy.done + 1} of {bulkBusy.total}:{" "}
            <span className="font-mono">{bulkBusy.current}</span>
          </span>
        </div>
      )}

      {/* filter chips + "Delete all abandoned" shortcut */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          active={filter === "abandoned"}
          onClick={() => setFilter("abandoned")}
          color="danger"
          label={`Abandoned (${abandoned.length} · ${totalMB(abandoned)})`}
        />
        <FilterChip
          active={filter === "suspicious"}
          onClick={() => setFilter("suspicious")}
          color="warning"
          label={`Suspicious (${suspicious.length} · ${totalMB(suspicious)})`}
        />
        <FilterChip
          active={filter === "inflight"}
          onClick={() => setFilter("inflight")}
          color="muted"
          label={`In-flight (${inflight.length} · ${totalMB(inflight)})`}
        />
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          color="muted"
          label={`All (${allItems.length})`}
        />

        <span className="flex-1" />

        <RefreshButton loading={isValidating} onClick={() => mutate()} />

        {abandoned.length > 0 && !bulkBusy && (
          <button
            className="btn btn-danger text-xs inline-flex items-center gap-1.5"
            onClick={handleDeleteAllAbandoned}
            disabled={!!bulkBusy}
          >
            <Trash2 size={13} />
            Delete all Abandoned ({abandoned.length})
          </button>
        )}
      </div>

      {error && <ErrorPanel error={error} />}

      {/* sticky action bar — visible whenever ≥1 row is checked */}
      {selected.size > 0 && (
        <div className="card sticky top-0 z-20 px-3 py-2 border-accent/40 bg-accent/5 flex items-center gap-3 text-sm">
          <span className="text-text font-medium">
            {selected.size} upload(s) selected
          </span>
          <button
            className="btn btn-ghost text-xs"
            onClick={() => setSelected(new Set())}
          >
            <X size={12} /> Clear selection
          </button>
          <span className="flex-1" />
          {bulkBusy ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" />
              Deleting {bulkBusy.done + 1} of {bulkBusy.total}
            </span>
          ) : (
            <button
              className="btn btn-danger"
              onClick={handleDeleteSelected}
              disabled={!!bulkBusy}
            >
              <Trash2 size={14} /> Delete {selected.size} upload(s)
            </button>
          )}
        </div>
      )}

      {/* main table */}
      <section className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={5} cols={6} />
        ) : visibleRows.length === 0 ? (
          <div className="p-8 text-sm text-center text-muted">
            {emptyMessages[filter]}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 32 }} className="text-center">
                    <input
                      type="checkbox"
                      aria-label="Select all visible"
                      className="accent-accent cursor-pointer"
                      checked={allVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = someVisible && !allVisible;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Bucket</th>
                  <th>Key</th>
                  <th className="num">Age</th>
                  <th className="num">Size so far</th>
                  <th>Classification</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((u) => (
                  <tr
                    key={u.upload_id}
                    className={selected.has(u.upload_id) ? "bg-accent/5" : ""}
                  >
                    <td className="text-center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${u.bucket}/${u.key}`}
                        className="accent-accent cursor-pointer"
                        checked={selected.has(u.upload_id)}
                        onChange={() => toggleOne(u.upload_id)}
                      />
                    </td>
                    <td className="font-mono text-sm">{u.bucket}</td>
                    <td
                      className="font-mono text-xs max-w-[22rem] truncate"
                      title={u.key}
                    >
                      {u.key}
                    </td>
                    <td className="num text-xs">
                      {ageLabel(u.ageH)}
                    </td>
                    <td className="num text-xs">
                      {u.size_so_far > 0 ? bytes(u.size_so_far) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td>
                      <ClsBadge cls={u.cls} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- legacy quick-clean section ---- */}
      <details className="group">
        <summary className="cursor-pointer list-none flex items-center gap-2 text-xs text-muted hover:text-text transition-colors select-none py-1">
          <span className="inline-block transition-transform group-open:rotate-90">▶</span>
          Quick clean by age (shell command)
        </summary>

        <div className="mt-3 space-y-5">
          <section className="card p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {["1h", "24h", "72h", "168h"].map((p) => (
                <button
                  key={p}
                  onClick={() => setTimeAgo(p)}
                  className={`btn text-xs ${
                    timeAgo === p
                      ? "bg-accent/15 text-accent border-accent/40"
                      : ""
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted">
                Custom window (e.g. 24h, 7d)
              </label>
              <input
                value={timeAgo}
                onChange={(e) => setTimeAgo(e.target.value)}
                className="input w-48 font-mono"
              />
            </div>
            <button
              className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40"
              onClick={runQuickClean}
              disabled={quickBusy || !timeAgo.trim()}
            >
              {quickBusy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Run
            </button>
          </section>

          {quickErr && <ErrorPanel error={quickErr} />}
          {quickOut && (
            <section className="card p-3">
              <div className="text-xs uppercase tracking-wider text-muted mb-1">
                Output
              </div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">
                {quickOut}
              </pre>
            </section>
          )}
        </div>
      </details>
    </div>
  );
}

// ---- filter chip helper -----------------------------------------------
interface FilterChipProps {
  active:  boolean;
  onClick: () => void;
  color:   "danger" | "warning" | "muted";
  label:   string;
}

function FilterChip({ active, onClick, color, label }: FilterChipProps) {
  const base = "btn text-xs transition-all";
  const variants: Record<FilterChipProps["color"], string> = {
    danger:  active ? "bg-danger/15 text-danger border-danger/40"   : "text-muted hover:text-danger",
    warning: active ? "bg-warning/15 text-warning border-warning/40" : "text-muted hover:text-warning",
    muted:   active ? "bg-panel2 text-text border-border"            : "text-muted",
  };
  return (
    <button className={`${base} ${variants[color]}`} onClick={onClick}>
      {label}
    </button>
  );
}
