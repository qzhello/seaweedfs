"use client";

import { useTheme } from "@/lib/theme";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

/** Single-click theme switcher for the top bar. Renders a sun in dark
 *  mode (click → switch to light) and a moon in light mode (click →
 *  switch to dark). 36×36 hit target so it's comfortable to tap on
 *  touch screens too. */
export function ThemeToggle() {
  const [theme, , toggle] = useTheme();
  const { t } = useT();
  // Don't render until after first mount — the SSR pass has no access
  // to localStorage, so its icon would always be the default-theme one
  // and would visibly swap on hydrate. Hiding for one paint avoids it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="w-9 h-9" aria-hidden/>;

  const isDark = theme === "dark";
  const label = isDark ? t("Switch to light theme") : t("Switch to dark theme");
  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center w-9 h-9 rounded-md
                 text-muted hover:text-text hover:bg-panel2 transition-colors"
    >
      {isDark ? <Sun size={16}/> : <Moon size={16}/>}
    </button>
  );
}
