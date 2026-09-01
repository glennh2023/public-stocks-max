"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SANDBOX_NAME } from "@/lib/sandbox-config";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/paper", label: "Paper Writer" },
  { href: "/research", label: "Research Brief" },
  { href: "/deep", label: "Deep Desk" },
  { href: "/calls", label: "YouTube Calls" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="sidebar">
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, color: "var(--accent)" }}>StocksMax Research</div>
        <div className="label">{SANDBOX_NAME.split("—")[1]?.trim() || "Demo"}</div>
      </div>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`nav-link${path === l.href ? " active" : ""}`}
        >
          {l.label}
        </Link>
      ))}
      <div style={{ marginTop: 24 }}>
        <span className="badge warn">Limited sandbox</span>
      </div>
    </nav>
  );
}
