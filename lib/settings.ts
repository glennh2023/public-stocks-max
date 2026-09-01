"use client";

// All user configuration lives in the browser (localStorage). There are no
// environment variables and no server-side storage: API keys are entered by
// each user in Settings and sent per-request to the thin proxy routes.

const KEYS = {
  access: "gff_sandbox_access_ok",
  tiingo: "gff_sandbox_tiingo_key",
  openrouter: "gff_sandbox_openrouter_key",
  model: "gff_sandbox_openrouter_model",
  dashboard: "gff_sandbox_dashboard_layout",
  papers: "gff_sandbox_papers",
  evomiHost: "gff_sandbox_evomi_host",
  evomiPort: "gff_sandbox_evomi_port",
  evomiUser: "gff_sandbox_evomi_user",
  evomiPass: "gff_sandbox_evomi_pass",
} as const;

export type SettingKey = keyof typeof KEYS;

export function getSetting(key: SettingKey): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(KEYS[key]) || "";
  } catch {
    return "";
  }
}

export function setSetting(key: SettingKey, value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(KEYS[key], value);
    else localStorage.removeItem(KEYS[key]);
  } catch {
    // storage unavailable (private mode etc.) — settings just won't persist
  }
}

export function getJSON<T>(key: SettingKey, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJSON(key: SettingKey, value: unknown) {
  setSetting(key, JSON.stringify(value));
}

export const DEFAULT_MODEL = "google/gemini-3.7-flash";
