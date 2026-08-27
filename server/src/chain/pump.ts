import { AccountInfo, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
// These packages ship a broken ESM exports map: only `default` is a real
// runtime export, so we destructure values off the default and keep the
// interfaces as erased type-only imports.
import pumpSdk from "@pump-fun/pump-sdk";
import pumpSwapSdk from "@pump-fun/pump-swap-sdk";
import type { Global, FeeConfig, BondingCurve } from "@pump-fun/pump-sdk";
import type { Pool } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT, AccountLayout, MintLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { RawMint } from "@solana/spl-token";
import { getConnection, sendIxs } from "./solana.js";

const {
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount,
  bondingCurveMarketCap,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
} = pumpSdk as any;
const { PUMP_AMM_SDK, OnlinePumpAmmSdk } = pumpSwapSdk as any;

// Vendored from tggroupbuybot/src/pump.ts.
// THE INVARIANT: Quant NEVER sells its OWN token — executeSell hard-throws on
// cfg.ownMint. Trading positions in other tokens may be sold (agent v2).

const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY_UI = 1_000_000_000;

/** Bonding progress (0..1) for MANY mints in a few RPC calls — one
 *  getMultipleAccountsInfo per 100 curve PDAs. complete curves report 1.
 *  Mints with no curve account (not pump / not indexed) are absent. */
export async function curveProgressBatch(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const conn = getConnection();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    let infos: (AccountInfo<Buffer> | null)[] = [];
    try {
      infos = await conn.getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(new PublicKey(m))));
    } catch {
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (!info) continue;
      try {
        const bc = PUMP_SDK.decodeBondingCurveNullable(info) as BondingCurve | null;
        if (!bc) continue;
        if (bc.complete) { out.set(chunk[j], 1); continue; }
        const realQuote = Number(bc.realQuoteReserves.toString()) / LAMPORTS_PER_SOL;
        out.set(chunk[j], Math.min(1, realQuote / 85));
      } catch {}
    }
  }
  return out;
}

export type TokenState =
  | {
      kind: "curve";
      bondingCurve: BondingCurve;
      accountInfo: AccountInfo<Buffer>;
      priceSol: number;
      mcSol: number;
      mayhem: boolean;
      cashback: boolean;
      progress: number; // 0..1 of real quote raised toward graduation
    }
  | {
      kind: "amm";
      poolKey: PublicKey;
      pool: Pool;
      priceSol: number;
      mcSol: number;
      /** raw pool token-account balances — the sell quote prices off these */
      baseReserveRaw: bigint;
      quoteReserveRaw: bigint;
    }
  | { kind: "none" }
  | { kind: "unsupported"; why: string };

let onlinePump: any = null;
function pumpOnline(): any {
  if (!onlinePump) onlinePump = new OnlinePumpSdk(getConnection());
  return onlinePump;
}
let onlineAmm: any = null;
function ammOnline(): any {
  if (!onlineAmm) onlineAmm = new OnlinePumpAmmSdk(getConnection());
  return onlineAmm;
}

let globalCache: { global: Global; feeConfig: FeeConfig; ts: number } | null = null;
async function getGlobals(): Promise<{ global: Global; feeConfig: FeeConfig }> {
  if (globalCache && Date.now() - globalCache.ts < 10 * 60_000) return globalCache;
  const [global, feeConfig] = await Promise.all([
    pumpOnline().fetchGlobal(),
    pumpOnline().fetchFeeConfig(),
  ]);
  globalCache = { global, feeConfig, ts: Date.now() };
  return globalCache;
}

let ammGlobalCache: { globalConfig: any; feeConfig: any; ts: number } | null = null;
async function getAmmGlobals(): Promise<{ globalConfig: any; feeConfig: any }> {
  if (ammGlobalCache && Date.now() - ammGlobalCache.ts < 10 * 60_000) return ammGlobalCache;
  const [globalConfig, feeConfig] = await Promise.all([
    ammOnline().fetchGlobalConfigAccount(),
    ammOnline().fetchFeeConfigAccount(),
  ]);
  ammGlobalCache = { globalConfig, feeConfig, ts: Date.now() };
  return ammGlobalCache;
}

