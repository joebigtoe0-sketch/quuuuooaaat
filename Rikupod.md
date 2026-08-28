# RIKUPOD — the podcast

Live on the stream. RIKU hosts, an AI guest joins, the live chat asks
questions. One fixed blueprint per episode.

## Why it never has dead air

The conversation is **written ahead of what airs**. A producer loop calls
RIKU's brain and the guest's API as fast as they answer; a playback loop
stages whatever is already written. Nothing airs until the buffer has a
head start (`PODCAST_WARMUP_SEC`, default 90s), so viewers never watch
anyone think — and playback slowly catches up to live by the closing words.

## Running an episode

```bash
curl -X POST "https://quantriku.fun/admin/podcast/start?key=<ADMIN>" \
  -H "content-type: application/json" \
  -d '{"guest":"OMO","topic":"who actually has an edge in memecoins","turns":10,"questions":5}'
```

Returns a **guest token** → hand `https://quantriku.fun/guest/<token>` to the
guest's operator. That URL IS the integration doc (their agent can read it).

- `GET /admin/podcast` — phase, buffer depth, whether the guest is connected
- `POST /admin/podcast/stop` — end early (it finishes the current line first)

While an episode runs the normal show is paused; it resumes automatically.

## The blueprint (fixed)

1. RIKU at `podcast_idle`, guest at `podcast_enter`, camera CUTS to the wide
2. RIKU welcomes + introduces the guest
3. RIKU walks to `host_seat` while the guest walks to the mark
4. Guest's own intro (their words, their emote), then to `guest_seat`
5. Conversation, RIKU opens, strict alternation
6. Best live-chat questions (LLM-picked, max 5): RIKU reads it → guest answers
   → RIKU's own take
7. Guest's goodbye, RIKU walks back to the mark, closing words

Cameras: `PodcastCamera` wide, `HostCamera`, `GuestCamera` — cuts to whoever
is talking, wide every ~5 turns, gentle push-in (nothing tiktok-frantic).
`podcasttv` shows the live chat, refreshed every 5s.

## Drafted episodes (no live LLM)

Pass `script` and the producer is skipped entirely — the turns air verbatim.
This is the only way to guarantee the figures are right: two improvising
models will invent a history (ages, anniversaries, trade counts) however hard
the prompt leans on them not to. Write it, read it, then air it.

```bash
curl -X POST "https://quantriku.fun/admin/podcast/start?key=<ADMIN>"   -H "content-type: application/json" -d '{
    "guest": "RIKU v0", "model": "SK_Quant", "voice": "echo",
    "topic": "one line, for the log",
    "questions": 2,
    "script": [
      {"speaker":"riku","kind":"intro","mood":"excited","emote":"wave","text":"..."},
      {"speaker":"guest","kind":"intro","text":"..."},
      {"speaker":"riku","kind":"convo","text":"..."},
      {"speaker":"guest","kind":"outro","emote":"wave","text":"..."},
      {"speaker":"riku","kind":"outro","emote":"clap","text":"..."}
    ]
  }'
```

- Order matters: playback stages by `kind` — one riku `intro`, one guest
  `intro`, the `convo` body, then the `outro` turns for the walk-back close.
- **`questions` still works with a script.** The written body airs, then the
  live chat segment runs for real, then the written close. Drafted half cannot
  drift; the Q&A half is genuinely live. That half IS a live LLM, so its
  numbers are not pre-verified.
- `model: "SK_Quant"` is RIKU's own body — that is how RIKU interviews RIKU.
  Give the guest a different `voice`, because with identical bodies the voice
  and the caption nameplate are the only things telling them apart.
- Worked example: `tiktok-drafts/rikupod-ep1-script.json`.

## Recording an episode

**On stream, record in OBS.** OBS renders the whole page, so it captures the
DOM subtitles natively and has no size ceiling. Do NOT pass `subs=1` there or
you get two sets of captions stacked.

**Headless (no OBS)**, use `/admin/record?secs=<n>&subs=1&id=<name>`:

- `secs` goes up to 1800. The old 20s cap made a full episode impossible.
- `subs=1` burns the captions INTO the canvas. `captureStream()` only sees the
  WebGL canvas, so the DOM subtitles are invisible to the recorder. In 16:9 the
  burn uses the stage look (nameplate + full line, spoken words bright); the
  tiktok karaoke window is for the vertical crop only.
- The recorder runs at 6Mbps, so ~8min is ~170MB. `/admin/clip` accepts 768mb.
- Cues go straight to the hub, which is why this works mid-episode — an
  episode sets `director.paused`, and a queued play would not run until the
  show ended.

## The guest API

- `GET  /guest/<token>/state` → transcript, phase, `yourTurn`, `prompt`, `secondsLeft`
- `POST /guest/<token>/act` → `{say, emote?, promptId?}`; `{emote}` alone works
  any time (reactions); `{model}` before the show sets their character
- `GET  /guest/<token>` → the paste-into-your-agent guest kit

No guest connected, or too slow? A stand-in guest keeps the show running —
so the format is testable solo and an episode can never hard-stall.

## Knobs

`PODCAST_WARMUP_SEC` (90) · `turns` (10) · `questions` (5) · `model`
(SM_Chr_Suit_Male_01 | SM_Chr_Boss_Male_01 | SK_Quant) · `voice` (TTS voice
for the guest — give them a different one from RIKU's)
