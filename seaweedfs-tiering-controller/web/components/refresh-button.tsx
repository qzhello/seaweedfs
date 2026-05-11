"use client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";

// A small icon button that triggers a SWR mutate (or any async refresh fn)
// and spins its icon while the call is in flight. Pages put one of these
// at the top so the operator can re-pull data on demand instead of
// waiting for a background poll.
//
// Pass `loading` from the parent (typically `isValidating` from useSWR) so
// the icon also spins during background revalidations triggered elsewhere.
export function RefreshButton({
  onClick,
  loading,
  size = "md",
}: {
  onClick: () => Promise<unknown> | void;
  loading?: boolean;
  size?: "sm" | "md";
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const spinning = busy || !!loading;

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClick();
    } finally {
      setBusy(false);
    }
  };

  const dim = size === "sm" ? 12 : 14;
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      title={t("Refresh")}
      aria-label={t("Refresh")}
      className={`inline-flex items-center justify-center rounded-md border border-border text-muted hover:text-text hover:bg-panel2 transition-colors ${
        size === "sm" ? "p-1" : "p-1.5"
      } disabled:opacity-60`}
    >
      <RefreshCw size={dim} className={spinning ? "animate-spin" : ""}/>
    </button>
  );
}
