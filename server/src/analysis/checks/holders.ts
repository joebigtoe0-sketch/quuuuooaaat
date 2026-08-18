import { PublicKey } from "@solana/web3.js";
import pumpSdk from "@pump-fun/pump-sdk";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "../../chain/solana.js";

const { bondingCurvePda, canonicalPumpPoolPda } = pumpSdk as any;

/**
 * Holder concentration from getTokenLargestAccounts (top 20).
 *
 * Pool/curve float is NOT a whale. Two layers of exclusion:
 *   1. known PDAs: the pump bonding curve ATA + canonical PumpSwap pool ATA
 *   2. any token account whose OWNER is off-curve (a program PDA) — this
 *      catches Raydium/Meteora vaults, migrated pools, lockers, etc.
 *      Human wallets are on-curve ed25519 keys.
 */
export interface HolderInfo {
  top1Pct: number;
  top10Pct: number;
  holderAddresses: string[]; // human-held token accounts, largest first
  amounts: number[]; // raw amounts aligned with holderAddresses
  owners: string[]; // owner wallets aligned with holderAddresses
}

const TOTAL_RAW = 1_000_000_000 * 1e6;

export async function fetchHolders(mint: PublicKey): Promise<HolderInfo | null> {
  try {
    const conn = getConnection();
    const largest = await conn.getTokenLargestAccounts(mint, "confirmed");
    const curveAta = getAssociatedTokenAddressSync(mint, bondingCurvePda(mint), true, TOKEN_PROGRAM_ID);
    const poolPda = canonicalPumpPoolPda(mint);
    const poolAta = getAssociatedTokenAddressSync(mint, poolPda, true, TOKEN_PROGRAM_ID);
    const knownPdas = new Set([curveAta.toBase58(), poolAta.toBase58()]);

    const accounts = largest.value
      .filter((a) => !knownPdas.has(a.address.toBase58()))
      .map((a) => ({ addr: a.address.toBase58(), raw: Number(a.amount) }))
      .filter((a) => a.raw > 0)
      .slice(0, 20);
    if (!accounts.length) return { top1Pct: 0, top10Pct: 0, holderAddresses: [], amounts: [], owners: [] };

    // resolve owners; drop accounts owned by off-curve addresses (pool vaults)
    const infos = await conn.getMultipleParsedAccounts(accounts.map((a) => new PublicKey(a.addr)));
    const holders: { addr: string; raw: number; owner: string }[] = [];
    for (let k = 0; k < accounts.length; k++) {
      const owner = (infos.value[k]?.data as any)?.parsed?.info?.owner as string | undefined;
      if (!owner) continue;
      let onCurve = true;
      try {
        onCurve = PublicKey.isOnCurve(new PublicKey(owner).toBytes());
      } catch {}
      if (!onCurve) continue; // program vault, not a person
      holders.push({ addr: accounts[k].addr, raw: accounts[k].raw, owner });
    }

    const top1Pct = holders.length ? (holders[0].raw / TOTAL_RAW) * 100 : 0;
    const top10Pct = (holders.slice(0, 10).reduce((s, a) => s + a.raw, 0) / TOTAL_RAW) * 100;
    return {
      top1Pct,
      top10Pct,
      holderAddresses: holders.map((h) => h.addr),
      amounts: holders.map((h) => h.raw),
      owners: holders.map((h) => h.owner),
    };
  } catch {
    return null;
  }
}
