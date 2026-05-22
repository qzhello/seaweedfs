// Centralized chart styling tokens so every ECharts surface inherits the
// same palette, typography, and grid treatment. When the design system
// changes we update this file, not each page.
//
// All colors are OKLCH-derived to match `globals.css` design tokens.

// IMPORTANT: every value here must be a color string the Canvas 2D
// parser accepts on EVERY browser the operators might use (Chrome,
// Safari, Firefox, embedded Electron). OKLCH support in canvas
// landed in Chrome 111 / Safari 16.4 but is unreliable in older
// engines — when the parser fails it silently falls back to black,
// which is why earlier renders showed flat black bars. Stick to hex
// (or rgb / rgba) and we never hit that path.
//
// Mid-gray text + faint grid still read OK on both themes (≥3:1),
// keeping us out of a full reactive-theme refactor for now.
export const chartColors = {
  bg: "transparent",
  text: "rgb(150 150 160)",
  textMuted: "rgb(140 140 150)",
  textFaint: "rgb(120 120 130)",
  grid: "rgba(127,127,127,0.12)",
  axisLine: "rgba(127,127,127,0.18)",
  tooltipBg: "rgba(20,25,40,0.95)",
  tooltipBorder: "rgba(127,127,127,0.3)",
  accent:  "#3b9eff", // blue
  warning: "#f59e0b", // amber
  danger:  "#ef4444", // red
  success: "#22c55e", // green
  // Categorical palette — 8 distinct, perceptually-spaced hues.
  // Indices are intentionally ordered so that 0 = primary brand color
  // and the next few stay maximally distinguishable.
  series: [
    "#3b9eff", // blue
    "#f97316", // orange
    "#a78bfa", // violet
    "#22c55e", // green
    "#eab308", // yellow
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#84cc16", // lime
  ],
  // Heatmap stops (low → high). Kept as-is; these are hex already.
  heatmap: ["#1b2030", "#2a4d8f", "#74a4ff", "#ffd166", "#ef476f"],
  tierHot:  "#f97316", // orange — hot data
  tierWarm: "#3b9eff", // blue   — warm data
  tierCold: "#a78bfa", // violet — cold data
  // Dark text used inside warning-colored fills (so labels stay
  // readable on a yellow background).
  textOnWarning: "#3a2a06",
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
