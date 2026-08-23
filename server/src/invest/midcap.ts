import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { callJson } from "../brain/adapter.js";

/**
 * MIDCAP — the investment book. Omo's read layer with our discipline: scan
 * established pump.fun-born mid-caps with real communities (public identity,
 * real liquidity, a tape that survived the day), write a thesis, buy small.
 *
 * DELIBERATELY NO AUTOMATIC EXITS. These are liquid community coins that the
 * operator judged recover from dips; a stop here converts drawdown into
 * realized loss. Positions carry strategyId "midcap", which (like "hold"):
 *   - the planner's position watcher never reviews
 *   - tradeSell refuses without the operator flag
 * The ONLY exit is the operator selling from /admin/book.html.
 *
 * What we kept from omo: the universe (identity-required mid-caps), the
 * fake-chart tells (fee receipts, wash ratios, distribution corpses), the
 * thesis-before-order shape. What we didn't: their no-sell-code accident is
 * here a decision with an owner, their marks-as-PnL framing is impossible
 * (our ledger separates realized from marks), and every buy is still
 * hash-committed on-chain before execution like every other RIKU trade.
 */

const STRATEGY = "midcap";

interface MidcapState {
  day: string;
  count: number;
  /** mint -> last time we wrote a thesis on it (cooldown, buys AND passes) */
  seen: Record<string, number>;
}
const FILE = () => path.join(cfg.dataDir, "midcap.json");
let st: MidcapState = { day: "", count: 0, seen: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.seen) st = j;
} catch { /* first run */ }
function save(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(st));
  } catch {}
}
const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- scanner --

interface Pair {
  chainId?: string;
  url?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  baseToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  info?: { websites?: { url?: string }[]; socials?: { type?: string; url?: string }[] };
}

export interface MidcapCandidate {
  symbol: string;
  name: string;
  mint: string;
  priceUsd: number;
  liqUsd: number;
  mcUsd: number;
  vol24h: number;
  vol1h: number;
  chg1h: number;
  chg6h: number;
  chg24h: number;
  buys1h: number;
  sells1h: number;
  ageHours: number;
  socials: string[];
  hasSite: boolean;
}

// rotated per tick — a single fixed query would show us the same board forever
const QUERY_POOL = [
  "SOL pump", "SOL cat", "SOL dog", "SOL ai", "SOL pepe", "SOL agent",
  "SOL frog", "SOL moon", "SOL coin", "SOL baby", "SOL mascot", "SOL wojak",
  "SOL streamer", "SOL community", "SOL creator", "SOL bird", "SOL sigma",
  "SOL king", "SOL goat", "SOL chill",
];
const STABLE = /^(usdc|usdt|sol|wsol|jup|jto|ray|bonk|wif|pyusd|msol|jitosol)$/i;

async function j<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "riku/1.0" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Omo's manufactured-chart tells, kept intact — they were the best thing in
 *  that repo. A chart that fails any of these is not evidence of anything. */
