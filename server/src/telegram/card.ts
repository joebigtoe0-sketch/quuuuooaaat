import type { Analysis } from "../analysis/engine.js";

/**
 * The token card. Tree-drawn like the caller bots people already read, because
 * a card nobody can scan at a glance is a card nobody reads — the first version
 * of this was four flat lines and looked like a debug dump next to Phanes.
 *
 * Everything here comes from data we already fetch. Nothing is invented: if a
 * signal cannot be sourced honestly it is omitted rather than guessed, which is
 * why there is no "Sniper" row — first-N-seconds buyer attribution is not
 * something this codebase measures, and a wrong number is worse than no row.
 */

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/** 1B supply x 6 decimals — the same constant holders.ts scores against */
const TOTAL_RAW = 1_000_000_000 * 1e6;

/** $0.00001798 -> $0.0₄1798, the notation every trench card uses. */
export function price(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return "?";
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.001) return `$${p.toFixed(5)}`;
  const s = p.toFixed(20);
  const dec = s.slice(s.indexOf(".") + 1);
  let zeros = 0;
  while (zeros < dec.length && dec[zeros] === "0") zeros++;
  const digits = dec.slice(zeros, zeros + 4).replace(/0+$/, "") || "0";
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `$0.0${sub}${digits}`;
}

export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(n > -10 && n < 10 ? 1 : 0)}%`;

export const age = (min: number | null | undefined): string => {
  if (min == null || !Number.isFinite(min)) return "?";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(min < 600 ? 1 : 0)}h`;
  return `${(min / 1440).toFixed(1)}d`;
};

export const ago = (at: number): string => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

export const esc = (s: string): string =>
  String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

const a = (label: string, url: string): string => `<a href="${url}">${label}</a>`;

export interface CardExtras {
  /** all-time-high market cap and when it printed, from the candle tape */
  ath?: { mcUsd: number; at: number } | null;
  /** distinct graded pump.fun callers on this mint, from riku's own index */
  pumpCallers?: number;
  /** the call footer */
  caller?: { name: string; mcUsd: number | null; first: boolean; priorName?: string; priorAt?: number };
  /** set when the coin is below the scoring floor */
  belowFloor?: boolean;
}

