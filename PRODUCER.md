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

## 5. A sane loop

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
