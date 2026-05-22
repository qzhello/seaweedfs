"use client";

// Cost showback section for the Costs page — attributes monthly spend to
// the responsible person (bucket owner) or the business domain, so each
// team can see what their storage costs. Toggle switches the grouping.

import { useState } from "react";
import { Users } from "lucide-react";
import { useShowback } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes as fmtBytes, pct } from "@/lib/utils";

export function ShowbackSection({ clusterID }: { clusterID: string }) {
  const { t } = useT();
  const { data } = useShowback(clusterID);
  const [mode, setMode] = useState<"owner" | "domain">("owner");

  if (!data) return null;
  const rows = mode === "owner" ? data.by_owner : data.by_domain;
  if (rows.length === 0) return null;
  const total = data.total_monthly_cost;

  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold inline-flex items-center gap-2">
          <Users size={12} /> {t("Cost attribution (showback)")}
        </span>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {(["owner", "domain"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                mode === m
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-panel2 hover:text-text"
              }`}>
              {m === "owner" ? t("By owner") : t("By business domain")}
            </button>
          ))}
        </div>
      </header>
      <table className="grid">
        <thead>
          <tr>
            <th>{mode === "owner" ? t("Owner") : t("Business domain")}</th>
            <th className="text-right">{t("Buckets")}</th>
            <th className="text-right">{t("Bytes")}</th>
            <th className="text-right">{t("Monthly cost")}</th>
            <th>{t("Share")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const share = total > 0 ? g.monthly_cost / total : 0;
            const unassigned = g.key === "(unassigned)";
            return (
              <tr key={g.key}>
                <td className={unassigned ? "text-xs text-muted italic" : "text-sm"}>
                  {unassigned ? t("(unassigned)") : g.key}
                </td>
                <td className="text-right font-mono text-xs">{g.buckets}</td>
                <td className="text-right font-mono text-xs">{fmtBytes(g.physical_bytes)}</td>
                <td className="text-right font-mono text-sm">
                  {data.currency} {g.monthly_cost.toFixed(2)}
                </td>
                <td className="min-w-[140px]">
                  <div className="h-1.5 bg-panel2 rounded overflow-hidden">
                    <div
                      className={`h-full ${unassigned ? "bg-muted" : "bg-accent"}`}
                      style={{ width: `${Math.max(2, share * 100)}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-muted font-mono mt-0.5">{pct(share)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.unpriced_bytes > 0 && (
        <div className="px-3 py-2 text-[11px] text-muted border-t border-border">
          {t("Excludes {n} on backends with no pricing.").replace("{n}", fmtBytes(data.unpriced_bytes))}
        </div>
      )}
    </section>
  );
}
