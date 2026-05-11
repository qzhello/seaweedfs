// Centralized chart styling tokens so every ECharts surface inherits the
// same palette, typography, and grid treatment. When the design system
// changes we update this file, not each page.
//
// All colors are OKLCH-derived to match `globals.css` design tokens.

export const chartColors = {
  bg: "transparent",
  text: "oklch(96% 0 0)",            // --color-text
  textMuted: "oklch(72% 0.01 255)",  // --color-muted
  textFaint: "oklch(58% 0.01 255)",
  grid: "rgba(255,255,255,0.05)",
  axisLine: "rgba(255,255,255,0.08)",
  tooltipBg: "rgba(20,25,40,0.95)",
  tooltipBorder: "oklch(30% 0.02 255)",
  accent: "oklch(74% 0.18 230)",
  warning: "oklch(74% 0.18 60)",
  danger:  "oklch(70% 0.19 30)",
  success: "oklch(70% 0.15 150)",
  // Categorical palette for series / pie slices (8 distinct hues)
  series: [
    "oklch(74% 0.18 230)",
    "oklch(70% 0.18 30)",
    "oklch(74% 0.10 270)",
    "oklch(70% 0.15 150)",
    "oklch(70% 0.15 60)",
    "oklch(68% 0.16 320)",
    "oklch(72% 0.14 200)",
    "oklch(70% 0.16 100)",
  ],
  // Heatmap (read activity, capacity gradients)
  heatmap: ["#1b2030", "#2a4d8f", "#74a4ff", "#ffd166", "#ef476f"],
  tierHot:  "oklch(74% 0.18 30)",
  tierWarm: "oklch(74% 0.18 230)",
  tierCold: "oklch(74% 0.10 270)",
  // Dark text used inside warning-colored fills (so labels stay readable)
  textOnWarning: "oklch(20% 0.05 60)",
};

// Tooltip preset — spread into any ECharts `tooltip` option for consistent
// chrome (background, border, text). Override `formatter` and `trigger`.
export const tooltipStyle = {
  backgroundColor: chartColors.tooltipBg,
  borderColor: chartColors.tooltipBorder,
  textStyle: { color: chartColors.text, fontSize: 12 },
  extraCssText: "box-shadow: 0 4px 18px rgba(0,0,0,0.35); border-radius: 6px;",
};

export const axisStyle = {
  label: { color: chartColors.textMuted, fontSize: 10 },
  line:  { lineStyle: { color: chartColors.axisLine } },
  tick:  { show: false },
  split: { lineStyle: { color: chartColors.grid } },
};

// Common legend preset — small, accent-friendly, scrollable.
export const legendStyle = {
  textStyle: { color: chartColors.textMuted, fontSize: 10 },
  icon: "roundRect" as const,
  itemWidth: 8,
  itemHeight: 8,
  itemGap: 12,
  pageIconColor: chartColors.textMuted,
  pageTextStyle: { color: chartColors.textMuted, fontSize: 10 },
};