export function renderCard(an: Analysis, x: CardExtras = {}): { text: string; headerUrl: string | null } {
  const d = an.dexStats;
  const mint = an.mint;
  const mc = d?.mcUsd ?? (an.state.kind === "curve" || an.state.kind === "amm" ? an.state.mcSol * an.solUsd : null);
  const L: string[] = [];

  // ---- head ----
  const venue =
    an.state.kind === "curve"
      ? `💊 Pump @ ${(an.state.progress * 100).toFixed(0)}%`
      : an.state.kind === "amm"
        ? "🌊 PumpSwap"
        : "❓";
  L.push(`🪙 <b>${esc(an.name)}</b> ($${esc(an.symbol)})`);
  L.push(` └ ${venue} | 🌱 ${age(an.ageMin)}` + (x.pumpCallers ? ` | 📣 ${x.pumpCallers} pump callers` : ""));

  // ---- stats ----
  L.push("");
  L.push("📊 <b>Stats</b>");
  L.push(` ├ USD   ${price(d?.priceUsd)} <i>(${pct(d?.chg24Pct)} 24h)</i>`);
  L.push(` ├ MC    ${money(mc)}`);
  L.push(` ├ Vol   ${money(d?.vol24Usd)}`);
  // dexscreener omits liquidity on some pairs; we are already holding the
  // reserves, so fall back to them rather than printing "?"
  const lp =
    d?.liqUsd ??
    (an.state.kind === "curve"
      ? (Number(an.state.bondingCurve.realQuoteReserves.toString()) / 1e9) * an.solUsd * 2
      : an.state.kind === "amm"
        ? (Number(an.state.quoteReserveRaw) / 1e9) * an.solUsd * 2
        : null);
  L.push(` ├ LP    ${money(lp)}`);
  L.push(` ├ Sup   1B/1B`);
  const b = d?.buys1h ?? null;
  const s = d?.sells1h ?? null;
  L.push(` ├ 1H    ${pct(d?.chg1hPct)}` + (b != null || s != null ? `  🅑${b ?? 0} Ⓢ${s ?? 0}` : ""));
  if (x.ath) {
    const off = mc ? ((mc - x.ath.mcUsd) / x.ath.mcUsd) * 100 : null;
    L.push(` └ ATH   ${money(x.ath.mcUsd)} <i>(${pct(off)} / ${ago(x.ath.at)} ago)</i>`);
  } else {
    L.push(` └ ATH   —`);
  }

  // ---- socials ----
  const links: string[] = [];
  for (const so of d?.socials ?? []) {
    const t = (so.type ?? "").toLowerCase();
    links.push(a(t === "twitter" ? "𝕏" : t === "telegram" ? "TG" : t || "link", so.url));
  }
  for (const w of d?.websites ?? []) links.push(a(w.label || "Web", w.url));
  if (links.length) {
    L.push("");
    L.push("🔗 <b>Socials</b>");
    L.push(` └ ${links.join(" • ")}`);
  }

  // ---- security ----
  L.push("");
  L.push("🔒 <b>Security</b>");
  const bub = an.bubble;
  if (bub?.checked && bub.topChecked > 0)
    L.push(` ├ Fresh     ${((bub.freshTop / bub.topChecked) * 100).toFixed(0)}% <i>(${bub.freshTop}/${bub.topChecked} top)</i>`);
  if (an.holders) {
    L.push(` ├ Top 10    ${an.holders.top10Pct.toFixed(0)}%  <i>(top1 ${an.holders.top1Pct.toFixed(0)}%)</i>`);
    // individual top holders, each linked to solscan — the row people actually click
    const th = an.holders.owners.slice(0, 5).map((o, i) => {
      const share = (an.holders!.amounts[i] / TOTAL_RAW) * 100;
      return a(share.toFixed(1), `https://solscan.io/account/${o}`);
    });
    if (th.length) L.push(` ├ TH        ${th.join("|")}`);
  }
  if (bub?.checked && bub.clusterMax > 1)
    L.push(` ├ Cluster   ${bub.clusterMax} wallets <i>(${bub.clusterSharePct.toFixed(1)}%)</i>`);
  L.push(
    ` ├ Dev       ` +
      (an.dev?.known
        ? `${an.dev.launches} launches, ${an.dev.bonds} bonded <i>(${(an.dev.bondRate * 100).toFixed(0)}%)</i>`
        : "first launch seen"),
  );
  L.push(` └ DEX Paid  ${an.dexPaid === true ? "🟢" : an.dexPaid === false ? "🔴" : "⚪"}`);

  // ---- link rails ----
  const pair = d?.pairAddress;
  L.push("");
  L.push(
    [
      a("DS", pair ? `https://dexscreener.com/solana/${pair}` : `https://dexscreener.com/solana/${mint}`),
      a("GT", `https://www.geckoterminal.com/solana/pools/${mint}`),
      a("PUMP", `https://pump.fun/coin/${mint}`),
      a("EXP", `https://solscan.io/token/${mint}`),
      a("𝕏s", `https://x.com/search?f=live&q=${encodeURIComponent(`($${an.symbol} OR ${mint})`)}`),
    ].join(" • "),
  );
  L.push(
    [
      a("AXI", `https://axiom.trade/t/${mint}`),
      a("GMGN", `https://gmgn.ai/sol/token/${mint}`),
      a("PHO", `https://photon-sol.tinyastro.io/en/lp/${mint}`),
      a("BULLX", `https://bullx.io/terminal?chainId=1399811149&address=${mint}`),
      a("TRO", `https://t.me/menelaus_trojanbot?start=d-${mint}`),
      a("BLO", `https://t.me/BloomSolana_bot?start=ca_${mint}`),
    ].join(" • "),
  );

  // ---- the CA, tap-to-copy ----
  L.push("");
  L.push(`<code>${mint}</code>`);

  // ---- the call ----
  if (x.caller) {
    L.push("");
    if (x.belowFloor) {
      L.push(`⚠️ <b>Below the scoring floor</b> — carded, not scored.`);
    } else if (x.caller.first) {
      L.push(`✅ <b>${esc(x.caller.name)}</b> called it first @ ${money(x.caller.mcUsd)}`);
    } else {
      L.push(
        `↩️ ${esc(x.caller.name)} — already called by <b>${esc(x.caller.priorName ?? "?")}</b> ${ago(x.caller.priorAt ?? Date.now())} ago. No global score.`,
      );
    }
  }

  return { text: L.join("\n"), headerUrl: d?.headerUrl ?? null };
}
