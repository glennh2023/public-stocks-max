"use client";

import { useEffect, useState } from "react";
import { getJSON, setJSON } from "@/lib/settings";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import type { Dashboard } from "@/components/dashboard/dashboard-types";

// Sandbox version of the StocksMax customizable dashboard: same drag/resize
// grid and widget-spec JSON, persisted to localStorage instead of the
// production preset store.

const DEFAULT_DASHBOARD: Dashboard = {
  name: "My dashboard",
  defaultSymbol: "AAPL",
  cols: 12,
  widgets: [
    { id: "w_head", kind: "headline", text: "# Market view", size: { col: 0, row: 0, w: 12, h: 1 } },
    { id: "w_ph", kind: "priceHeader", symbol: "{{symbol}}", size: { col: 0, row: 1, w: 6, h: 3 } },
    { id: "w_stats", kind: "statsGrid", symbol: "{{symbol}}", size: { col: 6, row: 1, w: 6, h: 6 } },
    { id: "w_price", kind: "price", symbol: "{{symbol}}", years: 5, size: { col: 0, row: 4, w: 6, h: 4 } },
    { id: "w_cmp", kind: "compare", symbol: "{{symbol}}", benchmarks: ["SPY"], years: 2, size: { col: 0, row: 8, w: 8, h: 4 } },
    { id: "w_watch", kind: "watchlist", symbols: "AAPL, MSFT, NVDA, SPY", size: { col: 8, row: 8, w: 4, h: 4 } },
    { id: "w_news", kind: "news", symbol: "{{symbol}}", size: { col: 0, row: 12, w: 6, h: 5 } },
    { id: "w_ai", kind: "aiSummary", symbol: "{{symbol}}", size: { col: 6, row: 12, w: 6, h: 5 } },
  ],
};

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);

  useEffect(() => {
    setDashboard(getJSON<Dashboard>("dashboard", DEFAULT_DASHBOARD));
  }, []);

  function update(next: Dashboard) {
    setDashboard(next);
    setJSON("dashboard", next);
  }

  if (!dashboard) return null;
  // Migrate away from the pre-grid sandbox layout format if present.
  if (!Array.isArray(dashboard.widgets)) {
    update(DEFAULT_DASHBOARD);
    return null;
  }

  return (
    <div>
      <h1>Customizable Dashboard</h1>
      <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 12 }}>
        Sample widgets over live Tiingo data — hit <b>Edit</b> to drag, resize,
        add and remove. Widgets bound to <code>{"{{symbol}}"}</code> track the
        symbol box. Layout persists in this browser. Locked cards mark widgets
        that exist only in the full version.
      </p>
      <DashboardGrid
        dashboard={dashboard}
        onChange={update}
        onReset={() => update(DEFAULT_DASHBOARD)}
      />
    </div>
  );
}
