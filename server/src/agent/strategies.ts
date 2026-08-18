import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { runSandboxed } from "./sandbox.js";
import type { Analysis } from "../analysis/engine.js";

/**
 * RIKU'S PLAYBOOKS — analysis strategies he authors, tunes, and retires
 * himself. Each strategy is a small JS evaluator he wrote, run in the sandbox
 * against the FACTS of a researched coin. Strategies can adjust his read and
 * set their own buy bar / position size — but the code-owned HARD REJECTS
 * (rugs, serial scammers, top-heavy holders) are untouchable by design.
 */
export interface Strategy {
  id: string;
  name: string;
  thesis: string;
  /** JS defining evaluate(facts) -> {fit:boolean, adj:number(-15..15), note:string} */
  code: string;
  buyBar: number; // buyScore needed when THIS strategy fits
  sizeSol: number; // position size when buying on this strategy
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  perf: { evals: number; fits: number; buys: number; wins: number; losses: number; pnlSol: number };
}

export interface StrategyRead {
  id: string;
  name: string;
  fit: boolean;
  adj: number;
  note: string;
}

const FILE = path.join(cfg.dataDir, "strategies.json");
let strategies: Strategy[] = [];

const SEEDS: Omit<Strategy, "id" | "createdAt" | "updatedAt" | "perf">[] = [
  {
    name: "FRESH CURVE SNIPER",
    thesis: "Brand-new launches, minutes old, where the dev's record and early holder spread are the only truth that exists yet.",
    code: `function evaluate(f) {
  if (f.venue !== "curve" || f.ageMin === null || f.ageMin > 240) return { fit: false, adj: 0, note: "not a fresh curve" };
  let adj = 0; const why = [];
  if (f.dev.known && f.dev.bondRate > 0.3) { adj += 6; why.push("dev bonds " + Math.round(f.dev.bondRate * 100) + "%"); }
  if (f.holders && f.holders.top10Pct < 25) { adj += 4; why.push("clean spread"); }
  if (f.mcSol > 0 && f.mcSol < 60) { adj += 2; why.push("early on the curve"); }
  return { fit: adj >= 6, adj, note: why.join(", ") || "fresh but unremarkable" };
}`,
    buyBar: 55,
    sizeSol: 0.05,
    enabled: true,
  },
  {
    name: "COMMUNITY SURVIVOR",
    thesis: "Coins that launched DAYS ago and refused to die: graduated or deep into the curve, holders sticking around, dev long quiet. Survival is the signal — the community IS the product.",
    code: `function evaluate(f) {
  const ageH = f.ageMin === null ? null : f.ageMin / 60;
  if (ageH === null || ageH < 36) return { fit: false, adj: 0, note: "too young for this playbook" };
  let adj = 0; const why = [];
  if (f.venue === "amm") { adj += 6; why.push("graduated and trading"); }
  if (ageH > 72) { adj += 3; why.push(Math.round(ageH / 24) + "d old and alive"); }
  if (f.holders && f.holders.top10Pct < 30) { adj += 4; why.push("distributed"); }
  if (f.holders && f.holders.top1Pct > 15) { adj -= 8; why.push("one whale owns it"); }
  return { fit: adj >= 7, adj, note: why.join(", ") || "old but hollow" };
}`,
    buyBar: 48,
    sizeSol: 0.07,
    enabled: true,
  },
];

function save(): void {
  try {
    fs.writeFileSync(FILE, JSON.stringify(strategies, null, 1));
  } catch (e) {
    log.warn("strategy", `save failed: ${String(e).slice(0, 100)}`);
  }
}

