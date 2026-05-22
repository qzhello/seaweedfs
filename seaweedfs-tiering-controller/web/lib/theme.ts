"use client";

import { useEffect, useState, useCallback } from "react";

// Storage key — namespaced so it doesn't collide with unrelated apps
// sharing the same origin during dev. Mirror the i18n module's
// "tier.lang" convention so all client prefs live under the same prefix.
const STORAGE_KEY = "tier.theme";

export type Theme = "light" | "dark";
const DEFAULT_THEME: Theme = "dark";

// Cross-tab + cross-component sync: when one place flips the theme we
// dispatch a window event so every useTheme() hook re-reads the value.
// Storage events alone don't fire in the same tab that wrote the key.
const CHANGE_EVENT = "tier:theme";

function readStored(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : DEFAULT_THEME;
}

function applyDom(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/** useTheme returns the current theme + a setter. The setter persists
 *  to localStorage, updates the DOM attribute that drives token swaps,
 *  and broadcasts a tier:theme event so other components re-sync. */
export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  // Lazy init from storage so SSR doesn't see a hardcoded dark theme
  // and then flicker to the user's preference on hydrate.
  const [theme, setThemeState] = useState<Theme>(() => readStored());

  // On mount: re-read in case localStorage changed between server render
  // and client hydration; also wire up the cross-tab/event sync.
  useEffect(() => {
    setThemeState(readStored());
    const onChange = () => setThemeState(readStored());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) onChange();
    });
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, next);
    applyDom(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return [theme, setTheme, toggle];
}

/** Inline boot script — runs before any React code paints so we set
 *  data-theme on the html element synchronously. Without this the first
 *  paint always uses whatever the SSR markup says, then snaps to the
 *  stored theme after hydration — a visible flash. */
export const themeBootScript = `
(function() {
  try {
    var v = localStorage.getItem("${STORAGE_KEY}");
    if (v !== "light" && v !== "dark") v = "${DEFAULT_THEME}";
    document.documentElement.setAttribute("data-theme", v);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "${DEFAULT_THEME}");
  }
})();
`;
