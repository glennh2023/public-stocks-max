"use client";

import { useEffect, useState } from "react";
import { DEFAULT_MODEL, getSetting, setSetting } from "@/lib/settings";

export default function SettingsPage() {
  const [tiingo, setTiingo] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [evomiHost, setEvomiHost] = useState("");
  const [evomiPort, setEvomiPort] = useState("");
  const [evomiUser, setEvomiUser] = useState("");
  const [evomiPass, setEvomiPass] = useState("");
  const [evomiPaste, setEvomiPaste] = useState("");
  const [pasteErr, setPasteErr] = useState("");
  const [saved, setSaved] = useState(false);

  /** Parse "host:port:user:pass" (optionally http://-prefixed) into the fields. */
  function parseEvomiPaste(raw: string) {
    const t = raw.trim().replace(/^\w+:\/\//, "").replace(/\/+$/, "");
    if (!t) { setPasteErr(""); return; }
    // Also accept the user:pass@host:port form some providers hand out.
    let parts: string[];
    const at = t.split("@");
    if (at.length === 2) {
      const [creds, hostport] = at;
      parts = [...hostport.split(":"), ...creds.split(":")];
    } else {
      parts = t.split(":");
    }
    const [host, port, user, pass] = parts;
    if (!host || !port) { setPasteErr("Expected host:port:user:pass"); return; }
    setEvomiHost(host); setEvomiPort(port);
    setEvomiUser(user ?? ""); setEvomiPass(pass ?? "");
    setPasteErr("");
  }

  useEffect(() => {
    setTiingo(getSetting("tiingo"));
    setOpenrouter(getSetting("openrouter"));
    setModel(getSetting("model") || DEFAULT_MODEL);
    setEvomiHost(getSetting("evomiHost"));
    setEvomiPort(getSetting("evomiPort"));
    setEvomiUser(getSetting("evomiUser"));
    setEvomiPass(getSetting("evomiPass"));
  }, []);

  function save() {
    setSetting("tiingo", tiingo.trim());
    setSetting("openrouter", openrouter.trim());
    setSetting("model", model.trim());
    setSetting("evomiHost", evomiHost.trim());
    setSetting("evomiPort", evomiPort.trim());
    setSetting("evomiUser", evomiUser.trim());
    setSetting("evomiPass", evomiPass.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Settings</h1>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>
        Keys are stored only in this browser&apos;s localStorage and sent directly with
        your own requests. Nothing is stored on the server, and no keys ship with
        this codebase.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="label">Tiingo API key (required for market data)</div>
        <input className="input" style={{ marginTop: 6 }} type="password"
          value={tiingo} onChange={(e) => setTiingo(e.target.value)}
          placeholder="Get a free key at tiingo.com" />

        <div className="label" style={{ marginTop: 14 }}>OpenRouter API key (optional, for AI features)</div>
        <input className="input" style={{ marginTop: 6 }} type="password"
          value={openrouter} onChange={(e) => setOpenrouter(e.target.value)}
          placeholder="sk-or-..." />

        <div className="label" style={{ marginTop: 14 }}>OpenRouter model</div>
        <input className="input" style={{ marginTop: 6 }}
          value={model} onChange={(e) => setModel(e.target.value)} />

        <button className="btn" style={{ marginTop: 14 }} onClick={save}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="label">Residential proxy (Evomi) — optional</div>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
          YouTube bot-gates datacenter/server IPs and strips caption tracks, so
          the YouTube Calls transcript path returns nothing from most hosts.
          Routing those requests through your own residential proxy restores
          them. Requires the <code>undici</code> package (<code>npm install undici</code>).
        </p>
        <div className="label" style={{ marginTop: 8 }}>Paste (host:port:user:pass) — auto-fills below</div>
        <input className="input" style={{ marginTop: 6 }}
          value={evomiPaste}
          onChange={(e) => { setEvomiPaste(e.target.value); parseEvomiPaste(e.target.value); }}
          placeholder="http://core-residential.evomi.com:1000:user:pass" />
        {pasteErr ? <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>{pasteErr}</div> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input className="input" style={{ flex: 2 }} value={evomiHost}
            onChange={(e) => setEvomiHost(e.target.value)} placeholder="proxy host" />
          <input className="input" style={{ flex: 1 }} value={evomiPort}
            onChange={(e) => setEvomiPort(e.target.value)} placeholder="port" />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input className="input" style={{ flex: 1 }} value={evomiUser}
            onChange={(e) => setEvomiUser(e.target.value)} placeholder="username" />
          <input className="input" style={{ flex: 1 }} type="password" value={evomiPass}
            onChange={(e) => setEvomiPass(e.target.value)} placeholder="password" />
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={save}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}
