"use client";

import type { PricePoint } from "@/lib/tiingo-client";

// Dependency-free SVG price chart used by dashboard widgets and the paper page.

export default function Sparkline({
  data,
  height = 120,
}: {
  data: PricePoint[];
  height?: number;
}) {
  if (!data.length) return null;
  const w = 600;
  const closes = data.map((d) => d.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = height - ((d.close - min) / span) * (height - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "var(--accent)" : "var(--danger)";

  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}