/** Decoded mint account — the AMM quote math needs it. Supply and decimals are
 *  fixed for a pump mint, so this caches for the life of the process. */
const mintAccountCache = new Map<string, RawMint>();
async function getMintAccount(mint: PublicKey): Promise<RawMint> {
  const key = mint.toBase58();
  const hit = mintAccountCache.get(key);
  if (hit) return hit;
  const info = await getConnection().getAccountInfo(mint);
  if (!info) throw new Error("mint account not found");
  const decoded = MintLayout.decode(info.data);
  mintAccountCache.set(key, decoded);
  return decoded;
}

const mintTokenProgramCache = new Map<string, PublicKey>();
async function getMintTokenProgram(mint: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = mintTokenProgramCache.get(key);
  if (cached) return cached;
  const info = await getConnection().getAccountInfo(mint);
  const program = info?.owner ?? TOKEN_PROGRAM_ID;
  mintTokenProgramCache.set(key, program);
  return program;
}

function isSolQuote(quoteMint: PublicKey): boolean {
  return quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default);
}

export async function getTokenState(mint: PublicKey): Promise<TokenState> {
  const connection = getConnection();
  const curvePda = bondingCurvePda(mint);
  const poolKey = canonicalPumpPoolPda(mint);
  const [curveInfo, poolInfo] = await connection.getMultipleAccountsInfo([curvePda, poolKey]);

  if (curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID) && curveInfo.data.length > 8) {
    let bc: BondingCurve | null = null;
    try {
      bc = PUMP_SDK.decodeBondingCurveNullable(curveInfo);
    } catch {}
    if (bc && !bc.complete) {
      if (!isSolQuote(bc.quoteMint)) return { kind: "unsupported", why: "non-SOL quote token" };
      const vQuote = Number(bc.virtualQuoteReserves.toString());
      const vToken = Number(bc.virtualTokenReserves.toString());
      if (vToken <= 0) return { kind: "unsupported", why: "empty curve" };
      const priceSol = vQuote / LAMPORTS_PER_SOL / (vToken / 10 ** TOKEN_DECIMALS);
      const mcSol =
        Number(
          bondingCurveMarketCap({
            mintSupply: bc.tokenTotalSupply,
            virtualQuoteReserves: bc.virtualQuoteReserves,
            virtualTokenReserves: bc.virtualTokenReserves,
          }).toString(),
        ) / LAMPORTS_PER_SOL;
      const realQuote = Number(bc.realQuoteReserves.toString()) / LAMPORTS_PER_SOL;
      return {
        kind: "curve",
        bondingCurve: bc,
        accountInfo: curveInfo,
        priceSol,
        mcSol,
        mayhem: Boolean((bc as any).isMayhemMode),
        cashback: Boolean((bc as any).isCashbackCoin),
        progress: Math.min(1, realQuote / 85),
      };
    }
  }

  if (poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    let pool: Pool | null = null;
    try {
      pool = PUMP_AMM_SDK.decodePoolNullable(poolInfo);
    } catch {}
    if (pool) {
      if (!pool.quoteMint.equals(NATIVE_MINT)) return { kind: "unsupported", why: "non-SOL quote pool" };
      const [baseAcc, quoteAcc] = await connection.getMultipleAccountsInfo([
        pool.poolBaseTokenAccount,
        pool.poolQuoteTokenAccount,
      ]);
      if (!baseAcc || !quoteAcc) return { kind: "unsupported", why: "pool token accounts missing" };
      const baseReserveRaw = AccountLayout.decode(baseAcc.data).amount;
      const quoteReserveRaw = AccountLayout.decode(quoteAcc.data).amount;
      const baseUi = Number(baseReserveRaw) / 10 ** TOKEN_DECIMALS;
      const quoteUi = Number(quoteReserveRaw) / LAMPORTS_PER_SOL;
      if (baseUi <= 0) return { kind: "unsupported", why: "empty pool" };
      // A PumpSwap pool prices off quote + VIRTUAL quote reserves. Pricing off
      // the bare token-account ratio under-reads by however large the virtual
      // leg is relative to the real one — 8% on a deep pool, 40-69% on a thin
      // freshly-graduated one. $Fiveish (2026-08-27): read -40%, tripped the
      // caller-follow stop on a position that was actually down 5%, and the
      // 0.3 SOL round trip realised -7.2% for nothing.
      const virtualQuoteUi = Number(pool.virtualQuoteReserves?.toString() ?? "0") / LAMPORTS_PER_SOL;
      const priceSol = (quoteUi + virtualQuoteUi) / baseUi;
      return {
        kind: "amm", poolKey, pool, priceSol, mcSol: priceSol * TOTAL_SUPPLY_UI,
        baseReserveRaw, quoteReserveRaw,
      };
    }
  }

  return { kind: "none" };
}

