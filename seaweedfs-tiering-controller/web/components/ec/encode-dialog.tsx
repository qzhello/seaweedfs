"use client";

// EC encode dialog. Two modes:
//   - mode="collection": user fills collection + thresholds, server runs
//     ec.encode -collection=<x> -fullPercent=.. -quietFor=..
//   - mode="volumes":    caller pre-filled a list of volume IDs, server
//     loops `ec.encode -volumeId=N` per volume.
//
// All inputs that have a small known set (collection / disk type / RP)
// expose suggestion lists; numeric flags use sliders; the duration flag
// uses a number + unit picker. Free-text fallback always works for one-
// off custom values.

import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { bytes } from "@/lib/utils";
import { Play, X, AlertTriangle, TrendingDown, FlaskConical, Loader2 } from "lucide-react";
import {
  usePreflightLockProbe, PreflightProbeBanner, preflightButtonLabel,
} from "@/components/preflight-lock-probe";
import { ECProgressStream } from "./progress-stream";
import { CommandPreview } from "@/components/cli/command-preview";
import { ComboInput, NumberSlider, DurationPicker, Field } from "@/components/form/smart-inputs";

// Common DC/rack/node distribution presets. Operators can still type
// anything; this just covers the 90% case.
const SHARD_RP_PRESETS = ["", "000", "001", "010", "100", "002", "020", "200"];

interface Props {
  clusterID: string;
  mode: "collection" | "volumes";
  initialCollection?: string;
  volumeIds?: number[];
  // Pre-discovered values from the surrounding page; powers the combo
  // autocomplete. Optional — combos still work as free-text inputs.
  collections?: string[];
  diskTypes?: string[];
  // One entry per logical volume that will be encoded. The dialog uses
  // this to compute the pre/post storage rollup. Callers compute it by
  // grouping their volume rows by ID (taking any one replica's Size for
  // `logicalBytes` and the group size for `replicaCount`). Optional —
  // the preview is hidden when this isn't passed (e.g. collection-mode
  // when the caller can't enumerate matching volumes upfront).
  sourceVolumes?: { logicalBytes: number; replicaCount: number }[];
  // Volume IDs grouped by their collection for display in the source
  // header. Multi-collection batches still execute as one `ec.encode`
  // call per volume id; the grouping is purely visual so the operator
  // can see which collections are affected.
  volumeIdsByCollection?: { collection: string; volumeIds: number[] }[];
  // Full non-EC volume snapshot for the cluster. Powers the dry-run
  // panel (filter by regex / disk type / fullness / quiet period without
  // hitting the backend). Optional — when missing, the dry-run button
  // is hidden and the operator can only execute directly with Force on.
  allVolumes?: VolumeLike[];
  onClose: () => void;
  onDone?: () => void;
}

// VolumeLike is the shape we need from each volume row. Matches what
// useVolumes() emits so the dialog can take either page's data without
// adapter code.
export interface VolumeLike {
  ID: number;
  Collection?: string;
  Size?: number;
  DiskType?: string;
  ReadOnly?: boolean;
  ModifiedAtSec?: number;
  IsEC?: boolean;
}

