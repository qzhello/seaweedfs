import type { Config } from "tailwindcss";

// Every color reads from a CSS variable defined in app/globals.css so the
// same className works in light AND dark. The `oklch(var(--c-x) / <alpha-value>)`
// pattern lets Tailwind still generate opacity modifiers (bg-accent/15,
// border-danger/40) on top of token references — without it we'd lose
// half of the utility surface area when swapping to vars.
const config: Config = {
  // We theme via data-theme attr (set by lib/theme.ts), not Tailwind's
  // dark: prefix — colors are unified tokens so we don't need per-mode
  // utilities. darkMode left as "class" purely as a no-op fallback.
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:      "oklch(var(--c-bg) / <alpha-value>)",
        panel:   "oklch(var(--c-panel) / <alpha-value>)",
        panel2:  "oklch(var(--c-panel2) / <alpha-value>)",
        border:  "oklch(var(--c-border) / <alpha-value>)",
        text:    "oklch(var(--c-text) / <alpha-value>)",
        muted:   "oklch(var(--c-muted) / <alpha-value>)",
        accent:  "oklch(var(--c-accent) / <alpha-value>)",
        success: "oklch(var(--c-success) / <alpha-value>)",
        warning: "oklch(var(--c-warning) / <alpha-value>)",
        danger:  "oklch(var(--c-danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace"],
      },
      boxShadow: {
        // Map Tailwind's shadow utility names to the same tokens
        // globals.css exposes, so .shadow-soft on a Tailwind element
        // honors theme without per-mode logic.
        soft: "var(--shadow-card)",
        pop:  "var(--shadow-pop)",
      },
    },
  },
  plugins: [],
};
export default config;
