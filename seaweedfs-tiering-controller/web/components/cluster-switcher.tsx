"use client";

// Topbar cluster switcher. Renders the active cluster as a chip; click
// opens a popover that lists every enabled cluster with a live health
// dot. Selection writes to the ClusterProvider, so every resource page
// follows along automatically.

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Server, Loader2, Check, Globe } from "lucide-react";
import { useClusters, useClusterHealth } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";

interface ClusterRow {
  id: string;
  name: string;
  master_addr: string;
  enabled: boolean;
}

export function ClusterSwitcher() {
  const { t } = useT();
  const { clusterID, setClusterID } = useCluster();
  const { data } = useClusters();
  const clusters: ClusterRow[] = (data?.items ?? []).filter((c: ClusterRow) => c.enabled);
  const active = clusters.find((c) => c.id === clusterID);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-panel2 px-3 py-1.5 text-sm hover:bg-panel transition-colors"
      >
        {active ? (
          <>
            <Server size={14} className="text-accent"/>
            <span className="font-medium">{active.name}</span>
            <span className="text-muted text-xs font-mono">{active.master_addr}</span>
          </>
        ) : (
          <>
            <Globe size={14} className="text-muted"/>
            <span className="text-muted">{t("All clusters")}</span>
          </>
        )}
        <ChevronDown size={12} className="text-muted"/>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 z-50 w-80 rounded-md border border-border bg-panel shadow-xl py-1 max-h-96 overflow-auto">
          <button
            onClick={() => { setClusterID(""); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-panel2 ${
              !clusterID ? "text-accent" : ""
            }`}
          >
            <Globe size={14}/>
            <span className="flex-1">{t("All clusters")}</span>
            <span className="text-[11px] text-muted">{t("aggregate views only")}</span>
            {!clusterID && <Check size={12}/>}
          </button>
          <div className="my-1 border-t border-border/60"/>
          {clusters.length === 0 && (
            <div className="px-3 py-3 text-sm text-muted">{t("No enabled clusters.")}</div>
          )}
          {clusters.map((c) => (
            <ClusterChoice
              key={c.id}
              row={c}
              active={c.id === clusterID}
              onPick={() => { setClusterID(c.id); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClusterChoice({
  row, active, onPick,
}: { row: ClusterRow; active: boolean; onPick: () => void; }) {
  const { data, isLoading } = useClusterHealth(row.id);
  const dot = !data ? "bg-muted" :
              isLoading ? "bg-amber-400" :
              data.reachable ? "bg-emerald-400" : "bg-rose-400";
  return (
    <button
      onClick={onPick}
      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-panel2 ${
        active ? "text-accent" : ""
      }`}
    >
      {isLoading
        ? <Loader2 size={10} className="animate-spin text-muted"/>
        : <span className={`inline-block w-2 h-2 rounded-full ${dot}`}/>}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{row.name}</div>
        <div className="text-[11px] font-mono text-muted truncate">{row.master_addr}</div>
      </div>
      {data && data.reachable && (
        <span className="text-[10px] text-muted">{data.latency_ms}ms</span>
      )}
      {active && <Check size={12}/>}
    </button>
  );
}
