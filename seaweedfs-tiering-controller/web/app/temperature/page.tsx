"use client";

// Temperature dashboard — visualises which collections have cooled
// down so operators can decide what to tier. Bands are computed from
// ClickHouse VolumeFeatures (reads_7d / reads_30d / quiet_for_seconds).
// The headline tells you "how much cold storage you have today"; the
// per-collection table shows the breakdown so you can pick the next
// candidate; the drilldown grid shows the individual volumes.

import { useMemo, useState } from "react";
import {
  Thermometer, Snowflake, Flame, RefreshCw, AlertTriangle, ArrowRight, Database,
} from "lucide-react";
import Link from "next/link";
import {
  useCollectionTemperatures, useVolumeTemperatures,
  type CollectionTemperature, type VolumeTemperature, type TempBand,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { bytes, pct } from "@/lib/utils";

// Band styling is colocated so the table, stacked bar, and drilldown
// grid all stay in sync. Bands go hot → frozen, color goes red → blue.
const BAND_ORDER: TempBand[] = ["hot", "warm", "cool", "cold", "frozen"];
const BAND_STYLES: Record<TempBand, { bg: string; text: string; border: string; bar: string }> = {
  hot:    { bg: "bg-rose-500/15",    text: "text-rose-300",    border: "border-rose-400/40",    bar: "bg-rose-500/70" },
  warm:   { bg: "bg-amber-500/15",   text: "text-amber-300",   border: "border-amber-400/40",   bar: "bg-amber-500/70" },
  cool:   { bg: "bg-sky-500/15",     text: "text-sky-300",     border: "border-sky-400/40",     bar: "bg-sky-500/70" },
  cold:   { bg: "bg-indigo-500/15",  text: "text-indigo-300",  border: "border-indigo-400/40",  bar: "bg-indigo-500/70" },
  frozen: { bg: "bg-slate-500/20",   text: "text-slate-300",   border: "border-slate-400/40",   bar: "bg-slate-400/60" },
};

export default function TemperaturePage() {
  const { t } = useT();
  return (
    <Can cap="volume.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { data, error, mutate, isLoading, isValidating } = useCollectionTemperatures();
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"total_size" | "cold_size" | "frozen_size" | "volumes" | "reads_7d">("total_size");
  const [showAnomalyOnly, setShowAnomalyOnly] = useState(false);

  const items = data?.items ?? [];
  const total = data?.total;

  // "Anomaly" = collection has both hot and cold volumes simultaneously.
  // Tier-by-collection policies would mis-classify these — they're the
  // ones worth investigating before drafting a policy.
  const sorted = useMemo(() => {
    const filtered = showAnomalyOnly
      ? items.filter(c => c.hot_n > 0 && (c.cold_n + c.frozen_n) > 0)
      : items;
    return [...filtered].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  }, [items, sortKey, showAnomalyOnly]);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <Thermometer size={20}/> {t("Temperature")}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            {t("Volume temperature classified from access patterns. Use this to find collections that have cooled down — they're the candidates for warm/cold tiering.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={showAnomalyOnly}
              onChange={(e) => setShowAnomalyOnly(e.target.checked)}
            />
            {t("Mixed temperature only")}
          </label>
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

      {error && <ErrorPanel error={error}/>}

      {total && (
        <HeadlineTiles total={total} t={t}/>
      )}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={8} headers={[t("Collection"), t("Volumes"), t("Total size"), t("Distribution"), t("Reads (7d)"), ""]}/>
        </section>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Thermometer}
          title={showAnomalyOnly ? t("No mixed-temperature collections") : t("No data yet")}
          hint={showAnomalyOnly
            ? t("Every collection has a uniform temperature. Tier-by-collection policies will work cleanly here.")
            : t("Volume features haven't been computed yet. Run the scorer or wait for the next snapshot.")}
        />
      ) : (
        <section className="card overflow-hidden">
          <table className="grid">
            <thead>
              <tr>
                <SortableTh sortKey="volumes" current={sortKey} onSort={setSortKey} t={t}>
                  {t("Collection")}
                </SortableTh>
                <SortableTh sortKey="volumes" current={sortKey} onSort={setSortKey} t={t} align="right">
                  {t("Volumes")}
                </SortableTh>
                <SortableTh sortKey="total_size" current={sortKey} onSort={setSortKey} t={t} align="right">
                  {t("Total size")}
                </SortableTh>
                <th>{t("Distribution")}</th>
                <SortableTh sortKey="cold_size" current={sortKey} onSort={setSortKey} t={t} align="right">
                  {t("Cold + Frozen")}
                </SortableTh>
                <SortableTh sortKey="reads_7d" current={sortKey} onSort={setSortKey} t={t} align="right">
                  {t("Reads (7d)")}
                </SortableTh>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <CollectionRow
                  key={row.collection || "__default__"}
                  row={row}
                  expanded={selected === row.collection}
                  onToggle={() => setSelected(s => s === row.collection ? null : row.collection)}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}

      <BandLegend t={t}/>
    </div>
  );
}

// ---- headline tiles ----

function HeadlineTiles({ total, t }: { total: Omit<CollectionTemperature, "collection">; t: (k: string) => string }) {
  const totalSize = total.total_size || 1;
  const coldShare = (total.cold_size + total.frozen_size) / totalSize;
  const hotShare = total.hot_size / totalSize;
  return (
    <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile
        icon={<Database size={14}/>}
        label={t("Total volumes")}
        value={total.volumes.toLocaleString()}
        sub={bytes(total.total_size)}
        tone="muted"
      />
      <Tile
        icon={<Flame size={14}/>}
        label={t("Hot")}
        value={total.hot_n.toLocaleString()}
        sub={`${bytes(total.hot_size)} · ${pct(hotShare)}`}
        tone="rose"
      />
      <Tile
        icon={<Snowflake size={14}/>}
        label={t("Cold + Frozen")}
        value={(total.cold_n + total.frozen_n).toLocaleString()}
        sub={`${bytes(total.cold_size + total.frozen_size)} · ${pct(coldShare)}`}
        tone="indigo"
      />
      <Tile
        icon={<AlertTriangle size={14}/>}
        label={t("Cool (recently cooled)")}
        value={total.cool_n.toLocaleString()}
        sub={`${bytes(total.cool_size)} · ${t("watch list")}`}
        tone="sky"
      />
    </section>
  );
}

function Tile({ icon, label, value, sub, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "muted" | "rose" | "indigo" | "sky";
}) {
  const toneClass = {
    muted: "text-muted",
    rose: "text-rose-300",
    indigo: "text-indigo-300",
    sky: "text-sky-300",
  }[tone];
  return (
    <div className="card p-3">
      <div className={`text-[11px] uppercase tracking-wide inline-flex items-center gap-1.5 ${toneClass}`}>
        {icon} {label}
      </div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      <div className="text-[11px] text-muted mt-0.5 tabular-nums">{sub}</div>
    </div>
  );
}

// ---- table row + drilldown ----

interface CollectionRowProps {
  row: CollectionTemperature;
  expanded: boolean;
  onToggle: () => void;
  t: (k: string) => string;
}
function CollectionRow({ row, expanded, onToggle, t }: CollectionRowProps) {
  const coldShare = row.total_size > 0
    ? (row.cold_size + row.frozen_size) / row.total_size
    : 0;
  return (
    <>
      <tr className="cursor-pointer hover:bg-panel2/40" onClick={onToggle}>
        <td>
          <span className="font-mono text-sm">{row.collection || <span className="text-muted/60">{t("(default)")}</span>}</span>
        </td>
        <td className="text-right font-mono text-xs text-muted">{row.volumes.toLocaleString()}</td>
        <td className="text-right font-mono text-xs">{bytes(row.total_size)}</td>
        <td className="min-w-[220px]">
          <DistributionBar row={row} t={t}/>
        </td>
        <td className="text-right font-mono text-xs">
          <span className={coldShare > 0.5 ? "text-indigo-300 font-medium" : ""}>
            {bytes(row.cold_size + row.frozen_size)}
          </span>
          <span className="text-muted text-[10px] ml-1">{pct(coldShare)}</span>
        </td>
        <td className="text-right font-mono text-xs text-muted">{row.reads_7d.toLocaleString()}</td>
        <td className="text-right">
          <button className="text-[11px] text-muted hover:text-text inline-flex items-center gap-1">
            {expanded ? t("Hide") : t("Drill down")} <ArrowRight size={11}/>
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-panel2/30 p-3">
            <VolumesDrilldown collection={row.collection} t={t}/>
          </td>
        </tr>
      )}
    </>
  );
}

