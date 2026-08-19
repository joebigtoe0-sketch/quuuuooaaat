import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * THE FACT SHEET — settled truths RIKU answers from (tokenomics, the bubble-map
 * question, how submissions work). Lives at data/facts.md, seeded from
 * server/seed/facts.md and editable LIVE from /admin (no deploy, no restart).
 * Injected into every prompt where he ANSWERS people: chat, X replies, tweets.
 */
const FILE = () => path.join(cfg.dataDir, "facts.md");
let cache = "";
let loadedAt = 0;

export function factSheet(): string {
  // re-read at most every 20s so an admin edit lands almost immediately
  if (Date.now() - loadedAt > 20_000) {
    try {
      cache = fs.readFileSync(FILE(), "utf8");
    } catch {
      cache = "";
    }
    loadedAt = Date.now();
  }
  return cache;
}

/** Trimmed for prompt injection — the sheet is the source of truth, but a beat
 *  prompt shouldn't carry 4KB of it. */
export function factsFor(maxChars = 1600): string {
  const s = factSheet().trim();
  if (!s) return "";
  return `YOUR FACT SHEET — settled truths. If a question touches any of these, answer from here (in your voice, never quoted verbatim) and never contradict it:\n${s.slice(0, maxChars)}`;
}

export function saveFacts(text: string): void {
  fs.writeFileSync(FILE(), text);
  cache = text;
  loadedAt = Date.now();
  log.info("facts", `fact sheet updated (${text.length} chars)`);
}

export function appendFact(line: string): void {
  const cur = factSheet();
  saveFacts(`${cur.trimEnd()}\n- ${line.trim()}\n`);
}
