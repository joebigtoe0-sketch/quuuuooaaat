import vm from "node:vm";

/**
 * The sandbox where RIKU'S OWN code runs: strategy evaluators and one-off
 * analysis scripts. Code originates from his brain (never from coin metadata,
 * which cannot reach these paths), so the goal here is containment against
 * accidents — no fs, no net, no process, hard time and output caps — not a
 * cryptographic security boundary.
 */
export interface SandboxResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  prints: string[];
}

const MAX_CODE = 8_000;
const MAX_PRINTS = 200;
const MAX_LINE = 300;

/** Deep-clone to plain data so nothing from the host realm leaks in. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

export function runSandboxed(
  code: string,
  globals: Record<string, unknown>,
  opts: { timeoutMs?: number; entry?: string } = {},
): SandboxResult {
  const prints: string[] = [];
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "empty code", prints };
  if (code.length > MAX_CODE) return { ok: false, error: `code too long (${code.length} > ${MAX_CODE})`, prints };
  const print = (...args: unknown[]) => {
    if (prints.length >= MAX_PRINTS) return;
    const line = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
      .slice(0, MAX_LINE);
    prints.push(line);
  };
  const table = (rows: unknown) => {
    if (!Array.isArray(rows)) return print(String(rows));
    for (const r of rows.slice(0, 40)) {
      if (r && typeof r === "object") print(Object.values(r as object).map((v) => String(v).padEnd(14).slice(0, 14)).join(" "));
      else print(String(r));
    }
  };
  const ctx = vm.createContext(
    { print: harden(print), log: harden(print), table: harden(table), ...plainGlobals(globals) },
    // afterEvaluate: sandbox microtasks (Promise loops) drain INSIDE the timed
    // window instead of freezing the host event loop after evaluation
    { name: "riku-sandbox", microtaskMode: "afterEvaluate" },
  );
  try {
    const script = new vm.Script(
      `"use strict";\n${code}\n;${opts.entry ?? ""}`,
      { filename: "riku.js" },
    );
    const result = script.runInContext(ctx, { timeout: opts.timeoutMs ?? 2_000 });
    return { ok: true, result: safeResult(result), prints };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300), prints };
  }
}

/** Sever the .constructor path back to the HOST Function — a hardened fn has
 *  no prototype chain, so sandbox code can't do print.constructor("...")(). */
function harden<T extends (...a: never[]) => unknown>(fn: T): T {
  const raw = fn as unknown as (...x: unknown[]) => unknown;
  const wrapped = ((...a: unknown[]) => raw(...a)) as unknown as T;
  Object.setPrototypeOf(wrapped, null);
  Object.freeze(wrapped);
  return wrapped;
}

function plainGlobals(globals: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(globals)) out[k] = typeof v === "function" ? harden(v as () => unknown) : plain(v);
  return out;
}

function safeResult(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v).slice(0, 500);
  }
}