function DistributionBar({ row, t }: { row: CollectionTemperature; t: (k: string) => string }) {
  const total = row.total_size || 1;
  // Render as a width-100% flex strip so even tiny shares stay visible
  // at >= 1px. We sort hot→frozen left-to-right to give a "thermal" feel.
  return (
    <div className="flex items-stretch gap-px h-3 rounded overflow-hidden bg-panel2/40" title={`${bytes(row.total_size)} total`}>
      {BAND_ORDER.map(band => {
        const sz = row[`${band}_size` as keyof CollectionTemperature] as number;
        const n  = row[`${band}_n`    as keyof CollectionTemperature] as number;
        if (!sz) return null;
        const share = sz / total;
        return (
          <div
            key={band}
            className={BAND_STYLES[band].bar}
            style={{ width: `${Math.max(0.5, share * 100)}%` }}
            title={`${t(bandKey(band))} · ${n} ${t("volumes")} · ${bytes(sz)} (${pct(share)})`}
          />
        );
      })}
    </div>
  );
}

function VolumesDrilldown({ collection, t }: { collection: string; t: (k: string) => string }) {
  const { data, error, isLoading } = useVolumeTemperatures(collection, 1000);
  if (error) return <ErrorPanel error={error}/>;
  if (isLoading || !data) {
    return <div className="text-xs text-muted py-4 text-center">{t("Loading…")}</div>;
  }
  const items = data.items;
  if (items.length === 0) {
    return <div className="text-xs text-muted py-4 text-center">{t("No volumes in this collection.")}</div>;
  }

  // Bucket by band; within each band, surface the biggest first.
  const byBand: Record<TempBand, VolumeTemperature[]> = {
    hot: [], warm: [], cool: [], cold: [], frozen: [],
  };
  for (const v of items) byBand[v.band].push(v);
  for (const b of BAND_ORDER) byBand[b].sort((a, b) => b.size_bytes - a.size_bytes);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">
          {t("Showing {n} volumes — biggest first per band.").replace("{n}", String(items.length))}
        </span>
        <Link
          href={`/policies?collection=${encodeURIComponent(collection)}`}
          className="text-xs text-accent hover:underline inline-flex items-center gap-1"
        >
          {t("Draft a policy for this collection")} <ArrowRight size={11}/>
        </Link>
      </div>
      {BAND_ORDER.map(band => {
        const vols = byBand[band];
        if (vols.length === 0) return null;
        const styles = BAND_STYLES[band];
        return (
          <div key={band} className="space-y-1">
            <div className={`text-[11px] uppercase tracking-wide inline-flex items-center gap-1.5 ${styles.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${styles.bar}`}/>
              {t(bandKey(band))} · {vols.length}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-1.5">
              {vols.slice(0, 60).map(v => (
                <VolumeCell key={v.volume_id} v={v} t={t}/>
              ))}
              {vols.length > 60 && (
                <div className="text-[10px] text-muted self-center">
                  +{vols.length - 60} {t("more")}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VolumeCell({ v, t }: { v: VolumeTemperature; t: (k: string) => string }) {
  const styles = BAND_STYLES[v.band];
  return (
    <Link
      href={`/volumes/${v.volume_id}`}
      className={`block border rounded px-1.5 py-1 ${styles.bg} ${styles.border} ${styles.text} hover:brightness-125`}
      title={
        `${t("Volume")} ${v.volume_id}\n` +
        `${t("Size")}: ${bytes(v.size_bytes)}\n` +
        `${t("Reads 7d")}: ${v.reads_7d}\n` +
        `${t("Reads 30d")}: ${v.reads_30d}\n` +
        `${t("Quiet for")}: ${humanDuration(v.quiet_for_seconds, t)}` +
        (v.is_readonly ? `\n${t("read-only")}` : "")
      }
    >
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="font-medium">#{v.volume_id}</span>
        {v.is_readonly && <span className="text-[9px] text-muted">RO</span>}
      </div>
      <div className="text-[10px] opacity-80 tabular-nums">{bytes(v.size_bytes)}</div>
    </Link>
  );
}

// ---- bits ----

interface SortableThProps {
  sortKey: "total_size" | "cold_size" | "frozen_size" | "volumes" | "reads_7d";
  current: string;
  onSort: (k: SortableThProps["sortKey"]) => void;
  t: (k: string) => string;
  align?: "left" | "right";
  children: React.ReactNode;
}
function SortableTh({ sortKey, current, onSort, align, children }: SortableThProps) {
  const active = sortKey === current;
  return (
    <th className={align === "right" ? "text-right" : undefined}>
      <button
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 ${active ? "text-text" : "text-muted hover:text-text"}`}
      >
        {children}
        {active && <span className="text-[10px]">▼</span>}
      </button>
    </th>
  );
}

function BandLegend({ t }: { t: (k: string) => string }) {
  return (
    <div className="card p-3 text-[11px] text-muted space-y-1">
      <div className="font-semibold text-text inline-flex items-center gap-1.5">
        <Thermometer size={12}/> {t("Temperature thresholds")}
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-5 gap-1.5">
        {BAND_ORDER.map(band => {
          const s = BAND_STYLES[band];
          return (
            <li key={band} className={`border rounded px-2 py-1 ${s.bg} ${s.border}`}>
              <span className={`font-semibold ${s.text}`}>{t(bandKey(band))}</span>
              <div className="text-[10px] opacity-80">{t(bandHint(band))}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- helpers ----

function bandKey(b: TempBand): string {
  return ({
    hot: "Hot", warm: "Warm", cool: "Cool", cold: "Cold", frozen: "Frozen",
  })[b];
}
function bandHint(b: TempBand): string {
  return ({
    hot:    "reads(7d) ≥ 50 or active in 1h",
    warm:   "any reads in 7d",
    cool:   "no 7d reads, had 30d reads",
    cold:   "zero 30d reads, last seen <90d",
    frozen: "untouched for ≥90d",
  })[b];
}

function humanDuration(secs: number, t: (k: string) => string): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return t("{n}d").replace("{n}", String(Math.floor(secs / 86400)));
}
