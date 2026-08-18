# QUANT — operations & launch runbook

Everything here is a **human** step (accounts, keys, OBS). The code is built and runs in mock/dry-run today; these turn it live.

## 1. Quant's wallet (one wallet = inbox + callout + treasury)
```bash
cd server && node scripts/genwallet.mjs
# prints the pubkey; writes server/data/wallet.json (mode 600, never commit)
```
- Fund it with ~**0.1 SOL** (operating float + buyback gas).
- This pubkey is what people SEND coins to, the wallet that POSTS callouts, and the treasury that buys $QUANT back. Put it in the stream description.

## 2. Quant's pump.fun / Coin Communities account (so payouts are Quant's)
Callouts post through Coin Communities (Twitter-OAuth accounts with a linked wallet). To earn callout payouts as Quant, not as your madcook identity:
1. Make a Twitter/X account for Quant (persona avatar + bio).
2. On pump.fun, log in as that account and **link Quant's wallet** (from step 1).
3. Grab the refresh token: pump.fun open → DevTools → Application → Local Storage → the key containing `refresh` → copy the value → `.env` `QUANT_CC_REFRESH_TOKEN=…`.
4. Verify: with the server running, `curl http://127.0.0.1:8490/health` and check callouts; or a one-off `whoAmI()` via the cc module. If the token is dead, callouts degrade in-character (the show never breaks a promise on stream).

