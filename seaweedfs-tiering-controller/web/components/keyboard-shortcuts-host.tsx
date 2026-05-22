"use client";

import { Keyboard, X } from "lucide-react";
import { useKeyboardShortcuts, SHORTCUTS } from "@/lib/use-keyboard-shortcuts";

// KeyboardShortcutsHost mounts once in the shell. It wires the
// global key listener and renders the help overlay (toggled by "?").
// Kept tiny so we can drop it into the layout without bloating the
// critical path.
export function KeyboardShortcutsHost() {
  const { helpOpen, setHelpOpen } = useKeyboardShortcuts();
  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setHelpOpen(false)}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="card p-5 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <Keyboard size={16}/> Keyboard shortcuts
          </h2>
          <button onClick={() => setHelpOpen(false)} className="text-muted hover:text-text" aria-label="Close">
            <X size={16}/>
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <td className="py-1 pr-3 align-top">
                  <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-panel2 border border-border">
                    {s.keys}
                  </kbd>
                </td>
                <td className="py-1 text-muted">{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-muted mt-3">
          Shortcuts are ignored while you&apos;re typing in an input or textarea.
        </p>
      </div>
    </div>
  );
}