export function loadStrategies(): void {
  try {
    strategies = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    strategies = SEEDS.map((s) => ({
      ...s,
      id: crypto.randomBytes(4).toString("hex"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      perf: { evals: 0, fits: 0, buys: 0, wins: 0, losses: 0, pnlSol: 0 },
    }));
    save();
    log.info("strategy", `seeded ${strategies.length} starter playbooks`);
  }
}
loadStrategies();

export const listStrategies = (): Strategy[] => strategies;

/** The exact facts object strategy code receives (documented in the menu). */
export function factsFor(a: Analysis): Record<string, unknown> {
  const st: any = a.state;
  return {
    symbol: a.symbol,
    name: a.name,
    venue: st?.kind ?? "unknown", // "curve" | "amm" | others
    mcSol: typeof st?.mcSol === "number" ? st.mcSol : 0,
    mcUsd: typeof st?.mcSol === "number" ? st.mcSol * a.solUsd : 0,
    ageMin: a.ageMin,
    sentUsd: a.sentUsd,
    score: a.score,
    buyScore: a.buyScore,
    holders: a.holders ? { top1Pct: a.holders.top1Pct, top10Pct: a.holders.top10Pct, count: a.holders.holderAddresses.length } : null,
    dev: { known: a.dev.known, launches: a.dev.launches, bonds: a.dev.bonds, bondRate: a.dev.bondRate, onWatchlist: a.dev.onWatchlist },
    smartWallets: a.smartWallets.length,
    checks: a.rows.map((r) => ({ label: r.label, verdict: r.verdict, detail: r.detail.slice(0, 80) })),
  };
}

/** Run every enabled playbook against a coin's facts. Never throws. */
export function evaluateStrategies(facts: Record<string, unknown>): StrategyRead[] {
  const reads: StrategyRead[] = [];
  for (const s of strategies.filter((x) => x.enabled)) {
    const res = runSandboxed(s.code, { }, { entry: `evaluate(${JSON.stringify(facts)})`, timeoutMs: 1_000 });
    s.perf.evals++;
    if (!res.ok || typeof res.result !== "object" || res.result === null) {
      reads.push({ id: s.id, name: s.name, fit: false, adj: 0, note: `evaluator error: ${res.error ?? "bad return"}` });
      continue;
    }
    const r = res.result as any;
    const fit = r.fit === true;
    if (fit) s.perf.fits++;
    reads.push({
      id: s.id,
      name: s.name,
      fit,
      adj: Math.max(-15, Math.min(15, Math.round(Number(r.adj) || 0))),
      note: String(r.note ?? "").slice(0, 120),
    });
  }
  save();
  return reads;
}

export const getStrategy = (id: string): Strategy | undefined => strategies.find((s) => s.id === id);

/** Validate by test-running against a fixture — bad code is rejected loudly
 *  so he learns the format instead of shipping a broken playbook. */
const FIXTURE = {
  symbol: "TEST", name: "Test", venue: "curve", mcSol: 30, mcUsd: 4500, ageMin: 90, sentUsd: null,
  score: 50, buyScore: 50, holders: { top1Pct: 4, top10Pct: 22, count: 120 },
  dev: { known: true, launches: 5, bonds: 2, bondRate: 0.4, onWatchlist: false }, smartWallets: 1, checks: [],
};
function validateCode(code: string): string | null {
  const res = runSandboxed(code, {}, { entry: `evaluate(${JSON.stringify(FIXTURE)})`, timeoutMs: 1_000 });
  if (!res.ok) return res.error ?? "evaluator failed";
  const r = res.result as any;
  if (!r || typeof r !== "object" || typeof r.fit !== "boolean") return "evaluate(facts) must return {fit:boolean, adj:number, note:string}";
  return null;
}

export function createStrategy(input: { name: string; thesis: string; code: string; buyBar: number; sizeSol: number }): { ok: boolean; id?: string; err?: string } {
  if (strategies.length >= 12) return { ok: false, err: "12 playbooks max — retire one first" };
  const bad = validateCode(input.code);
  if (bad) return { ok: false, err: bad };
  const s: Strategy = {
    id: crypto.randomBytes(4).toString("hex"),
    name: input.name.slice(0, 40).toUpperCase(),
    thesis: input.thesis.slice(0, 300),
    code: input.code,
    buyBar: Math.max(35, Math.min(90, Math.round(input.buyBar))),
    sizeSol: Math.max(0.01, Math.min(cfg.maxTradeSol, input.sizeSol)),
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    perf: { evals: 0, fits: 0, buys: 0, wins: 0, losses: 0, pnlSol: 0 },
  };
  strategies.push(s);
  save();
  log.info("strategy", `new playbook: ${s.name} (bar ${s.buyBar}, size ${s.sizeSol})`);
  return { ok: true, id: s.id };
}

export function updateStrategy(id: string, patch: Partial<Pick<Strategy, "thesis" | "code" | "buyBar" | "sizeSol" | "enabled">>): { ok: boolean; err?: string } {
  const s = getStrategy(id);
  if (!s) return { ok: false, err: "no such playbook" };
  if (patch.code !== undefined) {
    const bad = validateCode(patch.code);
    if (bad) return { ok: false, err: bad };
    s.code = patch.code;
  }
  if (patch.thesis !== undefined) s.thesis = patch.thesis.slice(0, 300);
  if (patch.buyBar !== undefined) s.buyBar = Math.max(35, Math.min(90, Math.round(patch.buyBar)));
  if (patch.sizeSol !== undefined) s.sizeSol = Math.max(0.01, Math.min(cfg.maxTradeSol, patch.sizeSol));
  if (patch.enabled !== undefined) s.enabled = patch.enabled;
  s.updatedAt = Date.now();
  save();
  return { ok: true };
}

export function retireStrategy(id: string): { ok: boolean; err?: string } {
  const s = getStrategy(id);
  if (!s) return { ok: false, err: "no such playbook" };
  s.enabled = false;
  s.updatedAt = Date.now();
  save();
  return { ok: true };
}

export function noteStrategyBuy(id: string): void {
  const s = getStrategy(id);
  if (s) { s.perf.buys++; save(); }
}
export function noteStrategyClose(id: string, pnlSol: number): void {
  const s = getStrategy(id);
  if (!s) return;
  s.perf.pnlSol = Math.round((s.perf.pnlSol + pnlSol) * 1e4) / 1e4;
  if (pnlSol >= 0) s.perf.wins++; else s.perf.losses++;
  save();
}

/** One line per playbook for his planning prompts. */
export function strategiesDigest(): string {
  return strategies
    .map((s) =>
      `- [${s.id}] ${s.name}${s.enabled ? "" : " (RETIRED)"} — bar ${s.buyBar}, size ${s.sizeSol} SOL | ` +
      `evals ${s.perf.evals}, fits ${s.perf.fits}, buys ${s.perf.buys}, ${s.perf.wins}W/${s.perf.losses}L, pnl ${s.perf.pnlSol >= 0 ? "+" : ""}${s.perf.pnlSol} SOL | ${s.thesis.slice(0, 90)}`)
    .join("\n") || "(no playbooks)";
}
