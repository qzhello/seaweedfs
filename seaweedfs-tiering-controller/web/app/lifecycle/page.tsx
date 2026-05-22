"use client";

// Data lifecycle — cross-cluster view of every bucket with a retention
// rule, and how much of its data is now past retention ("expired but not
// deleted"). The background scan refreshes the counts; retention itself
// is set per-bucket on the Buckets page. Deletion stays manual.

import { Recycle } from "lucide-react";
import { useGovernedBuckets, type GovernedBucket } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { RefreshButton } from "@/components/refresh-button";
import { EmptyState } from "@/components/empty-state";
import { ErrorPanel } from "@/components/error-panel";

export default function LifecyclePage() {
  const { t } = useT();
  const { data, error, isValidating, mutate } = useGovernedBuckets();
  const items = data?.items ?? [];
  const expired = items.filter((b) => b.expired_objects > 0);
  const totalExpiredBytes = expired.reduce((s, b) => s + (b.expired_bytes || 0), 0);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <Recycle size={20} /> {t("Data lifecycle")}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            {t("Every bucket with a retention rule, across all clusters. A background scan refreshes the expired-data counts every few hours; set retention per bucket on the Buckets page. Deletion stays manual.")}
          </p>
          {expired.length > 0 && (
            <p className="text-xs text-danger mt-1">
              {t("{n} bucket(s) hold data past retention — {b} total.")
                .replace("{n}", String(expired.length))
                .replace("{b}", bytes(totalExpiredBytes))}
            </p>
          )}
        </div>
        <RefreshButton loading={isValidating} onClick={() => mutate()} />
      </header>

      {error && <ErrorPanel error={error} />}

      <section className="card overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={Recycle}
            title={t("No buckets have a retention rule yet")}
            hint={t("Open the Buckets page, edit a bucket's governance, and set a retention period.")}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead>
                <tr>
                  <th>{t("Cluster")}</th>
                  <th>{t("Bucket")}</th>
                  <th>{t("Owner")}</th>
                  <th className="num">{t("Retention")}</th>
                  <th className="num">{t("Expired")}</th>
                  <th>{t("Last scan")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <Row key={b.id} t={t} b={b} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ t, b }: { t: (k: string) => string; b: GovernedBucket }) {
  const hasExpired = b.expired_objects > 0;
  const sample = b.expired_sample ?? [];
  return (
    <tr>
      <td className="text-xs text-muted">{b.cluster_name || b.cluster_id.slice(0, 8)}</td>
      <td className="font-mono text-sm">{b.bucket_name}</td>
      <td className="text-xs">
        {b.owner_name || <span className="text-muted italic">{t("unassigned")}</span>}
        {b.owner_user_key && (
          <span className="block text-[10px] text-muted/70 font-mono">{b.owner_user_key}</span>
        )}
      </td>
      <td className="num text-xs">{b.retention_days != null ? `${b.retention_days}d` : "—"}</td>
      <td className="num">
        {b.last_scan_at ? (
          <span
            className={hasExpired ? "text-danger" : "text-muted"}
            title={sample.length ? `${t("e.g.")} ${sample.slice(0, 5).join(", ")}` : undefined}>
            {b.expired_objects.toLocaleString()}
            {hasExpired && (
              <span className="text-[10px] text-muted ml-1">({bytes(b.expired_bytes)})</span>
            )}
            {b.scan_truncated && (
              <span className="text-[10px] text-warning ml-1" title={t("scan hit the entry cap — count is a lower bound")}>
                ~
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted/40">{t("not scanned")}</span>
        )}
      </td>
      <td className="text-xs text-muted">
        {b.last_scan_at ? new Date(b.last_scan_at).toLocaleString() : "—"}
      </td>
    </tr>
  );
}