function isFakeChart(p: Pair, liq: number, ageHours: number): boolean {
  const vol1h = p.volume?.h1 ?? 0;
  const vol5m = p.volume?.m5 ?? 0;
  const vol6h = p.volume?.h6 ?? 0;
  const vol24h = p.volume?.h24 ?? 0;
  const buys = p.txns?.h1?.buys ?? 0;
  const sells = p.txns?.h1?.sells ?? 0;
  const trades = buys + sells;
  const chg1h = p.priceChange?.h1 ?? 0;
  const chg6h = p.priceChange?.h6 ?? 0;
  const chg24h = p.priceChange?.h24 ?? 0;
  const fdv = p.fdv ?? 0;
  // fee receipts: real turnover leaves fees behind; a float that never
  // generated any was walked, not bought
  const lifeVol = ageHours > 0 && ageHours < 24 ? vol24h : Math.max(vol24h, vol6h * 4);
  const feesUsd = lifeVol * 0.005;
  if (ageHours > 0 && ageHours < 72 && fdv > 0 && feesUsd < fdv * 0.03) return true;
  // an hour cannot really turn over its own depth twenty times
  if (liq > 0 && vol1h > liq * 20) return true;
  if (liq > 0 && vol24h > liq * 150) return true;
  // volume with almost nobody behind it / whale-ticket wash loops
  if (vol1h > 50_000 && trades < 60) return true;
  if (trades > 0 && vol1h / trades > 2_500 && liq < 150_000) return true;
  if (trades > 40 && (buys === 0 || sells === 0)) return true;
  // distribution corpses — nothing intelligent can be said about a straight bleed
  if (chg1h < -25 && chg6h < -40) return true;
  if (chg24h < -55 && chg6h < -20) return true;
  // dead tape / headline day with an empty present
  if (liq > 0 && vol1h < liq * 0.15 && vol24h < liq * 3) return true;
  if (vol5m === 0 && vol1h < 5_000) return true;
  if (vol24h > 0 && vol6h / vol24h < 0.06) return true;
  // paper float on a sliver of real depth
  if (liq > 0 && fdv > 0 && fdv / liq > 30) return true;
  return false;
}

function toCandidate(p: Pair): MidcapCandidate | null {
  if (p.chainId !== "solana") return null;
  const symbol = p.baseToken?.symbol?.trim();
  const mint = p.baseToken?.address;
  const price = Number(p.priceUsd);
  if (!symbol || !mint || !Number.isFinite(price) || price <= 0) return null;
  if (STABLE.test(symbol)) return null;
  // our trader routes pump.fun curve + PumpSwap only — the pump mint suffix is
  // the cheap prefilter; getTokenState at buy time is the authoritative check
  if (!/pump$/i.test(mint)) return null;
  const liq = p.liquidity?.usd ?? 0;
  const created = p.pairCreatedAt ?? 0;
  const ageHours = created ? Math.max(0, (Date.now() - created) / 3_600_000) : 0;
  const socials = (p.info?.socials ?? []).map((s) => (s.type ?? "").toLowerCase()).filter(Boolean);
  const hasSite = !!p.info?.websites?.length;
  // the REAL-PROJECT bar, all of it: public identity + depth + a live crowd +
  // a tape older than a launch candle. This is the whole universe thesis —
  // established community coins, not launches.
  if (!socials.includes("twitter") || !(hasSite || socials.length >= 2)) return null;
  if (liq < cfg.midcapMinLiqUsd) return null;
  if ((p.volume?.h24 ?? 0) < cfg.midcapMinVol24Usd) return null;
  if ((p.volume?.h1 ?? 0) < 15_000) return null;
  if ((p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0) < 250) return null;
  if (ageHours < cfg.midcapMinAgeHours) return null;
  if (isFakeChart(p, liq, ageHours)) return null;
  return {
    symbol,
    name: p.baseToken?.name?.trim() || symbol,
    mint,
    priceUsd: price,
    liqUsd: liq,
    mcUsd: p.marketCap ?? p.fdv ?? 0,
    vol24h: p.volume?.h24 ?? 0,
    vol1h: p.volume?.h1 ?? 0,
    chg1h: p.priceChange?.h1 ?? 0,
    chg6h: p.priceChange?.h6 ?? 0,
    chg24h: p.priceChange?.h24 ?? 0,
    buys1h: p.txns?.h1?.buys ?? 0,
    sells1h: p.txns?.h1?.sells ?? 0,
    ageHours,
    socials,
    hasSite,
  };
}

