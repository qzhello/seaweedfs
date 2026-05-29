"use client";

import { useScoreHistory } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface ScoreSparklineProps {
  clusterID?: string;
}

export function ScoreSparkline({ clusterID }: ScoreSparklineProps) {
  const { t } = useT();
  const { data } = useScoreHistory(clusterID, "1d");
  const points = data?.points ?? [];

  if (points.length < 2) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[10px] text-muted uppercase tracking-wide">
          {t("Score (1d)")}
        </div>
        <div className="h-[64px] flex items-center justify-center border border-dashed border-border rounded-md">
          <span className="text-[10px] text-muted text-center px-2">
            {t("Score history collecting…")}
          </span>
        </div>
      </div>
    );
  }

  // Map score 0..100 to SVG y-coordinate (inverted: high score = low y).
  const W = 150;
  const H = 56;
  const PAD = 3;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;

  const xs = points.map((_, i) => PAD + (i / (points.length - 1)) * innerW);
  const ys = points.map((p) => PAD + ((100 - p.score) / 100) * innerH);

  const polylinePoints = xs.map((x, i) => `${x},${ys[i]}`).join(" ");
  // Close area by going to bottom-right then bottom-left.
  const areaPoints =
    polylinePoints +
    ` ${xs[xs.length - 1]},${H - PAD} ${xs[0]},${H - PAD}`;

  const latest = points[points.length - 1].score;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wide">
          {t("Score (1d)")}
        </span>
        <span className="text-[10px] font-mono font-semibold text-accent tabular-nums">
          {latest}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 64 }}
        aria-hidden="true"
      >
        {/* Faint area fill */}
        <polygon
          points={areaPoints}
          className="text-accent"
          fill="currentColor"
          fillOpacity={0.08}
        />
        {/* Line */}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-accent"
        />
      </svg>
    </div>
  );
}
