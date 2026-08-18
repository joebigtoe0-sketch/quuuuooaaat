import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { getConnection, sendIxs } from "./solana.js";
import { ensureWallet } from "./wallet.js";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * Real on-chain airdrop: split `amountUi` of his own token among the current
 * top holders, weighted by their bags. Exclusions keep it honest:
 *  - his own wallet (no self-dealing)
 *  - any PDA owner (bonding curve / AMM pool vaults are off-curve addresses)
 *  - dust shares under 1k tokens (not worth the ATA rent)
 * Batched 5 recipients per tx. Pump tokens are 6 decimals.
 */
export async function executeAirdrop(
  amountUi: number,
): Promise<{ ok: boolean; sent: number; recipients: number; sigs: string[]; why?: string }> {
  const out: { ok: boolean; sent: number; recipients: number; sigs: string[]; why?: string } =
    { ok: false, sent: 0, recipients: 0, sigs: [] };
  if (!cfg.ownMint) return { ...out, why: "no own mint set" };
  const conn = getConnection();
  const payer = ensureWallet();
  const mint = new PublicKey(cfg.ownMint);

  // top token accounts for the mint (up to 20), then resolve their owners
  const largest = await conn.getTokenLargestAccounts(mint, "confirmed");
  const accounts = largest.value.filter((a) => (a.uiAmount ?? 0) > 0);
  if (!accounts.length) return { ...out, why: "no holders found" };
  const infos = await conn.getMultipleParsedAccounts(accounts.map((a) => a.address), { commitment: "confirmed" });

  const holders: { owner: PublicKey; bag: number }[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const parsed: any = infos.value[i]?.data;
    const ownerStr = parsed?.parsed?.info?.owner;
    if (!ownerStr) continue;
    const owner = new PublicKey(ownerStr);
    if (owner.equals(payer.publicKey)) continue; // never himself
    if (!PublicKey.isOnCurve(owner.toBytes())) continue; // curve/pool vaults
    holders.push({ owner, bag: accounts[i].uiAmount ?? 0 });
  }
  if (!holders.length) return { ...out, why: "no eligible holders (only vaults + himself)" };

  const totalBag = holders.reduce((a, h) => a + h.bag, 0);
  const shares = holders
    .map((h) => ({ owner: h.owner, tokens: Math.floor(amountUi * (h.bag / totalBag)) }))
    .filter((s) => s.tokens >= 1000);
  if (!shares.length) return { ...out, why: "all shares under the 1k-token dust floor" };

  const srcAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  for (let i = 0; i < shares.length; i += 5) {
    const batch = shares.slice(i, i + 5);
    const ixs = batch.flatMap((s) => {
      const dstAta = getAssociatedTokenAddressSync(mint, s.owner);
      return [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dstAta, s.owner, mint),
        createTransferInstruction(srcAta, dstAta, payer.publicKey, BigInt(s.tokens) * 1_000_000n),
      ];
    });
    try {
      const sig = await sendIxs(ixs, payer, 150_000);
      out.sigs.push(sig);
      out.sent += batch.reduce((a, s) => a + s.tokens, 0);
      out.recipients += batch.length;
    } catch (e) {
      log.warn("airdrop", `batch ${i / 5 + 1} failed: ${String(e).slice(0, 120)}`);
    }
  }
  out.ok = out.recipients > 0;
  if (!out.ok) out.why = "every transfer batch failed";
  return out;
}
