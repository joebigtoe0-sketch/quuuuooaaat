import { store } from "../store.js";

/**
 * Provider-agnostic LLM call — ported from universe/server/src/brain/adapter.ts.
 * Any OpenAI-compatible /chat/completions endpoint; daily USD circuit breaker;
 * any failure returns null and the caller falls back to a mock line. The show
 * never dies because the model did.
 */
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const API_KEY = process.env.LLM_API_KEY ?? "";
export const MODEL = process.env.LLM_MODEL ?? "gpt-5-mini";
export const FRAGMENT_MODEL = process.env.LLM_MODEL_FRAGMENT ?? MODEL;

const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT ?? "low";
const REASONING_BUDGET =
  REASONING_EFFORT === "low" ? 2400 : REASONING_EFFORT === "medium" ? 9000 : 20000;

function bodyFor(model: string, maxTokens: number, temperature: number) {
  // reasoning-family models reject `temperature` and count thinking tokens
  // against max_completion_tokens — give them headroom (universe lesson).
  if (/^(gpt-5|o\d)/i.test(model)) {
    return {
      model,
      max_completion_tokens: maxTokens + REASONING_BUDGET,
      reasoning_effort: REASONING_EFFORT,
    };
  }
  // Claude (via Anthropic's OpenAI-compatible endpoint): current models
  // (opus-5/sonnet-5/fable) REJECT sampling params with a 400 — omit them.
  // Opus 5 thinks BY DEFAULT and max_tokens caps thinking + response text
  // together — without headroom the reply gets truncated mid-thought and
  // json parses fail (billing the thinking anyway). Haiku doesn't think.
  if (/^claude-/i.test(model)) {
    if (/haiku/i.test(model)) return { model, max_tokens: maxTokens };
    // low effort = fast + cheap thinking; a live show can't wait 60s on a plan
    return { model, max_tokens: maxTokens + 3500, reasoning_effort: "low" };
  }
  return { model, max_tokens: maxTokens, temperature };
}

const DAILY_USD = Number(process.env.LLM_DAILY_USD ?? 10);
const PRICE_IN = Number(process.env.LLM_PRICE_IN ?? 1.25);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT ?? 10);

export function hasApiKey(): boolean {
  return API_KEY.length > 0;
}

let lastCallError: { note: string; at: number } | null = null;
let lastErrorLogAt = 0;
export function lastBrainError(): { note: string; agoSec: number } | null {
  return lastCallError
    ? { note: lastCallError.note, agoSec: Math.round((Date.now() - lastCallError.at) / 1000) }
    : null;
}

const spendKey = () => `spend:${new Date().toISOString().slice(0, 10)}`;
export const spendToday = () => Number(store.kvGet(spendKey()) ?? 0);
export const budgetExhausted = () => spendToday() >= DAILY_USD;

// When the primary model is overloaded (529/503/429), retry once on a fallback
// so the show keeps a real brain while opus capacity is saturated.
const FALLBACK_MODEL =
  process.env.LLM_MODEL_FALLBACK ?? (/^claude-/i.test(MODEL) ? "claude-sonnet-5" : "");
let fallbackLogAt = 0;
// circuit breaker: once the primary 529s, stop paying a failed attempt on
// every call — go straight to the fallback and re-probe the primary later.
let primaryDownUntil = 0;

export async function callFreeform(
  system: string,
  user: string,
  maxTokens: number,
  model: string = MODEL,
): Promise<string | null> {
  if (!hasApiKey() || budgetExhausted()) return null;
  const haveFallback = FALLBACK_MODEL.length > 0 && FALLBACK_MODEL !== model;
  if (haveFallback && model === MODEL && Date.now() < primaryDownUntil) {
    return (await attemptOnce(system, user, maxTokens, FALLBACK_MODEL)).text;
  }
  const first = await attemptOnce(system, user, maxTokens, model);
  if (first.text !== null || !first.overloaded) return first.text;
  if (haveFallback) {
    primaryDownUntil = Date.now() + 5 * 60_000;
    if (Date.now() - fallbackLogAt > 600_000) {
      fallbackLogAt = Date.now();
      const { log } = await import("../log.js");
      log.warn("brain", `${model} overloaded — routing to ${FALLBACK_MODEL}, re-probing the primary every 5 min`);
    }
    return (await attemptOnce(system, user, maxTokens, FALLBACK_MODEL)).text;
  }
  return null;
}

async function attemptOnce(
  system: string,
  user: string,
  maxTokens: number,
  model: string,
): Promise<{ text: string | null; overloaded: boolean }> {
  const controller = new AbortController();
  // reasoning models can think for a while — give real headroom
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        ...bodyFor(model, maxTokens, 0.9),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      let why = `http ${res.status}`;
      let overloaded = res.status === 529 || res.status === 503 || res.status === 429;
      try {
        const body = await res.text();
        if (/credit balance/i.test(body)) why = "ANTHROPIC CREDITS EXHAUSTED — top up the account or the brain stays on canned lines";
        else why = `http ${res.status}: ${body.slice(0, 120)}`;
        if (/overloaded/i.test(body)) overloaded = true;
      } catch {}
      lastCallError = { note: why, at: Date.now() };
      // surface loudly (throttled) — this also lands in the on-stage terminal
      if (Date.now() - lastErrorLogAt > 600_000) {
        lastErrorLogAt = Date.now();
        const { log } = await import("../log.js");
        log.warn("brain", why);
      }
      return { text: null, overloaded };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inTok = data.usage?.prompt_tokens ?? 0;
    const outTok = data.usage?.completion_tokens ?? 0;
    store.kvSet(spendKey(), String(spendToday() + (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6));
    lastCallError = null; // the pipeline is healthy — don't parade a stale error
    return { text: data.choices?.[0]?.message?.content?.trim() ?? null, overloaded: false };
  } catch (e) {
    lastCallError = { note: String(e).slice(0, 120), at: Date.now() };
    return { text: null, overloaded: false };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON call with tolerant repair (models emit raw newlines + trailing commas). */
export async function callJson(
  system: string,
  user: string,
  maxTokens: number,
  model: string = MODEL,
): Promise<Record<string, unknown> | null> {
  const raw = await callFreeform(system, user, maxTokens, model);
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const attempts = [
    match[0],
    match[0].replace(/[\r\n]+/g, " "),
    match[0].replace(/[\r\n]+/g, " ").replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const a of attempts) {
    try {
      return JSON.parse(a) as Record<string, unknown>;
    } catch {
      /* next repair */
    }
  }
  return null;
}