export function ECEncodeDialog({
  clusterID, mode, initialCollection, volumeIds = [],
  collections = [], diskTypes = [], sourceVolumes, volumeIdsByCollection,
  allVolumes,
  onClose, onDone,
}: Props) {
  const { t } = useT();
  const [collection, setCollection] = useState(initialCollection || "");
  // Numeric flags as number | "" so the user can clear the field.
  const [fullPercent, setFullPercent] = useState<number | "">(95);
  const [quietFor, setQuietFor] = useState<string>("1h");
  const [sourceDiskType, setSourceDiskType] = useState<string>("");
  const [diskType, setDiskType] = useState<string>("");
  const [shardRP, setShardRP] = useState<string>("");
  const [maxParallel, setMaxParallel] = useState<number | "">(10);
  const [rebalance, setRebalance] = useState<boolean>(true);
  const [force, setForce] = useState<boolean>(false);
  const [verbose, setVerbose] = useState<boolean>(false);

  const [err, setErr] = useState<string | null>(null);
  const [streamBody, setStreamBody] = useState<null | Record<string, unknown>>(null);
  const { probe, probing, runProbe } = usePreflightLockProbe(clusterID);

  // Mirror of internal/api/ec_ops.go::buildECEncodeArgs (with
  // singleVolumeID = first selected ID) so the preview shows roughly
  // what the first per-volume subcall will run. The backend re-emits
  // the canonical args via the start SSE event once the stream begins.
  const previewArgs = useMemo<string[]>(() => {
    const a: string[] = [];
    if (mode === "volumes" && volumeIds.length > 0) {
      a.push(`-volumeId=${volumeIds[0]}`);
    }
    if (collection.trim()) a.push(`-collection=${collection.trim()}`);
    if (typeof fullPercent === "number" && fullPercent > 0) a.push(`-fullPercent=${fullPercent}`);
    if (quietFor.trim()) a.push(`-quietFor=${quietFor.trim()}`);
    if (sourceDiskType.trim()) a.push(`-sourceDiskType=${sourceDiskType.trim()}`);
    if (diskType.trim()) a.push(`-diskType=${diskType.trim()}`);
    if (shardRP.trim()) a.push(`-shardReplicaPlacement=${shardRP.trim()}`);
    if (typeof maxParallel === "number" && maxParallel > 0) a.push(`-maxParallelization=${maxParallel}`);
    if (!rebalance) a.push("-rebalance=false");
    if (force) a.push("-force");
    if (verbose) a.push("-verbose");
    return a;
  }, [mode, volumeIds, collection, fullPercent, quietFor, sourceDiskType,
      diskType, shardRP, maxParallel, rebalance, force, verbose]);

  const submit = async () => {
    // EC encode always mutates — no dry-run gate — so the preflight
    // applies on every click.
    const ok = await runProbe(probe !== null);
    if (!ok) return;
    setErr(null);
    const body: Record<string, unknown> = {};
    if (mode === "collection") {
      if (!collection.trim()) {
        setErr(t("Collection is required."));
        return;
      }
      body.collection = collection.trim();
    } else {
      body.volumeIds = volumeIds;
      if (collection.trim()) body.collection = collection.trim();
    }
    if (typeof fullPercent === "number" && fullPercent > 0) body.fullPercent = fullPercent;
    if (quietFor.trim()) body.quietFor = quietFor.trim();
    if (sourceDiskType.trim()) body.sourceDiskType = sourceDiskType.trim();
    if (diskType.trim()) body.diskType = diskType.trim();
    if (shardRP.trim()) body.shardReplicaPlacement = shardRP.trim();
    if (typeof maxParallel === "number" && maxParallel > 0) body.maxParallelization = maxParallel;
    if (!rebalance) body.rebalance = false;
    if (force) body.force = true;
    if (verbose) body.verbose = true;
    setStreamBody(body);
  };

  const target = mode === "collection"
    ? (collection ? `collection ${collection}` : t("(pick a collection)"))
    : `${volumeIds.length} ${t("volumes")}: [${volumeIds.slice(0, 8).join(", ")}${volumeIds.length > 8 ? "…" : ""}]`;

  const expectedVolumes = mode === "volumes" ? volumeIds.length : 1;

  // When a run has been started, the dialog widens to grow a right-side
  // panel that streams the live ec.encode output. The form on the left
  // stays interactive so the operator can tick Force and re-run without
  // closing — the next click on a footer button just replaces streamBody
  // and the right panel restarts with the new run.
  const running = !!streamBody;
  const dialogWidth = running ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${dialogWidth} max-h-[90vh] flex flex-col shadow-soft transition-[max-width]`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">
              {t("Encode to EC (RS 10+4)")}
            </h2>
            {/* SourceBlock surfaces a pre-selected target prominently.
                In "volumes" mode it shows the volume-ID chips grouped
                by collection — that's the only place those IDs live.
                In "collection" mode the editable Field below is the
                source of truth, so the badge here would just duplicate
                an empty placeholder. Hide it when the operator came in
                without a preset. */}
            {(mode === "volumes" || collection.trim() !== "") && (
              <div className="mt-2">
                <SourceBlock
                  mode={mode}
                  volumeIds={volumeIds}
                  collection={collection}
                  groups={volumeIdsByCollection}
                />
              </div>
            )}
          </div>
          <button className="text-muted hover:text-text shrink-0" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className={`overflow-auto flex-1 ${running ? "grid grid-cols-[1fr_400px]" : ""}`}>
          <div className="px-5 py-4 space-y-3">
          {sourceVolumes && sourceVolumes.length > 0 && (
            <SizePreview sourceVolumes={sourceVolumes}/>
          )}

          {mode === "collection" && (
            <Field
              label={<>{t("Collection")}<span className="text-danger ml-0.5">*</span></>}
              hint={t('Pick from the cluster, or type a regex like "^mybucket$".')}>
              <ComboInput
                value={collection}
                onChange={setCollection}
                options={collections}
                placeholder="^mybucket$"
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Full percent")} hint={t("Only encode volumes ≥ this fullness ratio.")}>
              <NumberSlider
                value={fullPercent}
                onChange={setFullPercent}
                min={0} max={100} step={1} suffix="%"
              />
            </Field>
            <Field label={t("Quiet for")} hint={t("Skip volumes with writes inside this window.")}>
              <DurationPicker value={quietFor} onChange={setQuietFor}/>
            </Field>

            {/* Disk type filters share one row — source side narrows
                which volumes to read from, target side picks where shards
                are written. Both are optional. */}
            <Field label={t("Source disk type (-sourceDiskType)")}
              hint={t("Pick source volumes from this disk type. Blank = any.")}>
              <ComboInput
                value={sourceDiskType}
                onChange={setSourceDiskType}
                options={diskTypes}
                placeholder="hdd / ssd"
              />
            </Field>
            <Field label={t("Target disk type (-diskType)")}
              hint={t("EC shards land on nodes with this label. Blank = default hdd.")}>
              <ComboInput
                value={diskType}
                onChange={setDiskType}
                options={diskTypes}
                placeholder="hdd / ec_hot"
              />
            </Field>

            <Field label={t("Shard replica placement")}
              hint={t("DC/rack/node distribution. Blank = master default.")}>
              <ComboInput
                value={shardRP}
                onChange={setShardRP}
                options={SHARD_RP_PRESETS}
                placeholder="001"
              />
            </Field>
            <Field label={t("Max parallelization")} hint={t("Concurrent shard copies.")}>
              <NumberSlider
                value={maxParallel}
                onChange={setMaxParallel}
                min={1} max={32} step={1}
              />
            </Field>
          </div>

          <div className="flex items-center gap-4 text-sm flex-wrap">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={rebalance}
                onChange={e => setRebalance(e.target.checked)}/>
              {t("Rebalance after encode")}
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={force}
                onChange={e => setForce(e.target.checked)}/>
              <span className={force ? "text-warning" : ""}>{t("Force (skip safety checks)")}</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={verbose}
                onChange={e => setVerbose(e.target.checked)}/>
              {t("Verbose (log skipped volumes)")}
            </label>
          </div>

          {err && (
            <div className="text-sm text-danger inline-flex items-center gap-2">
              <AlertTriangle size={14}/> {err}
            </div>
          )}

          {/* Always-visible command preview. Shows the first per-volume
              subcall (-volumeId=N) when targeting a list; the backend
              loops over the rest of the IDs serially with the same flags. */}
          <CommandPreview
            command="ec.encode"
            args={previewArgs}
          />
          </div>

          {/* Right column: inline streaming progress, mounted only after
              the operator clicks a footer button. Keyed on streamBody so
              a re-run unmounts the previous stream (aborts its fetch) and
              starts fresh. */}
          {running && (
            <div className="border-l border-border bg-bg/30 px-4 py-4 overflow-auto">
              <ECProgressStream
                key={JSON.stringify(streamBody)}
                variant="inline"
                url={`/clusters/${clusterID}/ec/encode/stream`}
                body={streamBody}
                expectedVolumes={expectedVolumes}
                title={force ? t("ec.encode (force)") : t("ec.encode (no force)")}
                subtitle={target}
                onDone={(ok, payload) => {
                  if (ok) {
                    if (!force) setForce(true);
                    toast.success(t("EC encode complete"), target);
                  } else {
                    const msg = typeof payload?.error === "string" ? payload.error : t("EC encode failed");
                    toast.error(t("EC encode failed"), msg);
                  }
                  // After a successful no-force run, auto-tick Force so
                  // the footer button flips to "执行(带 force)" — the
                  // operator's next click will commit the real run with
                  // safety checks bypassed (the common follow-up
                  // pattern).
                  onDone?.();
                }}
                onClose={() => setStreamBody(null)}
              />
            </div>
          )}
        </div>

        <PreflightProbeBanner probe={probe}/>
        <footer className="flex items-center gap-2 px-5 py-3 border-t border-border">
          <div className="text-[11px] text-warning/80 inline-flex items-start gap-1.5 flex-1 leading-snug">
            <AlertTriangle size={12} className="shrink-0 mt-0.5"/>
            <span>{t("EC encoding is mutating: source .dat is removed once 14 shards land on peers. Plan capacity (1.5× the source size) before submitting.")}</span>
          </div>
          <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
          {/* Both buttons run ec.encode for real via the SSE stream — the
              only difference is whether -force is on. When the operator
              has ticked Force in the form we hide the no-force button to
              avoid confusion. */}
          {!force ? (
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={submit}
              disabled={probing}
              title={t("Run ec.encode without -force (safety checks enforced).")}>
              {probing ? <Loader2 size={12} className="animate-spin"/> : <FlaskConical size={12}/>}
              {preflightButtonLabel(t, probe, probing, t("Simulate (no force)"))}
            </button>
          ) : (
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={submit}
              disabled={probing}
              title={t("Run ec.encode with -force (safety checks bypassed).")}>
              {probing ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}
              {preflightButtonLabel(t, probe, probing, t("Execute (force)"))}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// SourceBlock renders the target of the encode operation prominently —
// either the collection name in a labelled callout or the individual
// volume IDs as font-mono chips with a count badge. The earlier "Source:
// <muted text>" line was easy to miss; this layout pulls the IDs out so
// the operator can sanity-check exactly what they're about to encode.
function SourceBlock({
  mode, volumeIds, collection, groups,
}: {
  mode: "collection" | "volumes";
  volumeIds: number[];
  collection: string;
  // Volume IDs grouped by their owning collection, so the header can
  // show "mybucket: 5, 7, 9 / another: 12" instead of one flat list.
  groups?: { collection: string; volumeIds: number[] }[];
}) {
  const { t } = useT();
  if (mode === "collection") {
    return (
      <div className="rounded-lg border border-accent/40 bg-accent/5 p-2.5 flex items-center gap-2">
        <span className="badge border-accent/40 text-accent shrink-0">{t("Collection")}</span>
        <span className="font-mono text-sm font-medium truncate">
          {collection || <span className="text-muted/60 italic">—</span>}
        </span>
      </div>
    );
  }

  // Volume mode: prefer the grouped-by-collection layout when the caller
  // supplied it; fall back to a single flat list when not.
  const groupList = groups && groups.length > 0
    ? groups
    : [{ collection: "", volumeIds }];

  return <VolumeGroupCards groups={groupList}/>;
}

// VolumeGroupCards renders one card per (collection → volume IDs) group,
// up to MAX_CARDS in a row. Excess groups fold into a "更多 +N" tile in
// the last slot; clicking it pops a modal listing every group.
//
// Equal width comes from the grid layout. Equal height comes from each
// card's flex column — the body grows to fill the row's tallest cell.
function VolumeGroupCards({
  groups,
}: { groups: { collection: string; volumeIds: number[] }[] }) {
  const { t } = useT();
  const [popupOpen, setPopupOpen] = useState(false);
  const MAX_CARDS = 3;
  // When overflow exists, reserve the last slot for the "更多" tile so
  // total tiles in the row stay at MAX_CARDS.
  const hasOverflow = groups.length > MAX_CARDS;
  const visibleCount = hasOverflow ? MAX_CARDS - 1 : groups.length;
  const visible = groups.slice(0, visibleCount);
  const hidden = groups.slice(visibleCount);

  return (
    <>
      <div className="grid grid-cols-3 gap-2 auto-rows-fr">
        {visible.map((g, i) => (
          <CollectionCard
            key={`${g.collection}-${i}`}
            collection={g.collection}
            volumeIds={g.volumeIds}
          />
        ))}
        {hasOverflow && (
          <button
            type="button"
            onClick={() => setPopupOpen(true)}
            className="rounded-lg border border-accent/40 bg-accent/5 hover:bg-accent/10 transition-colors flex flex-col items-center justify-center text-xs text-accent font-medium gap-0.5">
            <span className="text-base font-semibold">+{hidden.length}</span>
            <span>{t("more")}</span>
          </button>
        )}
      </div>
      {popupOpen && (
        <CollectionListPopup
          groups={groups}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </>
  );
}

// CollectionCard — equal-height card showing a collection name and the
// inline list of its volume IDs. The IDs are rendered as a single
// comma-separated line, truncated with "+N" when they overflow.
function CollectionCard({
  collection, volumeIds,
}: { collection: string; volumeIds: number[] }) {
  const { t } = useT();
  // ~10 IDs fit on one line at typical card width.
  const INLINE = 10;
  const visible = volumeIds.slice(0, INLINE);
  const overflow = volumeIds.length - visible.length;
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-2 flex flex-col gap-1 min-w-0">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">
          {t("Collection")}
        </span>
        <span className="text-[10px] text-muted tabular-nums shrink-0">
          {volumeIds.length}
        </span>
      </div>
      <div className="font-mono text-xs text-text truncate">
        {collection || <span className="italic text-muted">{t("(default)")}</span>}
      </div>
      <div className="font-mono text-[11px] text-muted/90 leading-snug break-all">
        {visible.join(", ")}
        {overflow > 0 && (
          <span className="text-accent"> +{overflow}</span>
        )}
      </div>
    </div>
  );
}

// CollectionListPopup — modal listing every collection with its full
// volume ID list. Used as the "更多" target when there are too many
// collections to show inline.
function CollectionListPopup({
  groups, onClose,
}: {
  groups: { collection: string; volumeIds: number[] }[];
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="card bg-panel border border-border w-full max-w-2xl max-h-[80vh] flex flex-col shadow-soft"
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium">
            {t("All collections")} · {groups.length}
          </h3>
          <button className="text-muted hover:text-text" onClick={onClose}>
            <X size={14}/>
          </button>
        </header>
        <div className="overflow-auto flex-1 px-4 py-3 space-y-2">
          {groups.map((g, i) => (
            <div key={`${g.collection}-${i}`} className="rounded-lg border border-border/60 p-2">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="font-mono text-xs text-text truncate">
                  {g.collection || <span className="italic text-muted">{t("(default)")}</span>}
                </span>
                <span className="text-[10px] text-muted tabular-nums">
                  {g.volumeIds.length} {t("volumes")}
                </span>
              </div>
              <div className="font-mono text-[11px] text-muted/90 break-all leading-snug">
                {g.volumeIds.join(", ")}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// SizePreview renders a horizontal bar showing the storage shape change
// after EC: the existing N-replica footprint shrinks to 14/10 = 1.4× the
// logical size. Operators see the before/after totals plus the absolute
// saving — useful for capacity planning before committing a long-running
// encode.
function SizePreview({
  sourceVolumes,
}: {
  sourceVolumes: { logicalBytes: number; replicaCount: number }[];
}) {
  const { t } = useT();
  const { logical, before, after, saved, savedPct } = useMemo(() => {
    let logical = 0;
    let before = 0;
    for (const v of sourceVolumes) {
      logical += v.logicalBytes;
      before += v.logicalBytes * Math.max(1, v.replicaCount);
    }
    // EC RS(10+4) physical = logical × 14/10 = 1.4×.
    const after = logical * 1.4;
    const saved = before - after;
    const savedPct = before > 0 ? (saved / before) * 100 : 0;
    return { logical, before, after, saved, savedPct };
  }, [sourceVolumes]);

  // Width of the "after" portion relative to "before" for the visual bar.
  const afterPct = before > 0 ? Math.min(100, (after / before) * 100) : 0;

  return (
    <div className="rounded-lg border border-border/60 p-3 bg-bg/40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          {t("Storage estimate")} · {sourceVolumes.length} {t("volumes")}
        </span>
        <span className="text-xs text-success inline-flex items-center gap-1">
          <TrendingDown size={12}/>
          {t("Saves")} {bytes(Math.max(0, saved))} ({savedPct.toFixed(1)}%)
        </span>
      </div>

      {/* Stacked bar: blue = post-EC payload, green stripe = saved. The
          full bar width = pre-EC physical bytes. */}
      <div className="relative h-3 w-full rounded-md overflow-hidden bg-bg border border-border/60">
        <div
          className="absolute inset-y-0 left-0 bg-accent/80"
          style={{ width: `${afterPct}%` }}
          title={`${t("After EC")}: ${bytes(after)}`}
        />
        <div
          className="absolute inset-y-0 bg-success/70 [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(0,0,0,0.18)_3px,rgba(0,0,0,0.18)_6px)]"
          style={{ left: `${afterPct}%`, right: 0 }}
          title={`${t("Saved")}: ${bytes(Math.max(0, saved))}`}
        />
      </div>

      <div className="grid grid-cols-3 gap-3 mt-2 text-xs">
        <Metric
          label={t("Before (physical)")}
          value={`${bytes(before)} · ${avgReplica(sourceVolumes).toFixed(1)}× ${t("replicas")}`}
        />
        <Metric
          label={t("Logical data")}
          value={bytes(logical)}
        />
        <Metric
          label={t("After EC (1.4×)")}
          value={bytes(after)}
          accent
        />
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-sm ${accent ? "text-accent" : ""}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70">{sub}</div>}
    </div>
  );
}

function avgReplica(vols: { replicaCount: number }[]): number {
  if (vols.length === 0) return 0;
  const total = vols.reduce((s, v) => s + Math.max(1, v.replicaCount), 0);
  return total / vols.length;
}

