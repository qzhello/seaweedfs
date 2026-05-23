"use client";

// Global keyboard shortcuts in the spirit of GitHub/Linear/Vim:
//   - "g d"  → /              (dashboard)
//   - "g v"  → /volumes       (Volumes)
//   - "g c"  → /clusters      (Clusters)
//   - "g t"  → /tasks         (Tasks)
//   - "g o"  → /ops/templates (Ops templates)
//   - "g e"  → /executions    (Executions)
//   - "g a"  → /alerts        (Alerts)
//   - "g h"  → /health        (Health)
//   - "/"    → focus the global search box in the nav
//   - "?"    → toggles a help cheatsheet
//
// `g` is a leader: press it once within 1.2s of the next letter to
// trigger. Ignored while typing in inputs, textareas, contenteditable,
// or while a modifier key is held (cmd/ctrl/alt) so it never clashes
// with browser hotkeys. Cmd+K is handled separately in nav.tsx.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const G_LEADER_MS = 1200;

// Map after pressing "g".
const G_DEST: Record<string, string> = {
  d: "/",
  v: "/volumes",
  c: "/clusters",
  t: "/tasks",
  o: "/ops/templates",
  e: "/executions",
  a: "/reliability?tab=alerts",
  h: "/reliability?tab=health",
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // ReactFlow uses contenteditable in nested elements — bail on the
  // whole subtree if any ancestor is the flow canvas.
  if (el.closest('[data-suppress-shortcuts="1"]')) return true;
  return false;
}

export function useKeyboardShortcuts(): {
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
} {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let leaderUntil = 0; // ms timestamp; >0 means leader is active.

    function focusNavSearch() {
      // nav.tsx assigns id="nav-search" to its search input.
      const el = document.getElementById("nav-search") as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
        return true;
      }
      return false;
    }

    const onKey = (e: KeyboardEvent) => {
      // Browser/system combos: leave them alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't intercept typing.
      if (isTypingTarget(e.target)) return;
      const k = e.key;

      // "?" cheatsheet
      if (k === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      // "/" → focus nav search.
      if (k === "/") {
        if (focusNavSearch()) {
          e.preventDefault();
        }
        return;
      }
      // Esc closes help (only if no input has focus, which we already
      // filtered above).
      if (k === "Escape" && helpOpen) {
        setHelpOpen(false);
        return;
      }

      // Leader-key follow-up.
      if (leaderUntil > 0 && Date.now() < leaderUntil) {
        leaderUntil = 0;
        const dest = G_DEST[k.toLowerCase()];
        if (dest) {
          e.preventDefault();
          router.push(dest);
        }
        return;
      }

      // Start leader window on plain "g".
      if (k === "g" || k === "G") {
        leaderUntil = Date.now() + G_LEADER_MS;
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, helpOpen]);

  return { helpOpen, setHelpOpen };
}

// Visible cheatsheet table — bound to "?".
export const SHORTCUTS = [
  { keys: "g d", label: "Dashboard" },
  { keys: "g v", label: "Volumes" },
  { keys: "g c", label: "Clusters" },
  { keys: "g t", label: "Tasks" },
  { keys: "g o", label: "Ops Templates" },
  { keys: "g e", label: "Executions" },
  { keys: "g a", label: "Alerts" },
  { keys: "g h", label: "Health" },
  { keys: "/",   label: "Focus search" },
  { keys: "⌘K",  label: "Open nav search palette" },
  { keys: "?",   label: "Toggle this cheatsheet" },
];
