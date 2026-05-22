"use client";

// Unified dialog for ec.rebuild + ec.balance. Both commands default to
// dry-run; the Apply checkbox flips them to "actually run". Dry-run hits
// the `/plan` endpoint (blocking → parsed summary). Apply hits `/apply`
// (SSE stream → live progress panel).

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AlertTriangle, Play, X, Loader2 } from "lucide-react";
import { ECProgressStream } from "./progress-stream";
import { ComboInput, NumberSlider, Field } from "@/components/form/smart-inputs";
import { CommandPreview } from "@/components/cli/command-preview";

type Kind = "rebuild" | "balance";

const SHARD_RP_PRESETS = ["", "000", "001", "010", "100", "002", "020", "200"];

interface Props {
  kind: Kind;
  clusterID: string;
  initialCollection?: string;
  collections?: string[];
  diskTypes?: string[];
  dataCenters?: string[];
  onClose: () => void;
}

export function ECPlanDialog({
  kind, clusterID, initialCollection,
  collections = [], diskTypes = [], dataCenters = [],
  onClose,
}: Props) {
  const { t } = useT();

  const [collection, setCollection] = useState(initialCollection || "");
  const [diskType, setDiskType] = useState("");
  const [dataCenter, setDataCenter] = useState("");           // balance only
  const [shardRP, setShardRP] = useState("");                 // balance only
  const [maxParallel, setMaxParallel] = useState<number | "">("");
  const [apply, setApply] = useState(false);

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Dry-run result.
  const [summary, setSummary] = useState<null | {
    rebuildable: number; unrecoverable: number;
    degraded: { volume_id: number; collection?: string; missing_shards: number[]; rebuildable: boolean }[];
  }>(null);
  const [moves, setMoves] = useState<number | null>(null);
  const [output, setOutput] = useState<string>("");
  const [started, setStarted] = useState(false);
  // Apply path: when set, swap to the streaming progress panel.
  const [streamBody, setStreamBody] = useState<null | Record<string, unknown>>(null);

  const title = kind === "rebuild" ? "rebuild" : "balance";
  const hint = kind === "rebuild"
    ? t("Scan EC volumes for missing shards. With Apply: rebuild them using surviving shards.")
    : t("Move EC shards to balance load across DCs / racks / nodes. With Apply: actually move them.");

  // Mirror of internal/api/ec_ops.go::buildECRebuildArgs / buildECBalanceArgs.
  const previewArgs = useMemo<string[]>(() => {
    const col = collection.trim() || "EACH_COLLECTION";
    const a = [`-collection=${col}`];
    if (kind === "balance") {
      if (dataCenter.trim()) a.push(`-dataCenter=${dataCenter.trim()}`);
    }
    if (diskType.trim()) a.push(`-diskType=${diskType.trim()}`);
    if (kind === "balance" && shardRP.trim()) {
      a.push(`-shardReplicaPlacement=${shardRP.trim()}`);
    }
    if (typeof maxParallel === "number" && maxParallel > 0) {
      a.push(`-maxParallelization=${maxParallel}`);
    }
    if (apply) a.push("-apply");
    return a;
  }, [kind, collection, diskType, dataCenter, shardRP, maxParallel, apply]);

  const baseBody = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    if (collection.trim()) b.collection = collection.trim();
    if (diskType.trim()) b.diskType = diskType.trim();
    if (typeof maxParallel === "number" && maxParallel > 0) b.maxParallelization = maxParallel;
    if (kind === "balance") {
      if (dataCenter.trim()) b.dataCenter = dataCenter.trim();
      if (shardRP.trim()) b.shardReplicaPlacement = shardRP.trim();
    }
    return b;
  };

  const run = async () => {
    setErr(null);
    if (apply) {
      // Apply mode: hand off to the streaming progress component which
      // hits the /apply endpoint (SSE).
      setStreamBody(baseBody());
      return;
    }
    // Dry-run mode.
    setRunning(true); setStarted(true); setSummary(null); setMoves(null); setOutput("");
    try {
      if (kind === "rebuild") {
        const r = await api.ecRebuildPlan(clusterID, baseBody());
        setSummary(r.summary);
        setOutput(r.output || "");
      } else {
        const r = await api.ecBalancePlan(clusterID, baseBody());
        setMoves(r.moves);
        setOutput(r.output || "");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // Apply path runs in the right column of the same dialog rather than
  // replacing the view — operators can see the form they submitted plus
  // the live stream side-by-side, and re-run inline.
  const runningApply = !!streamBody;
  const dialogWidth = runningApply ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${dialogWidth} max-h-[90vh] flex flex-col shadow-soft transition-[max-width]`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            <p className="text-xs text-muted mt-0.5">{hint}</p>
          </div>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className={`overflow-auto flex-1 ${runningApply ? "grid grid-cols-[1fr_400px]" : ""}`}>
          <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Collection")}
              hint={t('Empty = EACH_COLLECTION (all). Pick from list or type a regex.')}>
              <ComboInput
                value={collection}
                onChange={setCollection}
                options={collections}
                placeholder="EACH_COLLECTION"
              />
            </Field>
            <Field label={t("Disk type")}
              hint={t("Must match the diskType EC shards live on. Blank = default hdd.")}>
              <ComboInput
                value={diskType}
                onChange={setDiskType}
                options={diskTypes}
                placeholder="hdd / ssd"
              />
            </Field>
            {kind === "balance" && (
              <>
                <Field label={t("Data center")}
                  hint={t("Limit balancing to this DC. Blank = all DCs.")}>
                  <ComboInput
                    value={dataCenter}
                    onChange={setDataCenter}
                    options={dataCenters}
                  />
                </Field>
                <Field label={t("Shard replica placement")}
                  hint={t("DC/rack/node distribution, e.g. 001 or 200. Blank = master default.")}>
                  <ComboInput
                    value={shardRP}
                    onChange={setShardRP}
                    options={SHARD_RP_PRESETS}
                    placeholder="001"
                  />
                </Field>
              </>
            )}
            <Field label={t("Max parallelization")}
              hint={t("Default 10. Lower under load.")}>
              <NumberSlider
                value={maxParallel === "" ? 10 : maxParallel}
                onChange={setMaxParallel}
                min={1} max={32} step={1}
              />
            </Field>
          </div>

          <label className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
            apply ? "border-warning/40 bg-warning/5" : "border-border/60"
          }`}>
            <input
              type="checkbox" className="mt-0.5 accent-accent"
              checked={apply} onChange={e => setApply(e.target.checked)}/>
            <div>
              <div className={`text-sm font-medium ${apply ? "text-warning" : ""}`}>
                {t("Apply (actually run)")}
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {t("Unchecked = dry-run (plan only, no data is written). Checked = real run with live streaming progress.")}
              </div>
            </div>
          </label>

          {err && (
            <div className="text-sm text-danger inline-flex items-center gap-2">
              <AlertTriangle size={14}/> {err}
            </div>
          )}

          {/* Dry-run summary */}
          {!apply && summary && (
            <div className={`p-3 rounded border ${
              summary.unrecoverable > 0 ? "border-danger/40 bg-danger/5"
              : summary.rebuildable > 0 ? "border-warning/40 bg-warning/5"
              : "border-success/40 bg-success/5"
            }`}>
              {summary.unrecoverable > 0 ? (
                <div className="text-sm text-danger">
                  {summary.unrecoverable} {t("unrecoverable volume(s)")} · {summary.rebuildable} {t("rebuildable")}
                </div>
              ) : summary.rebuildable > 0 ? (
                <div className="text-sm text-warning">
                  {summary.rebuildable} {t("volume(s) need rebuild — tick Apply to run.")}
                </div>
              ) : (
                <div className="text-sm text-success">{t("All EC volumes are healthy.")}</div>
              )}
              {summary.degraded.length > 0 && (
                <ul className="text-xs text-muted mt-2 space-y-0.5 font-mono max-h-40 overflow-auto">
                  {summary.degraded.slice(0, 16).map(d => (
                    <li key={d.volume_id}>
                      vol {d.volume_id}{d.collection ? ` · ${d.collection}` : ""}
                      {" · missing ["}
                      <span className={d.rebuildable ? "text-warning" : "text-danger"}>
                        {d.missing_shards.join(" ")}
                      </span>
                      {"]"}{!d.rebuildable && <span className="text-danger"> · unrecoverable</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!apply && moves != null && (
            <div className={`p-3 rounded border ${
              moves > 0 ? "border-accent/40 bg-accent/5" : "border-success/40 bg-success/5"
            }`}>
              {moves > 0 ? (
                <div className="text-sm text-accent">
                  {moves} {t("shard move(s) planned — tick Apply to run.")}
                </div>
              ) : (
                <div className="text-sm text-success">{t("Shards already balanced — no moves needed.")}</div>
              )}
            </div>
          )}

          {started && output && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
                {t("Raw output")}
              </div>
              <pre className="font-mono text-[11px] p-2 rounded bg-bg border border-border overflow-x-auto max-h-[40vh]">
                {output}
              </pre>
            </div>
          )}

          <CommandPreview command={`ec.${kind}`} args={previewArgs}/>
          </div>

          {/* Right column: live SSE progress for apply mode, mounted
              only after the operator clicks Run. Keyed on streamBody so
              a re-run unmounts the previous stream. */}
          {runningApply && (
            <div className="border-l border-border bg-bg/30 px-4 py-4 overflow-auto">
              <ECProgressStream
                key={JSON.stringify(streamBody)}
                variant="inline"
                url={`/clusters/${clusterID}/ec/${kind}/apply`}
                body={streamBody!}
                expectedVolumes={1}
                title={`ec.${kind} ${t("in progress")}`}
                subtitle={collection ? `collection ${collection}` : "EACH_COLLECTION"}
                onClose={() => setStreamBody(null)}
              />
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose}>{t("Close")}</button>
          <button
            className={`btn ${apply ? "btn-primary" : ""} inline-flex items-center gap-1`}
            onClick={run}
            disabled={running}>
            {running ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}
            {apply ? t("Run (apply)") : (started ? t("Re-run dry-run") : t("Run dry-run"))}
          </button>
        </footer>
      </div>
    </div>
  );
}

