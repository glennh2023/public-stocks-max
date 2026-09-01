import type { Metadata } from "next";
import "./globals.css";
import { SANDBOX_NAME, SANDBOX_NOTICE } from "@/lib/sandbox-config";
import Nav from "@/components/Nav";
import AccessGate from "@/components/AccessGate";

export const metadata: Metadata = {
  title: SANDBOX_NAME,
  description: SANDBOX_NOTICE,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="sandbox-banner">⚠ {SANDBOX_NOTICE}</div>
        <AccessGate>
          <div className="layout">
            <Nav />
            <main className="main">{children}</main>
          </div>
        </AccessGate>
      </body>
    </html>
  );
}
