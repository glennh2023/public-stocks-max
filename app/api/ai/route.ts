import { NextRequest, NextResponse } from "next/server";

// Thin OpenRouter proxy for the AI-powered tools. The caller
// supplies their own key via the `x-openrouter-key` header. Nothing is stored
// server-side. Optional: the sandbox works without an AI key (template mode).

export async function POST(req: NextRequest) {
  // Per-user key from Settings takes precedence; a local .env (gitignored,
  // never committed) can provide a fallback for development convenience.
  const key = req.headers.get("x-openrouter-key") || process.env.OPENROUTER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Missing OpenRouter API key. Add yours in Settings." },
      { status: 401 },
    );
  }

  let body: { model?: string; system?: string; prompt?: string; max_tokens?: number; temperature?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { model, system, prompt, max_tokens, temperature } = body;
  if (!prompt) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "google/gemini-3.7-flash",
      // Forwarded so callers that need long structured output (e.g. exhaustive
      // call extraction) don't get truncated by a low default.
      ...(typeof max_tokens === "number" ? { max_tokens: Math.min(8000, Math.max(1, max_tokens)) } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `OpenRouter error ${res.status}: ${text.slice(0, 300)}` },
      { status: res.status === 401 ? 401 : 502 },
    );
  }
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content || "";
  return NextResponse.json({ text });
}