let rotation = 0;
export async function scanMidcaps(): Promise<MidcapCandidate[]> {
  rotation++;
  const queries = [0, 1, 2].map(
    (i) => QUERY_POOL[(rotation * 3 + i) % QUERY_POOL.length],
  );
  const [searched, boosts, profiles] = await Promise.all([
    Promise.all(
      queries.map((q) =>
        j<{ pairs?: Pair[] }>(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`),
      ),
    ),
    j<{ chainId?: string; tokenAddress?: string }[]>("https://api.dexscreener.com/token-boosts/top/v1"),
    j<{ chainId?: string; tokenAddress?: string }[]>("https://api.dexscreener.com/token-profiles/latest/v1"),
  ]);
  const extraMints = [
    ...new Set(
      [...(boosts ?? []), ...(profiles ?? [])]
        .filter((b) => b.chainId === "solana" && b.tokenAddress && /pump$/i.test(b.tokenAddress))
        .map((b) => b.tokenAddress as string),
    ),
  ].slice(0, 40);
  const extraPairs: Pair[] = [];
  for (let i = 0; i < extraMints.length; i += 25) {
    const r = await j<{ pairs?: Pair[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${extraMints.slice(i, i + 25).join(",")}`,
    );
    extraPairs.push(...(r?.pairs ?? []));
  }
  const pairs = [...extraPairs, ...searched.flatMap((r) => r?.pairs ?? [])];
  const best = new Map<string, MidcapCandidate>();
  for (const p of pairs) {
    const c = toCandidate(p);
    if (!c) continue;
    const prev = best.get(c.mint);
    if (!prev || c.liqUsd > prev.liqUsd) best.set(c.mint, c);
  }
  return [...best.values()].sort((a, b) => b.vol1h - a.vol1h);
}

// ----------------------------------------------------------------- thesis --

function describe(c: MidcapCandidate): string {
  const money = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : `$${Math.round(n / 1_000)}k`;
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const pressure =
    c.buys1h > c.sells1h * 1.15 ? "buyers leading the hour" :
    c.sells1h > c.buys1h * 1.15 ? "sellers leading the hour" : "two-sided hour";
  return (
    `$${c.symbol} (${c.name}) — mc ${money(c.mcUsd)}, liq ${money(c.liqUsd)}, ` +
    `vol 1h ${money(c.vol1h)} / 24h ${money(c.vol24h)}, ${pct(c.chg1h)} 1h ${pct(c.chg6h)} 6h ${pct(c.chg24h)} 24h, ` +
    `${pressure}, ${(c.ageHours / 24).toFixed(1)}d old, socials ${c.socials.join("/") || "none"}${c.hasSite ? " + site" : ""}`
  );
}

interface Verdict {
  verdict: "buy" | "pass";
  conviction: number; // 1..5
  thesis: string;
}

async function writeThesis(c: MidcapCandidate): Promise<Verdict | null> {
  const out = await callJson(
    "You are RIKU, an AI quant. This is your INVESTMENT book, not the trench book: established memecoins with real communities, " +
      "held for days or weeks, exits decided by a human. Judge ONE coin from live tape data. " +
      "Be brutally selective — the default answer is pass; a buy needs a reason the attention SUSTAINS (community, meme durability, fresh catalyst), " +
      "not just a green hour. You cannot see the chart's future and you know screen prices on thin pools lie. " +
      'Reply JSON only: {"verdict":"buy"|"pass","conviction":1-5,"thesis":"2-3 sentences: why the attention exists, what kills it"}',
    describe(c),
    250,
  );
  const v = out as any;
  if (!v || (v.verdict !== "buy" && v.verdict !== "pass") || typeof v.thesis !== "string") return null;
  return {
    verdict: v.verdict,
    conviction: Math.max(1, Math.min(5, Math.round(Number(v.conviction) || 1))),
    thesis: v.thesis.slice(0, 400),
  };
}

// ------------------------------------------------------------------- tick --

interface StageHooks {
  reveal: (mint: string, sol: number) => void;
}
let hooks: StageHooks | null = null;

async function tick(): Promise<void> {
  try {
    if (today() !== st.day) {
      st.day = today();
      st.count = 0;
    }
    if (st.count >= cfg.midcapMaxPerDay) return;
    const { openPositions } = await import("../chain/trader.js");
    const held = new Set(openPositions().map((p) => p.mint));
    const now = Date.now();
    const cands = (await scanMidcaps()).filter(
      (c) => !held.has(c.mint) && now - (st.seen[c.mint] ?? 0) > cfg.midcapCooldownDays * 86_400_000,
    );
    if (!cands.length) {
      log.info("midcap", "sweep: nothing new clears the real-project bar");
      return;
    }
    // one thesis per tick — this book moves slowly on purpose
    const c = cands[0];
    st.seen[c.mint] = now;
    // keep the seen map bounded
    for (const [m, at] of Object.entries(st.seen)) if (now - at > 30 * 86_400_000) delete st.seen[m];
    save();
    const v = await writeThesis(c);
    if (!v) {
      log.warn("midcap", `no verdict for $${c.symbol} — brain unavailable`);
      return;
    }
    if (v.verdict !== "buy" || v.conviction < cfg.midcapMinConviction) {
      log.info("midcap", `pass $${c.symbol} (${v.verdict}, conviction ${v.conviction}): ${v.thesis.slice(0, 100)}`);
      return;
    }
    // authoritative tradability check — the pump suffix was only the prefilter
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const { getTokenState } = await import("../chain/pump.js");
      const state = await getTokenState(new PublicKey(c.mint));
      if (state.kind !== "curve" && state.kind !== "amm") {
        log.info("midcap", `pass $${c.symbol} — not tradable on our rails (${state.kind})`);
        return;
      }
    } catch (e) {
      log.warn("midcap", `state check failed for $${c.symbol}: ${String(e).slice(0, 80)}`);
      return;
    }
    // sizing: floor + a % of spendable scaled by conviction (5/5 = full pct)
    let sol = cfg.midcapSol;
    try {
      const { solBalance } = await import("../chain/wallet.js");
      const spendable = Math.max(0, (await solBalance()) - cfg.floatSol);
      sol = Math.max(cfg.midcapSol, spendable * (cfg.midcapPct / 100) * (v.conviction / 5));
      sol = Math.round(sol * 1000) / 1000;
    } catch { /* balance unreadable — floor size */ }
    const thesis = `investment book (conviction ${v.conviction}/5): ${v.thesis}`;
    const { tradeBuy } = await import("../chain/trader.js");
    const r = await tradeBuy(c.mint, c.symbol, sol, thesis, null, STRATEGY);
    if (!r.ok) {
      log.info("midcap", `buy blocked $${c.symbol}: ${r.why}`);
      return;
    }
    st.count++;
    save();
    log.info(
      "midcap",
      `BOUGHT $${c.symbol} for the book (${sol} SOL, conviction ${v.conviction}/5, mc $${Math.round(c.mcUsd / 1000)}k)${r.dry ? " [dry]" : ""} — NO auto-exit, operator sells from /admin/book.html`,
    );
    hooks?.reveal(c.mint, sol);
  } catch (e) {
    log.warn("midcap", `tick failed: ${String(e).slice(0, 100)}`);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startMidcap(h: StageHooks): void {
  hooks = h;
  if (!cfg.midcap) {
    log.info("midcap", "MIDCAP off — no investment book");
    return;
  }
  if (timer) return;
  timer = setInterval(() => void tick(), cfg.midcapTickMin * 60_000);
  setTimeout(() => void tick(), 90_000);
  log.info(
    "midcap",
    `investment book LIVE — sweep every ${cfg.midcapTickMin}min, bar: $${Math.round(cfg.midcapMinLiqUsd / 1000)}k liq / $${Math.round(cfg.midcapMinVol24Usd / 1000)}k vol24 / identity required / ${cfg.midcapMinAgeHours}h+ old; ` +
      `conviction ≥${cfg.midcapMinConviction} buys ${cfg.midcapPct}% of spendable × conviction (floor ${cfg.midcapSol} SOL), max ${cfg.midcapMaxPerDay}/day; ` +
      `NO AUTO-EXITS — operator sells only` +
      (cfg.tradeDryRun ? " [DRY RUN]" : " [REAL SOL]"),
  );
}
