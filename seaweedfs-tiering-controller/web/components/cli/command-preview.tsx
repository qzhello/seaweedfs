"use client";

// Reusable preview of the `weed shell -- <command> <args...>` line that
// a dialog is about to dispatch. Lives next to the form (before run)
// and inside the streaming progress panel (during/after run) so the
// operator always sees the exact command that hit the cluster.

import { useState } from "react";
import { useT } from "@/lib/i18n";

interface Props {
  command: string;
  args: string[];
  // multi: when an action runs once per row, callers pass each row's
  // args so we can stack `weed shell -- cmd ...` lines vertically.
  // Takes precedence over `args` when non-empty.
  multi?: string[][];
  className?: string;
}

export function CommandPreview({ command, args, multi, className }: Props) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const rows: string[][] = multi && multi.length > 0 ? multi : [args];
  const fullText = rows
    .map(r => `weed shell -- ${command}${r.length ? " " + r.join(" ") : ""}`)
    .join("\n")
    .trim();

  const copy = () => {
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          {t("Command")}{rows.length > 1 ? ` · ${rows.length}` : ""}
        </div>
        <button className="text-[10px] text-muted hover:text-text" onClick={copy}>
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      <pre className="font-mono text-[11px] p-2 rounded bg-bg border border-accent/30 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-[30vh]">
        {rows.map((r, ri) => (
          <div key={ri}>
            <span className="text-muted">weed shell -- </span>
            <span className="text-accent">{command}</span>
            {r.map((a, i) => (
              <span key={i}> {a}</span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}
