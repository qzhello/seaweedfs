"use client";

import { useMemo, useState } from "react";
import { Plus, Loader2, Database } from "lucide-react";
import { useBuckets, type BucketRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { EmptyState } from "@/components/empty-state";
import {
  ShellActionMenu, ShellActionDialog, type ShellAction,
} from "@/components/shell-action";
import { useCluster } from "@/lib/cluster-context";

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
      { key: "owner", label: "Owner identity", required: true, help: "Identity name from /s3/configure." },
    ],
    buildArgs: (b, x) => `-bucket=${b.name} -owner=${x.owner}`,
  },
  {
    key: "delete", label: "Delete bucket", command: "s3.bucket.delete", risk: "destructive",
    buildArgs: (b) => `-name=${b.name}`,
  },
];

export default function BucketsPage() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data, isLoading, isValidating, mutate, error } = useBuckets(clusterID || undefined);
  const items = data?.items ?? [];
  const [text, setText] = useState("");

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return items;
    return items.filter((b) =>
      b.name.toLowerCase().includes(q) || (b.owner || "").toLowerCase().includes(q),
    );
  }, [items, text]);
  const pg = usePagination(filtered, 50);

  const [dialog, setDialog] = useState<{ row: BucketRow; action: ShellAction<BucketRow> } | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            {/* lucide-react doesn't ship a "Bucket" icon — use Database as the closest match */}
            <Database size={20}/> {t("Buckets")}
          </h1>
          <p className="text-xs text-muted">{t("S3 buckets via weed shell s3.bucket.list. Row actions call s3.bucket.* commands.")}</p>
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
      </header>

      {error && (
        <div className="card p-4 border-rose-400/40 bg-rose-400/10 text-rose-300 text-xs font-mono whitespace-pre-wrap">
          {String((error as Error).message ?? error)}
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted text-sm inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={14} className="animate-spin"/> {t("Loading…")}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Database} title={items.length === 0 ? t("No buckets found") : t("No buckets match the filter")}
            hint={clusterID ? t("Click New bucket above to create one.") : t("Select a cluster to see its buckets.")}/>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th>{t("Name")}</th>
                <th className="num">{t("Size")}</th>
                <th className="num">{t("Chunks")}</th>
                <th className="num">{t("Quota")}</th>
                <th className="num">{t("Usage")}</th>
                <th>{t("Owner")}</th>
                <th style={{ width: 36 }}></th>
              </tr></thead>
              <tbody>
                {pg.slice.map((b) => (
                  <tr key={b.name}>
                    <td className="font-mono text-sm">{b.name}</td>
                    <td className="num">{bytes(b.size)}</td>
                    <td className="num">{b.chunks.toLocaleString()}</td>
                    <td className="num">{b.quota ? bytes(b.quota * 1024 * 1024) : <span className="text-muted">—</span>}</td>
                    <td className="num">{b.usage_pc != null ? `${b.usage_pc.toFixed(1)}%` : <span className="text-muted">—</span>}</td>
                    <td className="text-xs text-muted font-mono truncate max-w-[16rem]" title={b.owner}>{b.owner || "—"}</td>
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
    </div>
  );
}

