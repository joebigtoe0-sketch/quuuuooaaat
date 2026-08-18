# QUANT — the AI caller

A livestreamed AI character for pump.fun. People **send coins to Quant's wallet**; Quant walks to its terminal, **researches each coin live** (holders, dev history, age, mayhem, bundling, smart-money presence), delivers a **voiced in-character verdict**, and either **posts a real pump.fun callout** or roasts it on stream. Every SOL its callouts earn **buys back its own token** (buy + hold) — the flywheel: hold $QUANT → want its callouts to land → volume → buybacks.

This is an **entertainment** project. The analysis is plausible and scam-averse (it won't call obvious rugs), but it is a game show, not an investing tool.

## Architecture

```
quant/
  server/   Node + tsx. The show brain — no browser needed to run it.
    chain/      solana + pump SDK (buy-only: Quant never sells), wallet, inbox watcher, buyback
    analysis/   engine + checks (curve/mayhem, holders, dev history, frontend API) + score→tier
    brain/      LLM adapter (OpenAI-compatible, daily USD breaker) + prompts + mock personality
    voice/      Edge-TTS (free) behind a TTSProvider interface (ElevenLabs drop-in later)
    callout/    Coin Communities client (Quant's own account) + post desk (preflight, caps, dedupe)
    director/   the show: state machine + priority queue + beats + server-authoritative locomotion
    feed/       PumpPortal new-launch stream → conveyor belt
  client/   Three.js stage (fixed 1920x1080 for OBS). Dumb renderer: applies ticks + cues.
```

The client is a **dumb renderer**. The server owns all state and drives the show over WebSocket with a 10Hz avatar tick + one-shot cues; a late-joining client (OBS refresh) rebuilds everything from the hello snapshot.

## Run it (dev)

```bash
# 1. install
cd server && npm install
cd ../client && npm install

# 2. config
cp .env.example .env      # edit: at minimum HELIUS_API_KEY. Everything else has safe defaults.

# 3. server (mock brain + dry-run callouts work with ZERO keys)
cd server && npm run dev

# 4. client dev (hot reload) — separate terminal
cd client && npm run dev
# open http://127.0.0.1:5199  (talks to the server on :8490)
```

With no `LLM_API_KEY` the brain runs its **mock personality** (template lines with real numbers) — the full show loops. With no TTS reachable it degrades to **silent + subtitles**. Nothing blocks the show.

### Drive the show without waiting for real coins
```bash
# simulate someone sending a coin (use any real pump.fun mint for real data)
curl -X POST http://127.0.0.1:8490/admin/fake-send -H 'content-type: application/json' \
  -d '{"mint":"<a real pump.fun mint>","sender":"<any wallet>"}'
# simulate a callout payout landing → buyback ceremony
curl -X POST http://127.0.0.1:8490/admin/fake-buyback -d '{"sol":0.05}'
# health / spend / state
curl http://127.0.0.1:8490/health
```

## Run it (production / stream)

```bash
cd client && npm run build     # → client/dist, served by the server at /stage
cd ../server && npm start
# OBS Browser Source → http://127.0.0.1:8490/stage  at 1920x1080
```

## Safety model (why it can't call a rug)

- **The tier is decided by code** (`analysis/score.ts`), never by the LLM. The model only narrates a verdict already reached. Coin metadata is sanitized + length-capped before entering any prompt, so a token's name/description can't prompt-inject a call.
- **Hard rejects** (never called): non-pump token, mayhem mode, dead (>30 min no trade), age < 2 min, sent value < $1.20, known serial-rug dev, top holder > 20% or top-10 > 50%.
- **Callouts default to DRY RUN.** Set `CALLOUT_DRY_RUN=false` only after the account is set up and you've watched dry-run verdicts.
- **Buyback rails:** never touches the operating float, per-tx and per-day SOL caps, own-mint must be tradeable, every buy ledgered. Quant **never sells** — there is deliberately no sell path in the code.

See `OPERATIONS.md` for account setup, OBS, and launch-day steps.
