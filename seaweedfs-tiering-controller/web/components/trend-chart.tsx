"use client";
import dynamic from "next/dynamic";
import { useHolidays } from "@/lib/api";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export function TrendChart({ points, title = "Reads / Writes" }: {
  points: { bucket: string; reads: number; writes: number; bytes_read: number }[];
  title?: string;
}) {
  const { data: holidays } = useHolidays();
  const xs = points.map(p => new Date(p.bucket).toLocaleString());
  const reads = points.map(p => p.reads);
  const writes = points.map(p => p.writes);

  const markAreas = (holidays?.items || [])
    .filter((h: any) => h.kind === "holiday")
    .map((h: any) => {
      const start = new Date(h.date);
      start.setDate(start.getDate() - (h.pre_window_days || 0));
      const end = new Date(h.date);
      end.setDate(end.getDate() + (h.post_window_days || 0));
      return [
        { xAxis: start.toLocaleString(), itemStyle: { color: "rgba(239,71,111,0.10)" }, name: h.name },
        { xAxis: end.toLocaleString() },
      ];
    });

  return (
    <ReactECharts style={{ height: 320 }} option={{
      backgroundColor: "transparent",
      title: { text: title, left: 0, textStyle: { color: "#ddd", fontSize: 12 } },
      tooltip: { trigger: "axis" },
      legend: { data: ["reads", "writes"], textStyle: { color: "#aaa" } },
      grid: { top: 40, left: 60, right: 30, bottom: 50 },
      xAxis: { type: "category", data: xs, axisLabel: { color: "#888", fontSize: 10, rotate: 30 } },
      yAxis: { type: "value", axisLabel: { color: "#888" }, splitLine: { lineStyle: { color: "#222" } } },
      series: [
        {
          name: "reads", type: "line", smooth: true, data: reads,
          areaStyle: { opacity: 0.15 },
          lineStyle: { width: 2, color: "oklch(74% 0.18 230)" },
          itemStyle: { color: "oklch(74% 0.18 230)" },
          markArea: markAreas.length ? { silent: true, label: { show: true, color: "#aaa" }, data: markAreas } : undefined,
        },
        {
          name: "writes", type: "line", smooth: true, data: writes,
          lineStyle: { width: 2, color: "oklch(74% 0.18 30)" },
          itemStyle: { color: "oklch(74% 0.18 30)" },
        },
      ],
    }}/>
  );
}
