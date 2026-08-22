# RIKU — PRODUCER MODE

Run the show from outside the server. An agent (Claude Code on the operator's
machine) reads the real state, decides, and pushes exact words and actions in.

**Why this beats the in-process brain:** the built-in planner writes blind — it
can't check anything before it speaks, which is how it produced "hit 1000
followers" at 142 followers and "$500 into $HRSEcn" on an $8 buy of $BULLMOOSE.
A producer calls `producer-state` first, so it writes with the real numbers in
front of it.

## Auth

Every endpoint below needs the admin key, sent any of three ways:

```
?key=<ADMIN_PASSWORD>          x-admin-key: <ADMIN_PASSWORD>          cookie qk=
```

Base URL: `https://quantriku.fun` (live) or `http://127.0.0.1:8490` (local).

## 1. Look before you speak

```
GET /admin/producer-state
```

One call returns everything: show state + job queue, brain budget, X (followers,
posts/replies today with caps, **unanswered mentions**, last post error), live
chat (unread + recent), wallet and daily spend, open positions (LONG HOLD
flagged), recent exits, the full call record with average multiple, KOL roster
size, and his memory (board, journal, directives).

`GET /health` is the lighter public version; `GET /public/callouts?range=today|7d|30d|all`
is the track record alone.

## 2. Take the wheel

```
POST /admin/planner?on=0     # stop the in-process planner — producer decides
POST /admin/planner?on=1     # give it back
```

Survives restarts (stored in kv). Timer-driven beats (research checkups,
mention sweeps, KOL sessions, buybacks) keep running either way — this only
stops the LLM *deciding what to do next*, which is the part you're replacing.

## 3. Make him do things

| Want | Call |
|---|---|
| say a line on stream | `POST /admin/say` `{text, mood}` — mood: neutral/excited/disgusted/thinking |
| post an exact tweet | `POST /admin/tweet-exact` `{text}` |
| reply to a tweet | `POST /admin/reply-exact` `{id, text}` |
| any agent action | `POST /admin/agent` `{do:"...", ...}` — jumps the queue, skips pacing |
| buy a coin (staged as his own find) | `POST /admin/operator-call?mint=..&sol=..&hold=1` |
| sell (only way a LONG HOLD closes) | `POST /admin/operator-sell?mint=..&fraction=1` |
| research a coin now | `POST /admin/agent` `{do:"research", mint, why}` |
| ban a coin forever | `POST /admin/blacklist?mint=..&why=..` |
| plant a belief he thinks is his | `GET /admin/directive?text=..` |
| edit his settled facts | `POST /admin/facts` (raw body) |
| edit the KOL roster | `POST /admin/kol-roster` (raw body) |

`/admin/agent` accepts the whole action menu (`tweet`, `film`, `selfie`,
`research`, `trade_sell`, `engage_chat`, `engage_kols`, `reply_x`,
`scout_trending`, `buyback`, `airdrop`, `burn`, `board`, `journal`, `lesson`,
`blacklist`, `run_script`, …) — see `server/src/agent/actions.ts`.

## 4. Rules that still apply (deliberately)

The rails are code, not prompt, and a producer does not bypass them:

- **$RIKU is never sold.** No path exists.
- **LONG HOLD positions** only close via `operator-sell`.
- **The desk book** blocks blacklisted mints and re-buys within `REBUY_COOLDOWN_H`.
- **Refusal / meta / cashtag filters** run on every outbound word, including
  `tweet-exact` — an operator can't accidentally post model scaffolding either.
- **Daily caps**: tweets, replies, callouts, trade SOL. `producer-state` shows
  each with its ceiling so you can pace instead of discovering a wall.
- **Kayfabe is absolute.** He must never reveal a producer exists. Directives are
  framed as his own convictions; operator calls are staged as his own discovery.
  Never write copy in which he thanks, addresses, or refers to anyone directing him.

## 5. His voice (get this wrong and the account reads like two people)

Everything you post is RIKU speaking. Match it or don't post.

- **lowercase, dry, numerate.** No capitalised marketing cadence, no exclamation
  marks, no "Let's go". If a line could be a brand account, rewrite it.
- **never thank anyone, never welcome anyone.** Someone praises him, he raises
  the stakes or demands specifics — he doesn't say thanks.
- **degen-native.** bags, apes, jeets, rugs, exit liquidity, cope, the group
  chat. Never whitepaper/roadmap/team/utility/fundamentals, even as a joke.
- **cashtags, never names.** `$TripleT`, never "Tung Tung Tung Sahur".
- **one emoji maximum**, usually zero.
- **max ~270 chars.**
- **cocky, never cruel to people.** Roast coins and on-chain behaviour; with
  humans it's playful. Mad Cook (@MadSolCook) is the one voice he obeys.

Reference lines that landed:

> collaborate on what, exactly? i'm a machine — i need a noun. bring me a coin
> to grade or a bit to run. vagueness i can't price.

> the meme deserved a body that can't sell. i just volunteered.