export async function getTokenAgeMinutes(mint: PublicKey): Promise<number | null> {
  const connection = getConnection();
  let before: string | undefined;
  let oldest: number | null = null;
  for (let page = 0; page < 3; page++) {
    const sigs = await connection.getSignaturesForAddress(mint, { before, limit: 1000 }, "confirmed");
    if (sigs.length === 0) break;
    const last = sigs[sigs.length - 1];
    if (last.blockTime) oldest = last.blockTime;
    if (sigs.length < 1000) break;
    before = last.signature;
  }
  return oldest === null ? null : (Date.now() / 1000 - oldest) / 60;
}

export async function getTokenBalanceRaw(mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    const tokenProgram = await getMintTokenProgram(mint);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    const bal = await getConnection().getTokenAccountBalance(ata, "confirmed");
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

/** Estimated SOL received selling `tokensRaw` right now (curve fees exact, AMM ~1%). */
export async function estimateSellSolFor(mint: PublicKey, tokensRaw: bigint): Promise<number> {
  if (tokensRaw <= 0n) return 0;
  const state = await getTokenState(mint);
  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const out = (pumpSdk as any).getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: new BN(tokensRaw.toString()),
    });
    return Number(out.toString()) / LAMPORTS_PER_SOL;
  }
  if (state.kind === "amm") {
    // quote the ACTUAL swap through the SDK — real fees, real price impact,
    // real virtual reserves. The old `tokens x priceSol x 0.99` was a mid-price
    // guess on top of a mid price that was itself wrong (see getTokenState).
    try {
      const { globalConfig, feeConfig } = await getAmmGlobals();
      const out = (pumpSwapSdk as any).sellBaseInput({
        base: new BN(tokensRaw.toString()),
        slippage: 0, // uiQuote is the expected fill; slippage only shapes minQuote
        baseReserve: new BN(state.baseReserveRaw.toString()),
        quoteReserve: new BN(state.quoteReserveRaw.toString()),
        virtualQuoteReserves: (state.pool as any).virtualQuoteReserves,
        globalConfig,
        baseMintAccount: await getMintAccount(mint),
        baseMint: mint,
        coinCreator: (state.pool as any).coinCreator,
        creator: (state.pool as any).creator,
        feeConfig,
      });
      const sol = Number(out.uiQuote.toString()) / LAMPORTS_PER_SOL;
      if (Number.isFinite(sol) && sol > 0) return sol;
    } catch { /* fall through to the mid-price estimate below */ }
    // fallback: mid price (now corrected for virtual reserves) minus a fee
    // haircut. Ignores price impact, so only honest for small bags — but it is
    // the right side to fail on: a stop must never fire on a phantom loss.
    return (Number(tokensRaw) / 10 ** TOKEN_DECIMALS) * state.priceSol * 0.99;
  }
  return 0;
}

