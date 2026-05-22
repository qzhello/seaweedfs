"use client";

// EC decode (rollback) dialog. Takes a list of EC volume IDs and runs
// `ec.decode -volumeId=N` one at a time so a single failure doesn't abort
// the batch. Decoding is destructive in the sense that the EC layout is
// torn down and a fat `.dat` is reassembled on one node — confirm before
// submit.

import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Play, X, AlertTriangle, Undo2, Loader2 } from "lucide-react";
import {
  usePreflightLockProbe, PreflightProbeBanner, preflightButtonLabel,
} from "@/components/preflight-lock-probe";
import { ECProgressStream } from "./progress-stream";
import { ComboInput } from "@/components/form/smart-inputs";
import { CommandPreview } from "@/components/cli/command-preview";

interface Props {
  clusterID: string;
  volumeIds: number[];
  diskTypes?: string[];
  onClose: () => void;
  onDone?: () => void;
}

export function ECDecodeDialog({ clusterID, volumeIds, diskTypes = [], onClose, onDone }: Props) {
  const { t } = useT();
  const [diskType, setDiskType] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [streamBody, setStreamBody] = useState<null | Record<string, unknown>>(null);
  const { probe, probing, runProbe } = usePreflightLockProbe(clusterID);

  // Each volume gets its own shell invocation (`-volumeId=N`); preview
  // shows the per-volume invocation lines so the operator can see all
  // commands that will actually run.
  const previewArgsPerVolume = useMemo<string[][]>(() => {
    const dt = diskType.trim();
    return volumeIds.map(vid => {
      const a = [`-volumeId=${vid}`];
      if (dt) a.push(`-diskType=${dt}`);
      return a;
    });
  }, [volumeIds, diskType]);

  const submit = async () => {
    if (volumeIds.length === 0) {
      setErr(t("No volumes selected."));
      return;
    }
    const ok = await runProbe(probe !== null);
    if (!ok) return;
    setErr(null);
    const body: Record<string, unknown> = { volumeIds };
    if (diskType.trim()) body.diskType = diskType.trim();
    setStreamBody(body);
  };

  const running = !!streamBody;
  const dialogWidth = running ? "max-w-5xl" : "max-w-2xl";
  const subtitle = `[${volumeIds.slice(0, 16).join(", ")}${volumeIds.length > 16 ? "…" : ""}] (${volumeIds.length})`;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`card bg-panel border border-border w-full ${dialogWidth} max-h-[90vh] flex flex-col shadow-soft transition-[max-width]`}
        onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
              <Undo2 size={14}/> {t("Decode EC → normal volume")}
            </h2>
            <p className="text-xs text-muted mt-0.5 font-mono">
              {t("Volumes:")} {subtitle}
            </p>
          </div>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className={`overflow-auto flex-1 ${running ? "grid grid-cols-[1fr_400px]" : ""}`}>
          <div className="px-5 py-4 space-y-3">
            <div className="text-xs text-warning/80 inline-flex items-center gap-1.5 p-2 rounded border border-warning/30 bg-warning/5">
              <AlertTriangle size={14} className="shrink-0"/>
              <span>{t("Decode pulls all 14 shards to one node and rebuilds .dat/.idx. The target node needs free space ≥ the original volume size. Runs serially per volume.")}</span>
            </div>

            <label className="block">
              <span className="text-xs text-muted">{t("Disk type (optional)")}</span>
              <div className="mt-1">
                <ComboInput
                  value={diskType}
                  onChange={setDiskType}
                  options={diskTypes}
                  placeholder="hdd / ssd"
                />
              </div>
              <span className="block text-[10px] text-muted/70 mt-0.5">
                {t("Must match the diskType the EC shards were placed on.")}
              </span>
            </label>

            {err && (
              <div className="text-sm text-danger inline-flex items-center gap-2">
                <AlertTriangle size={14}/> {err}
              </div>
            )}

            <CommandPreview
              command="ec.decode"
              args={previewArgsPerVolume[0] || []}
              multi={previewArgsPerVolume.length > 1 ? previewArgsPerVolume : undefined}
            />
          </div>

          {running && (
            <div className="border-l border-border bg-bg/30 px-4 py-4 overflow-auto">
              <ECProgressStream
                key={JSON.stringify(streamBody)}
                variant="inline"
                url={`/clusters/${clusterID}/ec/decode/stream`}
                body={streamBody!}
                expectedVolumes={volumeIds.length}
                title={t("ec.decode in progress")}
                subtitle={subtitle}
                onDone={(ok, payload) => {
                  if (ok) {
                    toast.success(t("EC decode complete"), subtitle);
                  } else {
                    const msg = typeof payload?.error === "string" ? payload.error : t("EC decode failed");
                    toast.error(t("EC decode failed"), msg);
                  }
                  onDone?.();
                }}
                onClose={() => setStreamBody(null)}
              />
            </div>
          )}
        </div>

        <PreflightProbeBanner probe={probe}/>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="btn" onClick={onClose} disabled={probing}>{t("Close")}</button>
          {!running && (
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={submit} disabled={volumeIds.length === 0 || probing}>
              {probing ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}
              {preflightButtonLabel(t, probe, probing, t("Start ec.decode"))}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
