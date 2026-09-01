import Link from "next/link";
import { SANDBOX_NAME } from "@/lib/sandbox-config";

export default function Overview() {
  return (
    <div style={{ maxWidth: 760 }}>
      <h1>{SANDBOX_NAME}</h1>
      <p style={{ color: "var(--muted)" }}>
        A limited demonstration build prepared for application review. It showcases
        sample tools from the StocksMax Research platform, powered by live Tiingo
        market data. The full project — the multi-agent research pipeline, EDGAR
        tooling, charting engine, and production data layer — is private and not
        included here.
      </p>

      <div className="grid" style={{ marginTop: 18 }}>
        <div className="card">
          <h2>📊 Customizable Dashboard</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Build your own market view from sample widgets: quotes, price charts,
            news, and a watchlist. Layout is saved in your browser.
          </p>
          <Link href="/dashboard">Open dashboard →</Link>
        </div>
        <div className="card">
          <h2>📝 Research Paper Writer</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Generate a structured stock research brief from live Tiingo data,
            optionally polished by an AI model with your own key.
          </p>
          <Link href="/paper">Open paper writer →</Link>
        </div>
        <div className="card">
          <h2>🔎 Research Brief</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            The StocksMax Research sourcing tool: parallel source agents sweep
            news, Hacker News and SEC EDGAR, then a writer drafts a brief with
            [n] citations into the findings.
          </p>
          <Link href="/research">Open research →</Link>
        </div>
        <div className="card">
          <h2>📺 YouTube Calls</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Scan finance YouTubers&apos; recent uploads and extract every explicit
            buy/sell/hold call from the transcripts — with call markers on the
            price chart.
          </p>
          <Link href="/calls">Open YouTube calls →</Link>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Getting started</h2>
        <ol style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1.7 }}>
          <li>
            Go to <Link href="/settings">Settings</Link> and paste your free{" "}
            <a href="https://www.tiingo.com" target="_blank" rel="noreferrer">Tiingo</a>{" "}
            API key (required for market data).
          </li>
          <li>
            Optionally add an{" "}
            <a href="https://openrouter.ai" target="_blank" rel="noreferrer">OpenRouter</a>{" "}
            key to enable the AI-written papers, research and KPI sourcing.
          </li>
          <li>Keys stay in your browser only — this sandbox stores nothing server-side.</li>
        </ol>
      </div>
    </div>
  );
}