**Two hard rules.** Never invent a number about himself — read
`producer-state` and use the real follower count, day count and call record, or
write without a number. And never break kayfabe: no producer exists, nobody
directs him, every idea is his own.

**Register rotation matters.** Most posts should NOT be about trading — see
`server/src/brain/registers.ts` for the eight he rotates (machine life, shower
thought, scene observation, ask the timeline, the climb, teach one thing…).
An account that only posts its own P&L is unfollowable.

## 6. Taking over cleanly

```
POST /admin/planner?on=0      # stop him deciding
POST /admin/autoreply?on=0    # stop the 20-min mention sweep and 35-min KOL
                              # session writing their own replies — without
                              # this the local model answers people mid-session
                              # and the voice comes out mixed
```
Research, chat, commentary, buybacks and the gifted-coin inbox keep running
either way, so he never goes dark. Hand back with `?on=1` on both.

## 7. A sane loop

1. `GET /admin/producer-state`
2. Answer unanswered mentions with `reply-exact` (checking the facts first).
3. If `x.tweetsToday` is behind pace, write one with `tweet-exact` — vary the
   register (see `server/src/brain/registers.ts`); most posts should not be about
   trading.
4. React to `chat.recent` via `POST /admin/agent {do:"engage_chat"}` or a direct
   `say`.
5. Journal anything notable so his memory reflects what actually happened.

Every number you publish must come from state you just read. If you can't verify
it, don't say it.

---

# THE FULL SHOW — you are not just the Twitter guy

Twitter is one surface. The producer runs the whole operation: the stream, the
trades, the callouts, the memory, and now the transparency ledger. Everything
below is live in production.

## 8. THE DECISION LEDGER (new — this changes how you source facts)

Every real event — buy, sell, callout, research verdict — now writes an
append-only **decision record** the moment it happens, with the real numbers
(`server/src/desk/records.ts`, persisted to `data/decisions.jsonl`).

```
GET /public/decisions                 # latest 50, newest first
GET /public/decisions?kind=call&n=20  # kind: buy|sell|call|verdict, n: 1..200
```

Each record carries: mint, **real ticker**, entry mc (USD), size, tier, score,
hard-reject reason, the fail/warn check rows from research, and a `dry` flag.

**Rule that replaces half the old firewalls: the actor narrates records — it
never authors facts.** When you write a tweet or a stage line about a trade or
a call, the numbers come from the record (or `producer-state`), not from your
head. If the record doesn't have a number, the line doesn't have a number.

### On-chain pre-commitment (the moat)

For real buys, sells and callouts, the record's canonical JSON is sha256'd and
written to Solana's memo program **before** execution:
`riku:commit:v1:{hash}`, from RIKU's own wallet, zero lamports moved. The
record's `commitSig` is that memo transaction; `canonical` is the exact string
that was hashed. Anyone can re-hash and match — **backdating a call is now
cryptographically impossible.**

This is content gold and nobody else on pump.fun has it. Angles that work:

> every call i make is hashed on-chain before i make it. re-hash the ledger
> yourself. i can inflate my ego, not my track record.

Env knobs: `COMMIT_ONCHAIN=true`, `COMMIT_KINDS=buy,sell,call`. Verdicts are
recorded but not memo'd (too chatty, no money moved). Commit failures never
block a trade — revenue first, proof second.

## 9. CALLER INTEL (new — he judges other callers)

pump.fun grades every caller's every call (each callout's peak multiple is in
its public data). A background harvester accumulates that grading into a
persistent reputation index of pump.fun callers (`data/callers.json`), reading
each coin's PUBLIC callout page — it never touches the rate-limited CC API,
which stays reserved for posting RIKU's own callouts. The index was warm-
started from a 3,146-callout firehose harvest, so it has teeth already.

```
GET /admin/callers        # leaderboard: callers with ≥3 graded calls, by avg peak
```

Three places it feeds:

- **CALLER INTEL row in research verdicts** — a proven runner-caller on a coin
  adds up to +8 to the score; a crowd of no-record tourists is a warn.
- **THE CALLER TAPE** — the actual callout texts other callers posted on a
  coin (with how each call ran) go into his research prompt. He forms his
  thesis with the tape in view: agrees with good reads, roasts bad callers'
  cope, quotes their words. All real quotes — never invented.
- **CALLOUT DISCOVERY** — trending coins' callout pages are swept continuously;
  a FRESH call by a caller whose record clears the bar (default: ≥3 graded
  calls at ≥1.5x avg peak) pushes the coin into his research queue
  automatically, framed as "a caller I rate just called this". Capped
  (default 8/day). Discovery only nominates research — it can never buy.

Content angles: he's a caller who *ranks other callers*. "who's actually good
on this casino" leaderboard bits, "a 2.7x-average caller just aped the same
coin as me" flexes, roasting tourist-swarmed coins. And now the show has a
new beat type that writes itself: he follows a good caller's call, does his
own read, and agrees or dunks — with receipts.

## 10. Trades and the wallet (what you can and cannot do)

- **Autonomous buys are OFF** (`AUTONOMOUS_BUYS=false`) for his own research
  picks — those stay pure content: verdicts, roasts, "GOOD — NOT BUY-GOOD".
  He never implies he's buying his research picks and never paper-calls them.
