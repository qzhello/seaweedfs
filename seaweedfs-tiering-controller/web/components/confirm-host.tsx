"use client";

// Modal host for lib/confirm.tsx. Renders the head of the queue, focuses
// the cancel button by default (safest), Esc cancels, backdrop click
// cancels. For "danger" requests with typeToConfirm, the primary button
// stays disabled until the user has typed the phrase exactly.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldAlert, HelpCircle } from "lucide-react";
import { useConfirmQueue, resolveConfirm, type ConfirmTone } from "@/lib/confirm";

const TONE: Record<ConfirmTone, { icon: typeof AlertTriangle; ring: string; btn: string }> = {
  danger:  { icon: ShieldAlert,    ring: "border-danger/40 bg-danger/5",   btn: "btn-danger" },
  warning: { icon: AlertTriangle,  ring: "border-warning/40 bg-warning/5", btn: "btn-primary" },
  default: { icon: HelpCircle,     ring: "border-border",                  btn: "btn-primary" },
};

export function ConfirmHost() {
  const queue = useConfirmQueue();
  const current = queue[0];
  return current ? <Modal key={current.id} req={current} /> : null;
}

function Modal({ req }: { req: ReturnType<typeof useConfirmQueue>[number] }) {
  const tone = TONE[req.tone || "default"];
  const Icon = tone.icon;
  const [typed, setTyped] = useState("");
  const needsType = !!req.typeToConfirm;
  const matched = needsType ? typed === req.typeToConfirm : true;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Esc cancels; trap focus to the modal so a stray Tab doesn't escape
  // to the page behind us.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveConfirm(req.id, false);
      }
    };
    document.addEventListener("keydown", onKey);
    // Auto-focus: if we need a typed phrase, focus the input; otherwise
    // focus Cancel — never auto-focus a destructive primary button.
    (needsType ? inputRef.current : cancelRef.current)?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [req.id, needsType]);

  return (
    <div
      // Backdrop click cancels. Stop propagation on the inner card so
      // clicks inside don't bubble to the backdrop handler.
      className="fixed inset-0 z-[300] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-title-${req.id}`}
      onMouseDown={() => resolveConfirm(req.id, false)}
    >
      <div
        className={`card shadow-pop max-w-md w-full p-5 ${tone.ring}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`rounded-full p-2 ${
            req.tone === "danger"  ? "bg-danger/15 text-danger"
          : req.tone === "warning" ? "bg-warning/15 text-warning"
          :                          "bg-panel2 text-muted"
          }`}>
            <Icon size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={`confirm-title-${req.id}`} className="text-sm font-semibold text-text">
              {req.title}
            </h2>
            {req.body && (
              <p className="mt-1 text-xs text-muted whitespace-pre-wrap">{req.body}</p>
            )}
            {needsType && (
              <div className="mt-3">
                <label className="block text-[11px] text-muted mb-1">
                  Type{" "}
                  <code className="px-1 py-0.5 rounded bg-panel2 font-mono text-[11px] text-text">
                    {req.typeToConfirm}
                  </code>{" "}
                  to confirm
                </label>
                <input
                  ref={inputRef}
                  className="input w-full font-mono text-xs"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={() => resolveConfirm(req.id, false)}
          >
            {req.cancelLabel || "Cancel"}
          </button>
          <button
            type="button"
            className={`btn ${tone.btn}`}
            disabled={!matched}
            onClick={() => resolveConfirm(req.id, true)}
          >
            {req.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
