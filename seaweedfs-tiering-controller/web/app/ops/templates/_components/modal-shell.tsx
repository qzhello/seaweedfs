"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

// ModalShell is the editor-grade modal frame used by every dialog in
// /ops/templates. Esc closes; clicking the dim backdrop does NOT —
// the previous behaviour (any backdrop click → close) was easy to
// mis-trigger when an operator was mid-edit. Notion / Linear / Google
// Docs all behave this way.
//
// Three sizes:
//   default — modal for short forms (max-w-2xl)
//   wide    — modal for tables / longer forms (max-w-3xl)
//   xlarge  — workbench layout that fills most of the viewport, used
//             by the template editor so the flow canvas has room to
//             breathe. In xlarge mode the children own their own
//             scroll regions — the shell only locks vertical overflow.
export function ModalShell({
  children, onClose, title, wide, xlarge,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  wide?: boolean;
  xlarge?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const sizeCls = xlarge
    ? "max-w-[1400px] h-[90vh] flex flex-col p-0"
    : wide
      ? "max-w-3xl max-h-[90vh] overflow-y-auto p-5"
      : "max-w-2xl max-h-[90vh] overflow-y-auto p-5";
  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4">
      <div className={`card w-full ${sizeCls}`}>
        {xlarge ? (
          // xlarge: header is pinned, body fills, scroll is delegated.
          <>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
              <h2 className="text-base font-medium">{title}</h2>
              <button onClick={onClose} className="p-1 text-muted hover:text-text" title="Close (Esc)">
                <X size={16}/>
              </button>
            </div>
            <div className="flex-1 min-h-0">{children}</div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-medium">{title}</h2>
              <button onClick={onClose} className="p-1 text-muted hover:text-text" title="Close (Esc)">
                <X size={16}/>
              </button>
            </div>
            {children}
          </>
        )}
      </div>
    </div>
  );
}
