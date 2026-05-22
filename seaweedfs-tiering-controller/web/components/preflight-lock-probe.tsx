"use client";

// Shared preflight lock-probe surface used by every "Apply" dialog that
// triggers a mutating shell command. The flow mirrors what
// `ShellActionDialog` does internally:
//
//   1. The dialog calls `runProbe()` before its real submit.
//   2. If the lock is free → returns `true`, the dialog submits.
//   3. If held / quorum unhealthy → returns `false`. The hook stores the
//      result; the dialog renders `<PreflightProbeBanner>` and changes
//      its primary button to "Continue anyway". A second click calls
//      `runProbe()` again with `bypass=true`, which short-circuits to
//      `true` so the dialog proceeds.
//
// Pulling this out of `shell-action.tsx` keeps the bespoke dialogs
// (volume balance, EC encode, fix-replication, etc.) consistent with
// the generic ShellActionDialog UX without each one re-implementing
// the state machine.

import { useCallback, useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export interface PreflightProbe {
  status: "free" | "held" | "quorum_unhealthy";
  holder?: string;
  message?: string;
  address?: string;
}

export interface UsePreflightLockProbeResult {
  probe: PreflightProbe | null;
  probing: boolean;
  // Returns true when the caller should proceed with the real submit.
  // Pass `bypass=true` (second-click path) to force-clear any prior
  // result without re-probing.
  runProbe: (bypass?: boolean) => Promise<boolean>;
  // Clear any prior probe — call this when the operator edits form
  // fields so a stale "held" banner doesn't survive into the new attempt.
  reset: () => void;
}

export function usePreflightLockProbe(clusterID: string): UsePreflightLockProbeResult {
  const [probe, setProbe] = useState<PreflightProbe | null>(null);
  const [probing, setProbing] = useState(false);

  const runProbe = useCallback(async (bypass = false): Promise<boolean> => {
    if (bypass) {
      setProbe(null);
      return true;
    }
    setProbing(true);
    try {
      const p = await api.lockProbe(clusterID);
      const next: PreflightProbe = {
        status: p.status,
        holder: p.holder,
        message: p.message,
        address: p.address,
      };
      setProbe(next);
      return next.status === "free";
    } catch (e) {
      setProbe({
        status: "quorum_unhealthy",
        message: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setProbing(false);
    }
  }, [clusterID]);

  const reset = useCallback(() => setProbe(null), []);

  return { probe, probing, runProbe, reset };
}

export function PreflightProbeBanner({ probe }: { probe: PreflightProbe | null }) {
  const { t } = useT();
  if (!probe || probe.status === "free") return null;
  const isHeld = probe.status === "held";
  return (
    <div className={`text-xs rounded-md px-3 py-2 border ${
      isHeld
        ? "text-amber-300 bg-amber-400/10 border-amber-400/30"
        : "text-rose-300 bg-rose-400/10 border-rose-400/30"
    }`}>
      <div className="font-medium inline-flex items-center gap-1.5">
        {isHeld
          ? <><AlertTriangle size={12}/> {t("Cluster admin lock is held")}</>
          : <><ShieldAlert size={12}/> {t("Cluster quorum is unhealthy")}</>}
      </div>
      {isHeld && (
        <div className="text-[11px] mt-1 text-muted">
          {t("Currently held by")} <span className="font-mono text-warning">{probe.holder || t("unknown")}</span>
          {probe.address && <> {t("on")} <span className="font-mono">{probe.address}</span></>}.
          {" "}{t("Running now will block until they release.")}
        </div>
      )}
      {!isHeld && (
        <div className="text-[11px] mt-1 font-mono text-muted break-all">
          {probe.message || t("probe failed")}
        </div>
      )}
      <div className="text-[11px] mt-1 text-muted">
        {t("Click \"Continue anyway\" to bypass and run.")}
      </div>
    </div>
  );
}

// Convenient label for the submit button — most dialogs want this exact
// string ("Apply" / "Continue anyway" / "Probing lock…") so factoring
// the choice into a function keeps the JSX terse.
export function preflightButtonLabel(
  t: (key: string) => string,
  probe: PreflightProbe | null,
  probing: boolean,
  defaultLabel: string,
): string {
  if (probing) return t("Probing lock…");
  if (probe && probe.status !== "free") return t("Continue anyway");
  return defaultLabel;
}
