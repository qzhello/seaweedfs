"use client";

// Capacity forecast panel — the proactive twin of the capacity-incident
// banner. Each cluster's daily used-bytes history is fit to a line and
// projected to its capacity ceiling: "full in ~N days". Clusters are
// ordered worst-runway-first so the urgent ones surface at the top.

import { TrendingUp } from "lucide-react";
import { useCapacityForecast, type CapacityForecast } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";

// Worst runway first; no_data sinks to the bottom.
const STATUS_RANK: Record<string, number> = {
  critical: 0, warning: 1, ok: 2, stable: 3, no_data: 4,
};

export function CapacityForecastPanel() {
  const { t } = useT();
  const { data } = useCapacityForecast();
  const items = data?.items ?? [];

  // Nothing worth showing until at least one cluster has a real forecast.
  if (!items.some((i) => i.status !== "no_data")) return null;

  const ranked = [...items].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
  );
  const critical = items.filter((i) => i.status === "critical").length;

  return (
    <section className="card p-4 space-y-3">
      <header className="inline-flex items-center gap-2 text-sm font-semibold">
        <TrendingUp size={16} className={critical > 0 ? "text-danger" : "text-accent"} />
        {t("Capacity forecast")}
        {critical > 0 && (
          <span className="badge border-danger/40 text-danger">
            {t("{n} critical").replace("{n}", String(critical))}
          </span>
        )}
      </header>
      <ul className="space-y-1.5">
        {ranked.map((f) => (
          <ForecastRow key={f.cluster_id} t={t} f={f} />
        ))}
      </ul>
    </section>
  );
}

function ForecastRow({ t, f }: { t: (k: string) => string; f: CapacityForecast }) {
  const runwayTone =
    f.status === "critical" ? "text-danger"
    : f.status === "warning" ? "text-warning"
    : f.status === "stable" ? "text-success"
    : "text-muted";
  const barTone =
    f.percent_full >= 85 ? "bg-danger"
    : f.percent_full >= 70 ? "bg-warning"
    : "bg-accent";

  return (
    <li className="rounded-lg border border-border bg-panel2/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-text shrink-0 w-32 truncate" title={f.cluster_name}>
          {f.cluster_name}
        </span>
        <div className="flex-1 min-w-[3rem]">
          <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
            <div
              className={`h-full ${barTone}`}
              style={{ width: `${Math.min(100, Math.max(0, f.percent_full))}%` }}
            />
          </div>
        </div>
        <span className="text-[11px] text-muted tabular-nums shrink-0 hidden sm:inline">
          {bytes(f.used_bytes)} / {bytes(f.capacity_bytes)}
        </span>
        <span className={`text-xs font-medium shrink-0 w-28 text-right ${runwayTone}`}>
          {runwayLabel(t, f)}
        </span>
      </div>
      <div className="text-[10px] text-muted/70 mt-1">
        {f.note}
        {f.status !== "no_data" && f.status !== "stable" && f.growth_bytes_per_day > 0 && (
          <> {" · "}{bytes(f.growth_bytes_per_day)}/{t("day")}{" · "}{t("confidence")}: {f.confidence}</>
        )}
      </div>
    </li>
  );
}

function runwayLabel(t: (k: string) => string, f: CapacityForecast): string {
  if (f.status === "no_data") return t("no data");
  if (f.status === "stable") return t("stable");
  if (f.days_to_full == null) return "—";
  const d = Math.round(f.days_to_full);
  if (d <= 0) return t("full");
  if (d > 3650) return t("full in >10y");
  return t("full in ~{n}d").replace("{n}", String(d));
}
