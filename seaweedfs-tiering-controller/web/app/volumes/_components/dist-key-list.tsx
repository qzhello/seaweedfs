"use client";

import { useState } from "react";
import { X, Copy, Check } from "lucide-react";

// DistKeyList renders the full set of distribution groups
// (node / rack / collection) as a compact scrollable list. Each row:
// click to filter the table on the right, copy button to grab the raw
// name for shell commands.
//
// Bar widths are relative to the busiest group so the visual
// hierarchy matches the data — without this every row would look
// identical regardless of how skewed the distribution is.
export function DistKeyList({
  bars,
  onPick,
  activeKey,
  label,
}: {
  bars: { key: string; writable: number; readonly: number }[];
  onPick: (k: string) => void;
  activeKey: string;
  label: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (k: string) => {
    try {
      await navigator.clipboard.writeText(k);
      setCopied(k);
      setTimeout(() => setCopied(c => (c === k ? null : c)), 1200);
    } catch { /* clipboard blocked, ignore */ }
  };
  if (bars.length === 0) return null;
  const activeLc = activeKey.toLowerCase();
  const max = bars.reduce((m, b) => Math.max(m, b.writable + b.readonly), 0);
  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      <div className="text-[10px] text-muted px-1 pb-1">{label}</div>
      <ul className="max-h-72 overflow-auto divide-y divide-border/20">
        {bars.map(b => {
          const isCopied = copied === b.key;
          const isActive = activeLc !== "" && b.key.toLowerCase() === activeLc;
          const total = b.writable + b.readonly;
          // Inline two-tone bar — writable in accent, read-only in
          // warning. Replaces the separate ECharts panel above; this
          // way the visual rep IS the list and scales to N items.
          const wPct = max > 0 ? (b.writable / max) * 100 : 0;
          const rPct = max > 0 ? (b.readonly / max) * 100 : 0;
          return (
            <li
              key={b.key}
              className={`group grid items-center gap-2 px-1 py-1.5 text-[11px] rounded transition-colors ${
                isActive ? "bg-accent/12" : "hover:bg-panel2/60"
              }`}
              style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) 3rem auto" }}
            >
              <button
                onClick={() => onPick(b.key)}
                className={`min-w-0 text-left font-mono truncate ${
                  isActive ? "text-accent" : "text-text hover:text-accent"
                }`}
                title={isActive ? `${b.key} — click again to clear filter` : b.key}
              >
                {b.key}
              </button>
              <div className="relative h-2 bg-panel2 rounded overflow-hidden flex">
                {b.writable > 0 && (
                  <div
                    className="h-full bg-accent/80"
                    style={{ width: `${wPct}%` }}
                    title={`writable: ${b.writable}`}
                  />
                )}
                {b.readonly > 0 && (
                  <div
                    className="h-full bg-warning/80"
                    style={{ width: `${rPct}%` }}
                    title={`read-only: ${b.readonly}`}
                  />
                )}
              </div>
              <span className="text-text tabular-nums font-mono text-right">{total}</span>
              <div className="flex items-center gap-0.5 shrink-0">
                {isActive && (
                  <button
                    onClick={() => onPick(b.key)}
                    className="p-1 text-accent hover:text-text"
                    title="Clear filter"
                    aria-label="Clear filter"
                  >
                    <X size={11}/>
                  </button>
                )}
                <button
                  onClick={() => copy(b.key)}
                  className={`p-1 text-muted hover:text-text transition-opacity ${
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  title={isCopied ? "Copied" : "Copy"}
                  aria-label="Copy"
                >
                  {isCopied ? <Check size={11} className="text-success"/> : <Copy size={11}/>}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
