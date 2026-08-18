import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { fetch as undiciFetch, Agent } from "undici";
import { cfg } from "../config.js";

// Vendored from tggroupbuybot/src/solana.ts. Throttled, pooled, with a public
// fallback RPC so the show survives a Helius outage.

let _connection: Connection | null = null;

const MIN_RPC_GAP_MS = 110;
let nextRpcSlot = 0;
function throttleSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRpcSlot);
  nextRpcSlot = at + MIN_RPC_GAP_MS;
  return new Promise((r) => setTimeout(r, at - now));
}

const rpcAgent = new Agent({
  connect: { timeout: 20_000 },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  connections: 6,
});

const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
let primaryFailStreak = 0;

async function rpcFetch(input: any, init: any): Promise<any> {
  try {
    const res = await undiciFetch(input, { ...init, dispatcher: rpcAgent });
    primaryFailStreak = 0;
    return res;
  } catch (e) {
    primaryFailStreak++;
    if (primaryFailStreak === 5) console.warn("[rpc] primary unreachable — using public fallback");
    return await undiciFetch(FALLBACK_RPC, { ...init, dispatcher: rpcAgent });
  }
}

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(cfg.rpcUrl, {
      commitment: "confirmed",
      fetch: rpcFetch as any,
      fetchMiddleware: (info, init, fetch) => {
        void throttleSlot().then(() => fetch(info, init));
      },
    });
  }
  return _connection;
}

export async function sendIxs(
  ixs: TransactionInstruction[],
  payer: Keypair,
  priorityFeeMicroLamports = 150_000,
): Promise<string> {
  const connection = getConnection();
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...ixs,
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: all,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)} (${sig})`);
  }
  return sig;
}

// ---------- SOL/USD ----------
let solUsdCache: { price: number; ts: number } | null = null;

export async function getSolUsd(): Promise<number> {
  if (solUsdCache && Date.now() - solUsdCache.ts < 60_000) return solUsdCache.price;
  const sol = "So11111111111111111111111111111111111111112";
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${sol}`);
    if (r.ok) {
      const j: any = await r.json();
      const p = j?.[sol]?.usdPrice;
      if (typeof p === "number" && p > 0) {
        solUsdCache = { price: p, ts: Date.now() };
        return p;
      }
    }
  } catch {}
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (r.ok) {
      const j: any = await r.json();
      const p = j?.solana?.usd;
      if (typeof p === "number" && p > 0) {
        solUsdCache = { price: p, ts: Date.now() };
        return p;
      }
    }
  } catch {}
  return solUsdCache?.price ?? 0;
}

// ---------- Token metadata via Helius DAS ----------
const metaCache = new Map<string, { symbol: string; name: string; image?: string }>();

export async function getTokenMeta(
  mint: string,
): Promise<{ symbol: string; name: string; image?: string }> {
  const cached = metaCache.get(mint);
  if (cached) return cached;
  try {
    const r = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "meta", method: "getAsset", params: { id: mint } }),
    });
    const j: any = await r.json();
    const meta = j?.result?.content?.metadata;
    const image = j?.result?.content?.links?.image;
    const symbol = (meta?.symbol ?? "").trim() || mint.slice(0, 4);
    const name = (meta?.name ?? "").trim() || symbol;
    const out = { symbol, name, image };
    metaCache.set(mint, out);
    return out;
  } catch {
    return { symbol: mint.slice(0, 4), name: mint.slice(0, 8) };
  }
}

/** Who sent us this mint? Walk recent wallet signatures; the tx whose
 *  postTokenBalances credit our wallet with the mint names the sender
 *  (fee payer). Best effort — the show says "anon" when unknown. */
export async function findSender(owner: PublicKey, mint: string): Promise<string | null> {
  const connection = getConnection();
  try {
    const sigs = await connection.getSignaturesForAddress(owner, { limit: 15 }, "confirmed");
    for (const s of sigs) {
      const tx = await connection.getParsedTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;
      const gained =
        (tx.meta.postTokenBalances ?? []).some(
          (b) => b.owner === owner.toBase58() && b.mint === mint,
        ) &&
        !(tx.meta.preTokenBalances ?? []).some(
          (b) =>
            b.owner === owner.toBase58() &&
            b.mint === mint &&
            BigInt(b.uiTokenAmount.amount) > 0n,
        );
      if (gained) {
        const feePayer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
        if (feePayer && !feePayer.equals(owner)) return feePayer.toBase58();
      }
    }
  } catch {}
  return null;
}
