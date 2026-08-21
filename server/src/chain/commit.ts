import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { loadWallet } from "./wallet.js";
import { sendIxs } from "./solana.js";

/**
 * On-chain pre-commitment: write `riku:commit:v1:{sha256}` to Solana's memo
 * program BEFORE a decision executes. Zero lamports moved — the tx exists only
 * to timestamp the hash. Anyone can later re-hash the revealed canonical
 * record from /public/decisions and match it against this memo, which makes
 * backdating a call impossible.
 */
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export async function memoCommit(text: string): Promise<string> {
  const wallet = loadWallet();
  if (!wallet) throw new Error("no wallet");
  const ix = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(text.slice(0, 500), "utf8"),
  });
  // low priority fee — a commitment is not latency-sensitive
  return sendIxs([ix], wallet, 1_000);
}
