# Deploying RIKU to Railway

The repo is Railway-ready: `railway.json` sets the build (`npm run build`) and start
(`npm start`) commands and a `/health` healthcheck. The server listens on Railway's
injected `PORT` automatically.

## One-time setup (Railway dashboard)

1. **New Project → Deploy from GitHub repo** → pick this repo. Railway detects Node
   and uses `railway.json` for build/start. First deploy will boot but stay idle —
   that's fine, finish the steps below and redeploy.

2. **Variables** (service → Variables → Raw Editor): paste every key from your local
   `.env` (the real one, not `.env.example`). The critical ones:
   - `QUANT_WALLET_SECRET` — the wallet secret (base58)
   - `HELIUS_API_KEY`
   - `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`, `LLM_MODEL_FRAGMENT`)
   - `TTS_API_KEY` (+ `TTS_BASE_URL`, `TTS_PROVIDER=openai`, `TTS_VOICE=onyx`)
   - `QUANT_CC_REFRESH_TOKEN` — pump.fun callouts (expires ~2026-09-17, re-grab from
     browser localStorage `coin-community-auth`)
   - `X_CONSUMER_KEY/SECRET`, `X_ACCESS_TOKEN/SECRET`, `X_BEARER_TOKEN`, `X_HANDLE`
   - **`ADMIN_PASSWORD` — set a strong one. The /admin panel is on the public
     internet now; the default would let anyone drive Riku.**
   - Do NOT set `QUANT_PORT` (Railway's `PORT` is used) and do NOT set `SIM_MODE`.

3. **Volume** (service → right-click / Settings → Volumes): mount a volume at
   **`/app/server/data`**. This is Riku's entire memory — journal, positions,
   strategies, the LIVE marker, generated audio/clips. Without it every redeploy
   wipes his brain. The seed intel files (creator stats, watchlists) auto-copy into
   the volume on first boot from `server/seed/`.

4. **Networking** (service → Settings → Networking): Generate Domain. The port is
   auto-detected from `PORT`. You get `https://<name>.up.railway.app`.

## After it's up

- Landing page: `https://<domain>/` · viewers: `/live` · OBS: `/stage` · admin: `/admin`
- Point OBS's Browser Source at `https://<domain>/stage` (1920x1080, control audio ON).
  Selfies/films need one stage page connected — OBS counts.
- `GET /health` shows state; `/admin` → GO LIVE section runs the full preflight.
- Redeploys: push to GitHub → Railway auto-deploys. The volume (and the LIVE marker)
  survives. Riku picks up where he left off.

## Cost/perf notes

- The server is a single always-on process; Hobby plan works. TTS/LLM cost is on the
  API keys, not Railway.
- ffmpeg ships via `ffmpeg-static` (Linux binary installs automatically) — films work.
- WebSockets are supported natively; the 10Hz stage tick is fine.
