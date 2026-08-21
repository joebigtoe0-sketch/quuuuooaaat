import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * DECISION RECORDS — the desk's append-only ledger, and the actor's ONLY
 * source of facts (PLAN-3LAYER.md, layer 1).
 *
 * Every real event (buy, sell, callout, verdict) is written here the moment it
 * happens, with the real numbers. The stage narrates records; it never authors
 * facts — which is the structural fix for the invented-$500 / 1000-followers /
 * $HRSEcn class of bug.
 *
 * Records for money/callout kinds are also PRE-COMMITTED on-chain: the
 * canonical JSON is sha256'd and written to Solana's memo program BEFORE
 * execution, then the full plaintext is published at /public/decisions. Anyone
 * can re-hash `canonical` and match it to the memo transaction — backdating is
 * impossible. (Idea studied from omotrades; verification made easier here by
 * publishing the exact canonical string.)
 */
export interface DecisionRecord {
  id: string;
  at: number;
  kind: "buy" | "sell" | "call" | "verdict";
  mint: string;
  symbol: string;
  entryMcUsd: number | null;
  sizeSol: number | null;
  tier: string | null;
  score: number | null;
  hardReject: string | null;
  reason: string;
  checks: { label: string; verdict: string; detail: string }[];
  // filled in around execution:
  canonical: string; // EXACT pre-execution string that was hashed
  commitHash: string | null; // sha256(canonical)
  commitSig: string | null; // solana memo tx signature
  txSig: string | null; // the fill, when there is one
  dry: boolean;
}

const FILE = () => path.join(cfg.dataDir, "decisions.jsonl");
let ring: DecisionRecord[] = [];
try {
  const lines = fs.readFileSync(FILE(), "utf8").trim().split("\n").slice(-500);
  ring = lines.map((l) => JSON.parse(l)).filter((r) => r && r.id);
} catch { /* first run */ }

function append(r: DecisionRecord): void {
  ring.push(r);
  if (ring.length > 500) ring = ring.slice(-500);
  try {
    fs.appendFileSync(FILE(), JSON.stringify(r) + "\n");
  } catch (e) {
    log.warn("desk", `record append failed: ${String(e).slice(0, 80)}`);
  }
}

/** Stable field order → deterministic string → verifiable hash. */
function canonicalize(r: Omit<DecisionRecord, "canonical" | "commitHash" | "commitSig" | "txSig">): string {
  return JSON.stringify({
    v: "riku:decision:v1",
    id: r.id,
    at: r.at,
    kind: r.kind,
    mint: r.mint,
    symbol: r.symbol,
    entryMcUsd: r.entryMcUsd,
    sizeSol: r.sizeSol,
    tier: r.tier,
    score: r.score,
    hardReject: r.hardReject,
    reason: r.reason,
    checks: r.checks.map((c) => ({ label: c.label, verdict: c.verdict, detail: c.detail })),
    dry: r.dry,
  });
}

const COMMIT_KINDS = new Set(
  (process.env.COMMIT_KINDS ?? "buy,sell,call").split(",").map((s) => s.trim()).filter(Boolean),
);

/**
 * Open a record BEFORE executing. Commits on-chain for money/call kinds (never
 * blocking — a dead RPC must not stop a buy), returns the record to execute
 * against. Call `sealDecision` with the outcome afterwards.
 */
export async function openDecision(
  input: Omit<DecisionRecord, "id" | "at" | "canonical" | "commitHash" | "commitSig" | "txSig">,
): Promise<DecisionRecord> {
  const base = { id: crypto.randomUUID(), at: Date.now(), ...input };
  const canonical = canonicalize(base);
  const commitHash = crypto.createHash("sha256").update(canonical).digest("hex");
  const rec: DecisionRecord = { ...base, canonical, commitHash, commitSig: null, txSig: null };
  if (cfg.commitOnchain && COMMIT_KINDS.has(rec.kind) && !rec.dry) {
    try {
      const { memoCommit } = await import("../chain/commit.js");
      rec.commitSig = await memoCommit(`riku:commit:v1:${commitHash}`);
      log.info("desk", `committed ${rec.kind} $${rec.symbol} → ${rec.commitSig?.slice(0, 16)}…`);
    } catch (e) {
      log.warn("desk", `commit failed (continuing uncommitted): ${String(e).slice(0, 100)}`);
    }
  }
  return rec;
}

/** Record the outcome and persist. */
export function sealDecision(rec: DecisionRecord, outcome: { txSig?: string | null; dry?: boolean }): DecisionRecord {
  if (outcome.txSig !== undefined) rec.txSig = outcome.txSig;
  if (outcome.dry !== undefined) rec.dry = outcome.dry;
  append(rec);
  return rec;
}

/** Convenience for events with no separate execution step (verdicts). */
export async function recordDecision(
  input: Omit<DecisionRecord, "id" | "at" | "canonical" | "commitHash" | "commitSig" | "txSig">,
): Promise<DecisionRecord> {
  const rec = await openDecision(input);
  return sealDecision(rec, {});
}

export function recentDecisions(n = 50, kind?: string): DecisionRecord[] {
  const rows = kind ? ring.filter((r) => r.kind === kind) : ring;
  return rows.slice(-n).reverse();
}
export function decisionsForMint(mint: string): DecisionRecord[] {
  return ring.filter((r) => r.mint === mint);
}
