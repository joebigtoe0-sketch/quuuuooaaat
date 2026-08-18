import fs from "node:fs";
import bs58 from "bs58";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { getConnection } from "./solana.js";
import { log } from "../log.js";

// wallet.json convention shared with bondbot: { publicKey, secretKey: number[] }

let keypair: Keypair | null = null;

/** Parse a secret from any common export shape: base58 string (Phantom),
 *  JSON number array, or [n,n,...] as a string. */
function keypairFromSecret(raw: string): Keypair | null {
  const s = raw.trim();
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch {
    return null;
  }
}

export function loadWallet(): Keypair | null {
  if (keypair) return keypair;
  // PREFERRED for hosting (Railway etc.): the secret lives in an env var, never
  // on disk. Base58 (Phantom export) or a JSON number array both work.
  const envSecret = process.env.QUANT_WALLET_SECRET;
  if (envSecret) {
    const kp = keypairFromSecret(envSecret);
    if (kp) {
      keypair = kp;
      return keypair;
    }
    log.warn("wallet", "QUANT_WALLET_SECRET set but could not be parsed — falling back to wallet.json");
  }
  try {
    const j = JSON.parse(fs.readFileSync(cfg.walletFile, "utf8"));
    keypair = Keypair.fromSecretKey(Uint8Array.from(j.secretKey));
    return keypair;
  } catch {
    return null;
  }
}

export function walletPubkey(): PublicKey | null {
  return loadWallet()?.publicKey ?? null;
}

export function ensureWallet(): Keypair {
  const existing = loadWallet();
  if (existing) return existing;
  const kp = Keypair.generate();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(
    cfg.walletFile,
    JSON.stringify(
      { publicKey: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey), createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  log.info("wallet", `generated new Quant wallet: ${kp.publicKey.toBase58()}`);
  keypair = kp;
  return kp;
}

const metaCache = new Map<string, { symbol: string; image?: string }>();

/** Symbol + image for a mint, cached forever (metadata is immutable). */
export async function tokenDisplay(mint: string): Promise<{ symbol: string; image?: string }> {
  let m = metaCache.get(mint);
  if (!m) {
    const { getTokenMeta } = await import("./solana.js");
    const meta = await getTokenMeta(mint).catch(() => null);
    m = { symbol: meta?.symbol || mint.slice(0, 5), image: meta?.image ?? undefined };
    metaCache.set(mint, m);
  }
  return m;
}

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Every token the wallet actually holds (largest first). Queries BOTH the
 *  classic SPL and Token-2022 programs — $RIKU and newer pump.fun coins are
 *  Token-2022, so querying only the classic program hid them entirely. */
export async function walletHoldings(): Promise<{ mint: string; symbol: string; amount: number; image?: string }[]> {
  const pk = walletPubkey();
  if (!pk) return [];
  try {
    const conn = getConnection();
    const [classic, t2022] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM }, "confirmed"),
      conn.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM }, "confirmed").catch(() => ({ value: [] as any[] })),
    ]);
    const held = [...classic.value, ...t2022.value]
      .map((a) => {
        const info = (a.account.data as any)?.parsed?.info;
        return { mint: String(info?.mint ?? ""), amount: Number(info?.tokenAmount?.uiAmount ?? 0) };
      })
      .filter((h) => h.amount > 0 && h.mint)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 30);
    const out: { mint: string; symbol: string; amount: number; image?: string }[] = [];
    for (const h of held) {
      const d = await tokenDisplay(h.mint);
      out.push({ mint: h.mint, symbol: d.symbol, amount: h.amount, image: d.image });
    }
    return out;
  } catch {
    return [];
  }
}

export async function solBalance(): Promise<number> {
  const pk = walletPubkey();
  if (!pk) return 0;
  try {
    return (await getConnection().getBalance(pk, "confirmed")) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}
