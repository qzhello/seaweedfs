"use client";

// Sparkline draws a volume's recent feature history as a hand-rolled SVG
// polyline — deliberately NOT ECharts: the volumes list renders ~50 of
// these per page, and 50 chart instances would be wasteful. The reads_7d
// line is the access-trend signal; a faint area underneath traces
// size_bytes on its own scale, so one table cell carries both the access
// trend and the capacity trend. Native <title> gives a hover tooltip.

import { useMemo } from "react";
import { chartColors as C } from "@/lib/chart-theme";
import { bytes as fmtBytes } from "@/lib/utils";
import type { VolumeFeatureDailyPoint } from "@/lib/api";

interface SparklineProps {
  points: VolumeFeatureDailyPoint[];
  width?: number;
  height?: number;
}

export function Sparkline({ points, width = 108, height = 30 }: SparklineProps) {
  const geo = useMemo(() => {
    if (!points || points.length < 2) return null;

    // Field-level fallback: the API always sends numbers, but a stray
    // null/undefined would propagate NaN through the scale math and
    // render an invisible path. ?? 0 keeps the line drawable.
    const reads = points.map((p) => p.reads_7d ?? 0);
    const sizes = points.map((p) => p.size_bytes ?? 0);
    const n = points.length;

    const xAt = (i: number) => (i / (n - 1)) * (width - 2) + 1;
    // Each series scales to its own min/max with 3px vertical padding so
    // a flat-but-nonzero line still reads as flat, not pinned to an edge.
    const yScaler = (vals: number[]) => {
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const span = max - min || 1;
      return (v: number) => height - 3 - ((v - min) / span) * (height - 6);
    };
    const yReads = yScaler(reads);
    const ySize = yScaler(sizes);

    const readsPath = reads
      .map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yReads(v).toFixed(1)}`)
      .join(" ");
    const sizeArea =
      `M${xAt(0).toFixed(1)} ${height}` +
      sizes.map((v, i) => ` L${xAt(i).toFixed(1)} ${ySize(v).toFixed(1)}`).join("") +
      ` L${xAt(n - 1).toFixed(1)} ${height} Z`;

    // Colour the line by the direction of the read trend: cooling reads
    // are the tiering signal (accent), warming reads are a caution (amber).
    const first = reads[0];
    const last = reads[n - 1];
    const color =
      last > first * 1.05 ? C.warning : last < first * 0.95 ? C.accent : C.textMuted;

    return { readsPath, sizeArea, color, lastX: xAt(n - 1), lastY: yReads(last) };
  }, [points, width, height]);

  if (!geo) return <span className="text-[10px] text-muted/40">—</span>;

  const last = points[points.length - 1];
  const title = `reads_7d ${(last.reads_7d ?? 0).toLocaleString()} · size ${fmtBytes(
    last.size_bytes ?? 0,
  )} · ${points.length}d history`;

  // The tooltip lives on a wrapping <span>, not an SVG <title>: the SVG
  // is aria-hidden (decorative), and a native title attribute is the
  // only cross-browser-reliable hover hint.
  return (
    <span className="inline-block align-middle" title={title}>
      <svg width={width} height={height} className="block" aria-hidden="true">
        <path d={geo.sizeArea} fill={C.textFaint} fillOpacity={0.1} stroke="none" />
        <path
          d={geo.readsPath}
          fill="none"
          stroke={geo.color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={geo.lastX} cy={geo.lastY} r={1.8} fill={geo.color} />
      </svg>
    </span>
  );
}