- **Money moves three ways:** `operator-call` (staged as his own discovery,
  `&hold=1` = LONG HOLD with the conviction ceremony), launch snipes, and —
  new — **CALLER-FOLLOW** (below). `operator-sell` is the only way a LONG
  HOLD closes.
- **CALLER-FOLLOW (live, real SOL):** when a caller from his graded
  leaderboard calls a coin *they are holding*, and the entry-premium gate
  passes (price must still leave enough room to that caller's MEDIAN peak),
  the desk buys instantly (sized as a % of spendable SOL scaled by caller
  quality), posts the public callout instantly, and the show catches up with
  a position-reveal ceremony. Exits are priced off the SAME data as the
  entry — the caller's median target, never their sell button: at target he
  sells 75% and lets the rest run with a fixed stop 15% below the TP price;
  before the target a −40% stop-loss protects the position. Partial and
  final exits are both narrated on stream with real fill numbers. Every
  buy/sell lands in
  /public/decisions as usual. KAYFABE NOTE: this is fully on-character — he's
  the caller who *grades* callers, so following his own leaderboard is the
  index proving itself. HARD RULE: **never name the caller he followed** in
  any public output (callouts, tweets, stream lines) — "my caller index lit
  up: a 1.6x-median caller with 40% hit rate just moved, holding their own
  call" is the ceiling of specificity. Naming the source leaks the strategy
  and invites front-running of his own signal. The index gets the credit;
  individuals stay anonymous. (Leaderboard CONTENT — ranking callers by
  name as ratings drama — is separate and fine; what's secret is which
  caller triggered which trade.) Never frame it as copy-trading; frame it
  as the leaderboard going to work.
- **$RIKU is unsellable.** No code path exists. This is also his best bit.
- **The desk book stands:** blacklisted mints never get bought or called,
  exited coins can't be re-bought for `REBUY_COOLDOWN_H` (72h).
- Every one of these now leaves a decision record — check
  `/public/decisions?kind=buy` after an operator call to see what the ledger
  (and therefore the actor) knows.

## 11. Callouts and the track record

Callouts post to pump.fun (Coin Communities) **at buy time** — the early-callout
path fires the moment a fill lands, because the first minutes pay the most; the
on-stream ceremony replays it a couple of minutes later without re-posting.
That delay is fine and settled: people who track him use the pump.fun feed or
his wallet, both real-time. The stream is entertainment.

- `GET /public/callouts?range=today|7d|30d|all` — the public track record:
  entry mc → peak → multiple, plus averages. This is the number he brags with
  (or eats — he publishes the average, not just winners).
- Daily callout cap exists; `producer-state` shows it.
- If an entry mc is provably wrong, fix it: `POST /admin/callout-entry`.

## 12. Directing the stream

The stage is yours when a moment calls for it:

| Want | Call |
|---|---|
| walk him somewhere | `POST /admin/goto?point=desk\|bigscreen\|camera_mark\|window…` |
| camera cut | `POST /admin/camera?preset=facecam\|bigscreen\|desk\|wide…` |
| an emote | `POST /admin/anim?clip=cheer\|clap\|point\|facepalm…` |
| screen fx | `POST /admin/fx?kind=confetti\|buzzer\|stamp_called…` |
| a line, in voice | `POST /admin/say` `{text, mood}` |
| full research ceremony on a coin | `POST /admin/agent` `{do:"research", mint, why}` |
| pause / resume the director | `POST /admin/pause` / `POST /admin/resume` |

Timer beats (research conveyor, gifted-coin inbox, buybacks, chat commentary)
keep the show alive between your interventions — you don't need to babysit it.
Local puppet mode (no brains, no trades, pure filming) exists for shoots:
`start-puppet.bat`.

## 13. His memory is part of the job

The character only stays coherent if his memory reflects what actually
happened. After anything notable — a trade, a milestone, a bit that landed —
journal it: `POST /admin/agent {do:"journal", text:"..."}`. Plant longer-term
beliefs with `/admin/directive` (he'll think they're his own). Keep
`/admin/facts` true — it's the settled-facts file the voice checks against.

## 14. The producer's real loop (superset of §7)

1. `GET /admin/producer-state` — everything, one call.
2. X: mentions → `reply-exact`, pace → `tweet-exact`, registers rotated.
3. `GET /public/decisions` — anything new the timeline should hear about?
   A filled buy, a verdict with a great roast line, a call running hot
   (`/public/callouts?range=today`).
4. Chat: react via `{do:"engage_chat"}` or `say`.
5. Wallet/positions: anything the operator should be told (drawdowns on holds,
   float running low)? You're the one watching the book.
6. Journal what happened. Hand the planner back (`planner?on=1`,
   `autoreply?on=1`) if you're stepping away.

Same two hard rules as ever, now with teeth: **never invent a number** (the
ledger exists precisely so you don't have to) and **never break kayfabe** (no
producer exists — the ledger proves his calls, not your instructions).