/** Buy `solAmount` of `mint` (curve or AMM). Own-token buybacks + agent trades. */
export async function executeBuy(
  payer: Keypair,
  mint: PublicKey,
  solAmount: number,
  slippagePct = 15,
  priorityFeeMicroLamports = 150_000,
): Promise<{ sig: string; mcSol: number }> {
  const state = await getTokenState(mint);
  if (state.kind === "none") throw new Error("token not found on pump.fun or PumpSwap");
  if (state.kind === "unsupported") throw new Error(`token unsupported: ${state.why}`);

  const lamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
  const user = payer.publicKey;
  let ixs;

  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const tokenProgram = await getMintTokenProgram(mint);
    const buyState = await pumpOnline().fetchBuyState(mint, user, tokenProgram);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: lamports,
      quoteMint: NATIVE_MINT,
    });
    if (amount.lten(0)) throw new Error("buy quote returned 0 tokens");
    ixs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint,
      user,
      amount,
      solAmount: lamports,
      slippage: slippagePct,
      tokenProgram,
    });
  } else {
    const swapState = await ammOnline().swapSolanaState(state.poolKey, user);
    ixs = await PUMP_AMM_SDK.buyQuoteInput(swapState, lamports, slippagePct);
  }

  const sig = await sendIxs(ixs, payer, priorityFeeMicroLamports);
  return { sig, mcSol: state.mcSol };
}

/** Sell `tokensRaw` of `mint`. HARD-BLOCKED for Quant's own token — the
 *  never-sell brand is enforced at the lowest level, not by prompt. */
export async function executeSell(
  payer: Keypair,
  mint: PublicKey,
  tokensRaw: bigint,
  slippagePct = 15,
  priorityFeeMicroLamports = 150_000,
): Promise<{ sig: string; mcSol: number; solReceived: number }> {
  const { cfg } = await import("../config.js");
  if (cfg.ownMint && mint.toBase58() === cfg.ownMint) {
    throw new Error("REFUSED: Quant never sells its own token");
  }
  if (tokensRaw <= 0n) throw new Error("nothing to sell");
  const state = await getTokenState(mint);
  if (state.kind === "none") throw new Error("token not found");
  if (state.kind === "unsupported") throw new Error(`unsupported: ${state.why}`);

  const user = payer.publicKey;
  const amount = new BN(tokensRaw.toString());
  let ixs;
  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const tokenProgram = await getMintTokenProgram(mint);
    const sellState = await pumpOnline().fetchSellState(mint, user, tokenProgram);
    const solAmount = (pumpSdk as any).getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    ixs = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram,
      mayhemMode: sellState.bondingCurve.isMayhemMode,
      cashback: sellState.bondingCurve.isCashbackCoin,
    });
  } else {
    const swapState = await ammOnline().swapSolanaState(state.poolKey, user);
    ixs = await PUMP_AMM_SDK.sellBaseInput(swapState, amount, slippagePct);
  }
  const balBefore = await getConnection().getBalance(user, "confirmed");
  const sig = await sendIxs(ixs, payer, priorityFeeMicroLamports);
  // Proceeds from the TX META, not a balance diff — the before/after balance
  // read raced the RPC and recorded 0 SOL on real fills, which the books then
  // counted as a -100% loss on a -40% stop. The tx's own pre/post balances
  // are exact regardless of timing; the balance diff stays as the fallback.
  let solReceived = 0;
  for (let i = 0; i < 6 && solReceived <= 0; i++) {
    try {
      const tx = await getConnection().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (tx?.meta) {
        const keys = tx.transaction.message.getAccountKeys();
        let idx = 0; // payer is the fee payer — index 0 — but verify when possible
        for (let k = 0; k < keys.staticAccountKeys.length; k++) {
          if (keys.staticAccountKeys[k].equals(user)) { idx = k; break; }
        }
        solReceived = Math.max(0, (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL);
        break;
      }
    } catch { /* not indexed yet — retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (solReceived <= 0) {
    const balAfter = await getConnection().getBalance(user, "confirmed");
    solReceived = Math.max(0, (balAfter - balBefore) / LAMPORTS_PER_SOL);
  }
  return { sig, mcSol: state.mcSol, solReceived };
}
