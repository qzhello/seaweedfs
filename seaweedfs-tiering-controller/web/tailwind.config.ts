import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // <alpha-value> placeholder lets Tailwind generate opacity modifiers
        // (bg-accent/15, border-danger/40, etc.) on OKLCH custom colors.
        bg:      "oklch(14% 0.01 255 / <alpha-value>)",
        panel:   "oklch(18% 0.015 255 / <alpha-value>)",
        panel2:  "oklch(22% 0.02 255 / <alpha-value>)",
        border:  "oklch(28% 0.02 255 / <alpha-value>)",
        text:    "oklch(96% 0 0 / <alpha-value>)",
        muted:   "oklch(70% 0.02 255 / <alpha-value>)",
        accent:  "oklch(74% 0.18 230 / <alpha-value>)",
        success: "oklch(76% 0.18 150 / <alpha-value>)",
        warning: "oklch(82% 0.17 80 / <alpha-value>)",
        danger:  "oklch(68% 0.22 20 / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace"],
      },
      boxShadow: {
        soft: "0 1px 0 0 oklch(100% 0 0 / 0.04) inset, 0 12px 40px -12px oklch(0% 0 0 / 0.6)",
      },
    },
  },
  plugins: [],
};
export default config;