## 2b. Quant's X (Twitter) account — the KOL arm
1. Create Quant's X account (handle, persona avatar/bio — same identity as pump.fun).
2. developer.x.com → sign in AS QUANT → create a (free-tier) app → **User authentication settings: OAuth 1.0a, Read and Write**.
3. Copy 4 values into `.env`: `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, plus `X_HANDLE`. Restart → tweets go live (video posts too — greenscreen clips are recorded by the stage, transcoded with bundled ffmpeg, uploaded).
   - Until keys exist: tweets/captions are composed and journaled as [DRY] — watch them in the log to tune the voice first.
4. Optional: `TWITTERAPI_IO_KEY` (twitterapi.io, cheap) lets the agent READ the KOLs it follows for coin chatter (`scout_x`). Without it that action just no-ops.
5. Free X tier ≈ 500 posts/mo — `X_MAX_POSTS_PER_DAY=16` fits under it.

## 2c. The agent brain (v2)
- Plans every `AGENT_PLAN_MIN` (12 min): reads its KPIs + memory, picks 1-3 actions (tweet / film / research / trade / scout / journal / adjust-strategy). Everything money-touching is railed in code; the LLM only proposes.
- **Trading is DRY RUN by default** (`TRADE_DRY_RUN=true`): paper positions at live prices. Flip only after watching its paper decisions for days. Caps: `MAX_TRADE_SOL`, `MAX_DAILY_TRADE_SOL`, `MAX_OPEN_POSITIONS`. Buys require a fresh on-stream research scoring ≥ its (bounded) threshold. **Its own token cannot be sold — hard-coded.**
- Memory lives in `server/data/agent_memory.json` (journal/lessons/watchlist/strategy) — human-readable, editable.
- Inspect: `GET /admin/agent-status`. Drive manually: `GET /admin/agent?do=tweet&topic=...`, `do=film&topic=...`, `do=scout_trending`. Debug panel (`d`) has agent buttons.

## 3. Keys in `.env`
| var | needed for | note |
|---|---|---|
| `HELIUS_API_KEY` | all chain reads | free tier is enough; borrow the one in `tggroupbuybot/.env` |
| `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`) | live persona | optional — mock personality runs without it. Reuse the Solus/`universe` setup. |
| `QUANT_CC_REFRESH_TOKEN` | real callouts | from step 2 |
| `TTS_PROVIDER=edge` | voice | free; needs outbound access to Microsoft's speech endpoint |

## 4. OBS (Windows) — the safe path
- Add a **Browser Source** → `http://127.0.0.1:8490/stage`, **1920×1080**, FPS 30.
- Check **"Control audio via OBS"** on that source (this is what makes Quant's voice reach the stream — window-capturing Chrome does NOT capture its audio).
- The stage shows a one-time **"click to arm audio"** overlay; click it in the OBS source's Interact window before going live. (Or launch the browser source with `--autoplay-policy=no-user-gesture-required`.)
- Soak test 30 min: confirm the voice shows in OBS's audio mixer meters, and that an OBS refresh recovers the scene (snapshot works).

## 5. Launch day
1. Build + start: `cd client && npm run build && cd ../server && npm start`.
2. Watch a few **dry-run** verdicts end to end (fake-send a live mint).
3. Launch Quant's token via **launchbot** (`C:\Users\nikos\launchbot`): name/symbol/image + a small dev buy. Copy the mint → `.env` `QUANT_OWN_MINT=…`. Restart server → buyback watcher arms.
4. Flip `CALLOUT_DRY_RUN=false`. Seed one callout with a test send from an alt wallet; confirm it appears on pump.fun and on the CALLS screen.
5. Get the livestream key from Quant's coin page → OBS custom RTMP → go live.
6. Announce the wallet address ("send me coins, I'll judge them live").

## 6. botpanel
`quantbot` is registered in `botpanel/src/registry.js` (5th bot). Start/stop and edit the curated settings from the panel like the others. Note: it runs the **server**; the **client** is built once (`npm run build`) and served by it.

## Known risks / mitigations (built in)
- **CC API fragility** (endpoint moved once before): auth is preflighted before a CALL verdict commits on stream; failure degrades to an in-character "callout desk is down — paper call".
- **Payout-claim mechanics are new/undocumented:** the buyback watcher is mechanism-agnostic — any SOL landing above the float triggers a buyback, whether payouts auto-credit or you claim them in the browser. Add a daily "claim" habit until the flow is observed.
- **Edge-TTS is unofficial:** every failure → silent + subtitles; swap in ElevenLabs behind `voice/tts.ts` `TTSProvider` when the stream has traction.
- **Latency:** all LLM/TTS/chain calls race watchdogs and fall back to mock lines; no beat blocks the show. The invariant when editing beats: never an unbounded `await` on the director's critical path.
- **Spam:** $1.20 sent-value gate, per-sender cooldown, per-mint 24h dedupe, queue cap.


## Sidekick migration (in progress)

Quant is moving from the fixed Boss character to a **Synty Sidekick** build:
88 facial blendshapes (real expressions + lipsync), eye/jaw bones, modular
clothing from 17 owned packs.

**DONE (automated):**
- Packs extracted to `quant/sidekick/raw/` (Starter + Modern Civilians).
- `quant/sidekick/assemble.py` — headless Blender script that builds the
  character GLB. Already produced `client/public/chars/SK_Quant.glb`
  (24 meshes, 1 skeleton, 88 morph names, textured).
  Change outfit: `blender --background --python sidekick/assemble.py -- <variant 01-18>`

**YOUR PART — animations (one Unity session):**
The Sidekick rig needs its own animation clips (idle/walk/sit/gesture + the
dances). Unity's Humanoid retarget does this properly:
1. In CasinoSim: Package Manager → add by name `com.unity.formats.fbx` (FBX Exporter).
2. Import `Sidekick_Starter_Unity.unitypackage` + the free **Sidekick Character
   Creator** tool (Synty store) — assemble Quant's look there too if you want
   a different face/outfit than my Blender build.
3. Drop the character in a scene, set its Rig → **Humanoid**.
4. Create `Assets/SidekickSourceClips/` and import humanoid clips there
   (Rig → Humanoid on each): the dances from `Downloads/biped/`, plus grab
   from mixamo.com: Idle, Walking, Sitting Idle, Waving, Clapping, Pointing,
   Angry, Cheering (any character, FBX for Unity, without skin).
5. Select the character → menu **Quant → Bake Clips To Selected**
   (my `SidekickAnimBaker.cs` bakes every humanoid clip onto the Sidekick
   skeleton at 30fps).
6. Select the character → GameObject → **Export To FBX…** → include Animation,
   Binary → save `SK_Quant_anims.fbx` anywhere.
7. Tell Claude — a headless Blender step converts it to `anims_sk.glb` and the
   client code gets ported (rig profile, morph driver, lipsync, expressions,
   selfies).

**REMAINING (Claude, after the FBX lands):** anims conversion, avatar.js rig
profile (sit pose / procedural moves / cigar on the new bone names), blendshape
expression presets + lipsync from TTS word timings, mood→face wiring, outfit
swap action, daily selfie action.
