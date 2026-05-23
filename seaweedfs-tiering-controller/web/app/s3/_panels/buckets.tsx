"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TableSkeleton } from "@/components/table-skeleton";
import { Plus, Loader2, Database, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { api, useBuckets, type BucketRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { EmptyState } from "@/components/empty-state";
import { ErrorPanel } from "@/components/error-panel";
import {
  ShellActionMenu, ShellActionDialog, type ShellAction,
} from "@/components/shell-action";
import { useCluster } from "@/lib/cluster-context";
import { toast } from "@/lib/toast";
import { GovernanceDialog } from "./_governance-dialog";

// ---- Risk assessment -----------------------------------------------------------------------

interface RiskAssessment {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
}

const PROD_RE = /prod|production|live/i;
const MS_7D  = 7  * 24 * 60 * 60 * 1000;
const MS_90D = 90 * 24 * 60 * 60 * 1000;

function assessBucketRisk(
  bucket: BucketRow,
  opts: { lifecycle?: Set<string> } = {},
): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  const now = Date.now();

  // +40 has data (size > 0 is the proxy — object_count not exposed by the bucket API yet)
  if (bucket.size > 0) {
    score += 40;
    reasons.push(`has ${bytes(bucket.size)} data`);
  }
  // +25 recently scanned within 7 days (last_scan_at is the best recency proxy available)
  if (bucket.last_scan_at) {
    const age = now - new Date(bucket.last_scan_at).getTime();
    if (age < MS_7D) {
      score += 25;
      const d = Math.floor(age / 86_400_000);
      reasons.push(d === 0 ? "scanned today" : `scanned ${d}d ago`);
    }
  }
  // +15 lifecycle/governance rule attached (retention_days set in controller governance)
  if (bucket.retention_days != null || opts.lifecycle?.has(bucket.name)) {
    score += 15;
    reasons.push("lifecycle rule attached");
  }
  // +10 quota configured (quota field is MB)
  if (bucket.quota && bucket.quota > 0) {
    score += 10;
    reasons.push(`quota ${(bucket.quota / 1024).toFixed(0)} GB`);
  }
  // +5 non-default S3 identity owner
  const defaultOwners = new Set(["", "anonymous", "Admin"]);
  if (bucket.owner && !defaultOwners.has(bucket.owner)) {
    score += 5;
    reasons.push(`owned by ${bucket.owner_name ?? bucket.owner}`);
  }
  // +20 production-sounding name
  if (PROD_RE.test(bucket.name)) {
    score += 20;
    reasons.push("production name");
  }
  // -20 stale empty bucket (empty + >90d since last scan lowers the risk floor)
  if (bucket.size === 0 && bucket.last_scan_at) {
    const age = now - new Date(bucket.last_scan_at).getTime();
    if (age > MS_90D) {
      score = Math.max(0, score - 20);
      reasons.push("stale empty bucket");
    }
  }

  const s = Math.max(0, Math.min(100, score));
  const level: RiskAssessment["level"] =
    s >= 60 ? "high" : s >= 30 ? "medium" : "low";
  return { score: s, level, reasons };
}

// ---- Risk preview table component ----------------------------------------------------------

interface ScoredBucket { bucket: BucketRow; assessment: RiskAssessment }

const RISK_PILL: Record<RiskAssessment["level"], string> = {
  high:   "bg-danger/15  text-danger  border border-danger/30",
  medium: "bg-warning/15 text-warning border border-warning/30",
  low:    "bg-success/15 text-success border border-success/30",
};

function RiskPreviewCard({ scored }: { scored: ScoredBucket[] }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 10;
  const sorted = [...scored].sort(
    (a, b) =>
      b.assessment.score - a.assessment.score ||
      a.bucket.name.localeCompare(b.bucket.name),
  );
  const visible = expanded ? sorted : sorted.slice(0, LIMIT);
  const hidden  = sorted.length - LIMIT;
  const highN   = scored.filter((s) => s.assessment.level === "high").length;
  const medN    = scored.filter((s) => s.assessment.level === "medium").length;
  const lowN    = scored.filter((s) => s.assessment.level === "low").length;

  return (
    <div className="my-3 rounded-md border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-panel2 text-muted">
            <th className="text-left px-2 py-1.5 font-medium">Bucket</th>
            <th className="text-left px-2 py-1.5 font-medium w-20">Risk</th>
            <th className="text-left px-2 py-1.5 font-medium">Factors</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(({ bucket, assessment }) => (
            <tr key={bucket.name} className="border-t border-border/50 hover:bg-panel2/40">
              <td className="px-2 py-1.5 font-mono max-w-[10rem] truncate" title={bucket.name}>
                {bucket.name}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${RISK_PILL[assessment.level]}`}>
                  {assessment.level}
                </span>
              </td>
              <td
                className="px-2 py-1.5 text-muted max-w-[16rem] truncate"
                title={assessment.reasons.join(", ")}
              >
                {assessment.reasons.length > 0 ? assessment.reasons.join(", ") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!expanded && hidden > 0 && (
        <button
          className="w-full text-center py-1.5 text-xs text-accent hover:text-accent/80 bg-panel2/60 border-t border-border/50 transition-colors"
          onClick={() => setExpanded(true)}
        >
          +{hidden} more — click to expand
        </button>
      )}
      <div className="px-2 py-1.5 border-t border-border/50 bg-panel2/40 text-[11px] text-muted">
        <span className="text-danger font-semibold">{highN} high-risk</span>
        {" · "}
        <span className="text-warning font-semibold">{medN} medium</span>
        {" · "}
        <span className="text-success font-semibold">{lowN} low</span>
      </div>
    </div>
  );
}

// ---- Inline bulk-delete confirmation modal -------------------------------------------------
// lib/confirm.tsx and confirm-host.tsx accept body as string only, not ReactNode.
// A purpose-built inline modal lets the risk table live inside the confirmation flow
// without modifying the shared dialog component.

interface BulkDeleteModalProps {
  buckets: BucketRow[];
  onConfirm: () => void;
  onCancel: () => void;
}

function BulkDeleteModal({ buckets, onConfirm, onCancel }: BulkDeleteModalProps) {
  const phrase = `delete ${buckets.length}`;
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const scored: ScoredBucket[] = buckets.map((b) => ({
    bucket: b,
    assessment: assessBucketRisk(b),
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    document.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-delete-title"
      onMouseDown={onCancel}
    >
      <div
        className="card shadow-pop w-full max-w-lg my-8 p-5 border-danger/40 bg-danger/5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-full p-2 bg-danger/15 text-danger shrink-0 mt-0.5">
            <ShieldAlert size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="bulk-delete-title" className="text-sm font-semibold text-text">
              Delete {buckets.length} bucket{buckets.length !== 1 ? "s" : ""}?
            </h2>
            <p className="mt-1 text-xs text-muted">
              Each bucket must be empty (no objects, no multipart uploads). Buckets that
              still hold data will fail individually and stay listed. This cannot be undone.
            </p>
          </div>
        </div>

        <RiskPreviewCard scored={scored} />

        <div>
          <label className="block text-[11px] text-muted mb-1">
            Re-check the high-risk rows above, then type{" "}
            <code className="px-1 py-0.5 rounded bg-panel2 font-mono text-[11px] text-text">
              {phrase}
            </code>{" "}
            to confirm
          </label>
          <input
            ref={inputRef}
            className="input w-full font-mono text-xs"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={phrase}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={typed !== phrase}
            onClick={onConfirm}
          >
            Delete {buckets.length} bucket{buckets.length !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

const BUCKET_ACTIONS: ShellAction<BucketRow>[] = [
  {
    key: "quota", label: "Set quota", command: "s3.bucket.quota", risk: "mutate",
    fields: [
      { key: "quotaMB", label: "Quota (MB)", required: true,
        help: "Set 0 to remove the quota." },
    ],
    buildArgs: (b, x) => `-name=${b.name} -quotaMB=${x.quotaMB}`,
  },
  {
    key: "quota-enforce-on", label: "Enforce quota", command: "s3.bucket.quota.enforce", risk: "mutate",
    buildArgs: (b) => `-name=${b.name} -enforce`,
  },
  {
    key: "quota-enforce-off", label: "Stop enforcing quota", command: "s3.bucket.quota.enforce", risk: "mutate",
    buildArgs: (b) => `-name=${b.name} -enforce=false`,
  },
  {
    key: "versioning-on", label: "Enable versioning", command: "s3.bucket.versioning", risk: "mutate",
    buildArgs: (b) => `-name=${b.name} -status=Enabled`,
  },
  {
    key: "versioning-off", label: "Suspend versioning", command: "s3.bucket.versioning", risk: "mutate",
    buildArgs: (b) => `-name=${b.name} -status=Suspended`,
  },
  {
    key: "clean-uploads", label: "Clean stale uploads", command: "s3.clean.uploads", risk: "mutate",
    fields: [{ key: "timeAgo", label: "Older than", default: "24h", help: "e.g. 24h, 7d." }],
    buildArgs: (b, x) => {
      const parts = [`-bucket=${b.name}`];
      if (x.timeAgo) parts.push(`-timeAgo=${x.timeAgo}`);
      return parts.join(" ");
    },
  },
  {
    key: "owner", label: "Change owner", command: "s3.bucket.owner", risk: "mutate",
    fields: [
      { key: "owner", label: "Owner identity", required: true, help: "Identity name from /s3?tab=identities." },
    ],
    buildArgs: (b, x) => `-bucket=${b.name} -owner=${x.owner}`,
  },
  {
    key: "delete", label: "Delete bucket", command: "s3.bucket.delete", risk: "destructive",
    buildArgs: (b) => `-name=${b.name}`,
  },
];

export function BucketsPanel() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data, isLoading, isValidating, mutate, error } = useBuckets(clusterID || undefined);
  const items = data?.items ?? [];
  const [text, setText] = useState("");

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return items;
    return items.filter((b) =>
      b.name.toLowerCase().includes(q)
      || (b.owner || "").toLowerCase().includes(q)
      || (b.owner_name || "").toLowerCase().includes(q),
    );
  }, [items, text]);
  const pg = usePagination(filtered, 50);

  const [dialog, setDialog] = useState<{ row: BucketRow; action: ShellAction<BucketRow> } | null>(null);
  const [creating, setCreating] = useState(false);
  const [gov, setGov] = useState<BucketRow | null>(null);
  const [scanning, setScanning] = useState<Set<string>>(new Set());
  const [scanErr, setScanErr] = useState("");

  // Batch selection state. `selected` survives filtering & pagination because
  // the operator may want to refine the filter, page through, and keep their
  // accumulated picks. Removing items only on page-clear keeps that intent.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number; current: string } | null>(null);
  // Inline confirmation modal — holds the selected buckets + the promise resolver
  // so bulkDelete can await the user's decision without using the shared confirmDlg
  // (which accepts only a plain string body, not a ReactNode risk table).
  const [bulkDeleteModal, setBulkDeleteModal] = useState<{
    buckets: BucketRow[];
    resolve: (ok: boolean) => void;
  } | null>(null);

  const toggleOne = (name: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  // "Select all" applies to the current page only — operators expect that
  // checking the header box reflects what's visible, not the whole dataset.
  const pageNames = pg.slice.map((b) => b.name);
  const allOnPageSelected = pageNames.length > 0 && pageNames.every((n) => selected.has(n));
  const someOnPageSelected = pageNames.some((n) => selected.has(n));
  const togglePage = () => setSelected((s) => {
    const n = new Set(s);
    if (allOnPageSelected) pageNames.forEach((p) => n.delete(p));
    else pageNames.forEach((p) => n.add(p));
    return n;
  });

  const bulkDelete = async () => {
    if (!clusterID || selected.size === 0) return;
    const names = Array.from(selected);
    // Open the inline risk-preview modal and wait for the operator's decision.
    const selectedBuckets = items.filter((b) => names.includes(b.name));
    const ok = await new Promise<boolean>((resolve) => {
      setBulkDeleteModal({ buckets: selectedBuckets, resolve });
    });
    setBulkDeleteModal(null);
    if (!ok) return;

    // Sequential delete. Parallel would be faster but the underlying
    // `weed shell` is a single serialised pipe per cluster — concurrent
    // requests queue server-side anyway. Sequential also lets us show
    // honest "deleting bucket X of N" progress.
    const failures: { name: string; error: string }[] = [];
    setBulkBusy({ done: 0, total: names.length, current: names[0] });
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      setBulkBusy({ done: i, total: names.length, current: name });
      try {
        await api.s3BucketDelete(clusterID, name);
      } catch (e) {
        failures.push({ name, error: (e as Error).message || String(e) });
      }
    }
    setBulkBusy(null);
    setSelected(new Set());
    await mutate();

    const ok2 = names.length - failures.length;
    if (failures.length === 0) {
      toast.success(t("Deleted {n} bucket(s)").replace("{n}", String(ok2)));
    } else if (ok2 === 0) {
      toast.error(t("Failed to delete any bucket"),
        failures.slice(0, 3).map(f => `${f.name}: ${f.error}`).join("\n"));
    } else {
      toast.warn(
        t("Deleted {ok} bucket(s), {fail} failed")
          .replace("{ok}", String(ok2)).replace("{fail}", String(failures.length)),
        failures.slice(0, 3).map(f => `${f.name}: ${f.error}`).join("\n"),
      );
    }
  };

  // On-demand lifecycle scan: walk the bucket, count files past retention.
  const runScan = (name: string) => {
    if (!clusterID) return;
    setScanErr("");
    setScanning((s) => new Set(s).add(name));
    api.scanBucketLifecycle(clusterID, name)
      .then(() => mutate())
      .catch((e) => setScanErr(`${name}: ${(e as Error).message}`))
      .finally(() => setScanning((s) => {
        const n = new Set(s);
        n.delete(name);
        return n;
      }));
  };

  const expiredBuckets = items.filter((b) => (b.expired_objects ?? 0) > 0).length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          {expiredBuckets > 0 && (
            <p className="text-xs text-danger">
              {t("{n} bucket(s) have data past their retention period.").replace("{n}", String(expiredBuckets))}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={text} onChange={(e) => setText(e.target.value)}
            placeholder={t("Search name / owner…")}
            className="input w-60"
          />
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <button
            disabled={!clusterID}
            onClick={() => setCreating(true)}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2 disabled:opacity-40"
          >
            <Plus size={14}/> {t("New bucket")}
          </button>
        </div>
      </div>

      {error && <ErrorPanel error={error}/>}
      {scanErr && (
        <div className="card p-3 text-xs text-danger border-danger/40 bg-danger/5">{scanErr}</div>
      )}

      {/* Batch toolbar — only visible when something is selected. Sticky so
          the operator never loses the action while scrolling a long table. */}
      {selected.size > 0 && (
        <div className="card sticky top-0 z-20 px-3 py-2 border-accent/40 bg-accent/5 flex items-center gap-3 text-sm">
          <span className="text-text font-medium">
            {t("{n} bucket(s) selected").replace("{n}", String(selected.size))}
          </span>
          <button className="btn btn-ghost text-xs" onClick={() => setSelected(new Set())}>
            <X size={12}/> {t("Clear selection")}
          </button>
          <span className="flex-1"/>
          {bulkBusy ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin"/>
              {t("Deleting {cur} of {total}: {name}")
                .replace("{cur}", String(bulkBusy.done + 1))
                .replace("{total}", String(bulkBusy.total))
                .replace("{name}", bulkBusy.current)}
            </span>
          ) : (
            <button
              className="btn btn-danger"
              disabled={!clusterID}
              onClick={bulkDelete}>
              <Trash2 size={14}/> {t("Delete selected")}
            </button>
          )}
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={6}/>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Database} title={items.length === 0 ? t("No buckets found") : t("No buckets match the filter")}
            hint={clusterID ? t("Click New bucket above to create one.") : t("Select a cluster to see its buckets.")}/>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th style={{ width: 32 }} className="text-center">
                  <input
                    type="checkbox"
                    aria-label={t("Select all on page")}
                    className="accent-accent cursor-pointer"
                    checked={allOnPageSelected}
                    ref={(el) => { if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected; }}
                    onChange={togglePage}
                  />
                </th>
                <th>{t("Name")}</th>
                <th className="num">{t("Size")}</th>
                <th className="num">{t("Chunks")}</th>
                <th className="num">{t("Quota")}</th>
                <th className="num">{t("Usage")}</th>
                <th>{t("Owner")}</th>
                <th>{t("Retention")}</th>
                <th className="num">{t("Expired")}</th>
                <th style={{ width: 36 }}></th>
              </tr></thead>
              <tbody>
                {pg.slice.map((b) => (
                  <tr key={b.name} className={selected.has(b.name) ? "bg-accent/5" : ""}>
                    <td className="text-center">
                      <input
                        type="checkbox"
                        aria-label={t("Select {name}").replace("{name}", b.name)}
                        className="accent-accent cursor-pointer"
                        checked={selected.has(b.name)}
                        onChange={() => toggleOne(b.name)}
                      />
                    </td>
                    <td className="font-mono text-sm">{b.name}</td>
                    <td className="num">{bytes(b.size)}</td>
                    <td className="num">{b.chunks.toLocaleString()}</td>
                    <td className="num">{b.quota ? bytes(b.quota * 1024 * 1024) : <span className="text-muted">—</span>}</td>
                    <td className="num">{b.usage_pc != null ? `${b.usage_pc.toFixed(1)}%` : <span className="text-muted">—</span>}</td>
                    <td className="max-w-[14rem]">
                      <button
                        onClick={() => setGov(b)}
                        className="text-left w-full truncate hover:text-accent transition-colors"
                        title={t("Edit owner & retention")}>
                        {b.owner_name
                          ? <span className="text-xs">{b.owner_name}</span>
                          : b.owner
                            ? <span className="text-xs text-muted font-mono">{b.owner}</span>
                            : <span className="text-xs text-muted italic">{t("set owner")}</span>}
                        {b.owner_user_key && (
                          <span className="block text-[10px] text-muted/70 font-mono truncate">{b.owner_user_key}</span>
                        )}
                      </button>
                    </td>
                    <td className="text-xs">
                      {b.retention_days != null
                        ? <span className="badge border-accent/30 text-accent">{b.retention_days}d</span>
                        : <button onClick={() => setGov(b)} className="text-muted hover:text-accent">—</button>}
                    </td>
                    <td className="num">
                      {b.last_scan_at ? (
                        <span
                          className={(b.expired_objects ?? 0) > 0 ? "text-danger" : "text-muted"}
                          title={`${bytes(b.expired_bytes ?? 0)}${b.scan_truncated ? " · partial scan" : ""} · ${t("scanned")} ${new Date(b.last_scan_at).toLocaleString()}`}>
                          {(b.expired_objects ?? 0).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-muted/40">—</span>
                      )}
                      <button
                        onClick={() => runScan(b.name)}
                        disabled={b.retention_days == null || scanning.has(b.name)}
                        title={b.retention_days != null ? t("Scan for expired data") : t("Set a retention period first")}
                        className="ml-1.5 align-middle text-muted hover:text-accent disabled:opacity-30 disabled:hover:text-muted">
                        {scanning.has(b.name)
                          ? <Loader2 size={11} className="animate-spin inline"/>
                          : <RefreshCw size={11} className="inline"/>}
                      </button>
                    </td>
                    <td>
                      <ShellActionMenu
                        row={b}
                        actions={BUCKET_ACTIONS}
                        onPick={(a) => setDialog({ row: b, action: a })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pg}/>
          </div>
        )}
      </section>

      {dialog && clusterID && (
        <ShellActionDialog
          clusterID={clusterID}
          row={dialog.row}
          action={dialog.action}
          onClose={(didRun) => {
            setDialog(null);
            if (didRun) mutate();
          }}
        />
      )}
      {gov && clusterID && (
        <GovernanceDialog
          clusterID={clusterID}
          bucket={gov}
          onClose={(saved) => {
            setGov(null);
            if (saved) mutate();
          }}
        />
      )}
      {creating && clusterID && (
        <ShellActionDialog
          clusterID={clusterID}
          row={{ name: "", size: 0, chunks: 0 } as BucketRow}
          action={{
            key: "create", label: "Create bucket", command: "s3.bucket.create", risk: "mutate",
            fields: [
              { key: "name", label: "Bucket name", required: true, help: "DNS-compatible name." },
              { key: "quotaMB", label: "Quota (MB) — optional" },
            ],
            buildArgs: (_r, x) => {
              const parts = [`-name=${x.name}`];
              if (x.quotaMB) parts.push(`-quotaMB=${x.quotaMB}`);
              return parts.join(" ");
            },
          }}
          onClose={(didRun) => {
            setCreating(false);
            if (didRun) mutate();
          }}
        />
      )}
      {bulkDeleteModal && (
        <BulkDeleteModal
          buckets={bulkDeleteModal.buckets}
          onConfirm={() => bulkDeleteModal.resolve(true)}
          onCancel={() => bulkDeleteModal.resolve(false)}
        />
      )}
    </div>
  );
}
