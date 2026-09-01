"use client";

import { useEffect, useState } from "react";
import { ACCESS_CODE, SANDBOX_NAME } from "@/lib/sandbox-config";
import { getSetting, setSetting } from "@/lib/settings";

// Lightweight access gate for shared deployments. This is a convenience
// filter, not real security — the code is in the client bundle.

export default function AccessGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setOk(getSetting("access") === "yes");
  }, []);

  if (ok === null) return null;
  if (ok) return <>{children}</>;

  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "18vh" }}>
      <div className="card" style={{ width: 380 }}>
        <h1>{SANDBOX_NAME}</h1>
        <p style={{ color: "var(--muted)", fontSize: 14 }}>
          This is a limited-access demo. Enter the access code you were given.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim() === ACCESS_CODE) {
              setSetting("access", "yes");
              setOk(true);
            } else {
              setErr("Incorrect access code.");
            }
          }}
        >
          <input
            className="input"
            type="password"
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 6 }}>{err}</div>}
          <button className="btn" style={{ marginTop: 10, width: "100%" }} type="submit">
            Enter sandbox
          </button>
        </form>
      </div>
    </div>
  );
}
