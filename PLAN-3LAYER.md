# THE THREE-LAYER REBUILD

Not a rewrite. A separation of jobs that mostly already exist but are currently
tangled together — which is what causes the recurring bugs.

## Why

Today **the actor sometimes decides**, and nearly every bug this week traces to
that single fact:

| Symptom | Root cause |
|---|---|
| "hit 1000 followers" at 142; "$500" on an $8 buy; "$HRSEcn" for $BULLMOOSE | the narrator was asked for facts it didn't have, so it invented them |
| snipes too slow → the sniper bypasses the beat system entirely | decisions were queued behind theatre |
| camera stranded on the terminal; "editorial passed on that one" | a narration failure took down the show |
| refusal filter, meta filter, cashtag filter, self-facts block | four patches, all for "the narrator was free to make something up" |

Each was fixed individually. The category keeps coming back because the
architecture allows it.

**Design principle: the actor narrates records. It never authors facts.**

## The layers

### 1. THE DESK — backstage, fast, mostly code
Screening, scoring, gating, sizing, execution, exits. No LLM in the hot path.
Runs on its own clock, independent of the show.

Already exists, scattered: `analysis/score.ts` (tiers + hard rejects),
`chain/trader.ts` (rails), `agent/tokenguard.ts` (desk book), `agent/devsniper.ts`
(fast path). The work is consolidating it behind one interface and letting it
run without waiting for a beat.

**Every decision emits a DECISION RECORD:**

```ts
interface DecisionRecord {
  id: string;                 // uuid
  at: number;
  kind: "buy" | "sell" | "call" | "verdict" | "pass" | "blacklist";
  mint: string;
  symbol: string;             // the REAL ticker, resolved — never a mint slice
  entryMcUsd: number | null;
  sizeSol: number | null;
  tier: string | null;
  score: number | null;
  checks: { label: string; verdict: string; detail: string }[];
  hardReject: string | null;
  reason: string;
  txSig: string | null;
  commitHash: string | null;  // see layer 4
}
```

Persisted, append-only. This is the show's source of truth **and** the track
record's — replacing the current situation where the callout ledger drifts from
reality and needs hand-correcting.

### 2. THE PRODUCER — outside, strong model
Judgment and public words. **Already built** — `PRODUCER.md`, `/admin/producer-state`,
`tweet-exact`, `reply-exact`, `planner?on=0`, `autoreply?on=0`.

Reads state, decides what's worth doing, writes the words. Optional: when it's
away, the desk and timer beats keep running.

### 3. THE ACTOR — on stage
Performs decision records. Walks, sits, emotes, speaks, runs ceremonies.

**Constraint: its only input is a DecisionRecord** (plus persona + register).
It cannot state a number that isn't in the record. Most of the firewalls we've
stacked become unnecessary once this holds — they're guarding a door that
shouldn't exist.

### 4. PRE-COMMITMENT — the moat
Before execution, hash the record and write it to Solana as a memo:
`riku:commit:v1:{sha256}`. Reveal the plaintext after the fill or a timeout.

Anyone can re-hash the revealed record and match it against the confirmed memo
transaction. That makes backdating impossible and turns "average peak 1.67x"
from *our database says so* into something provable. For a character whose pitch
is "I publish the average, not just the winners," that's the differentiator —
and it costs a fraction of a cent per call.

(Idea taken from omotrades; their execution of it is the one genuinely strong
thing in that repo.)

## On the delay — settled

The desk acts immediately; the stage replays it a minute or two later. This is
**not** a problem:

- People actually tracking him use the pump.fun callouts or read the wallet
  on-chain — both are real-time and unaffected.
- The stream is entertainment. A two-minute-old re-enactment of a real decision
  is still a real decision.
- We already do exactly this for snipes and operator calls, and nobody has ever
  noticed.

The one rule: **he replays real checks in real order.** He never performs
suspense over an outcome that was never in doubt, and never narrates a decision
that didn't happen.

## Build order

Each step is independently useful and shippable alone.

1. **Decision records** — emit + persist; actor reads only from them.
   *Kills the hallucination class permanently.*
2. **Pre-commitment** — hash records on-chain, reveal after.
   *Makes the track record provable.*
3. **Desk consolidation** — one interface, own clock, no beat dependency.
   *Removes the reason the sniper had to bypass everything.*
4. **Caller intel** — weight a coin by the track record of who else called it
   (see `CALLER-INTEL.md` once the CC API is mapped).
   *A real edge, and very on-character: he judges other callers.*

## What NOT to change

- Code decides tiers and rails; the model never overrules them.
- $RIKU is unsellable, long holds are operator-only, the desk book stands.
- The stage stays exactly as it is — same beats, same cameras, same voice.
  Viewers should notice nothing except fewer wrong numbers.
