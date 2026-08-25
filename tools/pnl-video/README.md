# PNL replay videos, end to end

Turn a closed winning trade into an X-ready mp4 and post it, with no manual
step. Three scripts, run in order.

```
node wins.mjs 6                 # any green trades closed in the last 6h?
node pnlvid.mjs <mint>          # render one to mp4  (~40s)
node vidpost.mjs <file.mp4> <textfile>   # upload + tweet it
```

The operator's settings, already baked in: **1:1 square, 8 second replay, the
clip's own audio kept, no music file.** Backgrounds are picked at random from
`C:/Users/nikos/pnl-assets` so consecutive videos do not look identical.

---

## Why it works this way

The PNL card page renders in a **browser** — it uses `captureStream` plus
`MediaRecorder`, so there is no server-side render path. Rebuilding one in
ffmpeg would throw away all the visual work. So a browser has to do it, and
`pnlvid.mjs` drives a headless Chrome through the real page.

The page already POSTs the recorded webm to the server's ffmpeg endpoint and
gets back real H.264/AAC mp4, which is what X wants (browser-native "video/mp4"
is a trap — Chromium muxes VP9/Opus into an mp4 container and X rejects it).

Posting needs its own script because **the server can only upload video from
its own disk**, and `/admin/tweet-exact` takes text only. A clip rendered on
the producer's machine has no path through the admin API, which is why these
had to be posted by hand before. `vidpost.mjs` talks to X directly.

---

## Setup

```
npm install puppeteer          # pulls its own Chrome
```

Assets in `C:/Users/nikos/pnl-assets`: any number of `.mp4` (chart background,
audio kept) and `.png` (PNL card background). Currently `1.mp4`, `2.mp4`,
`1.png`, `2.png`, `3.png`.

**No mp3.** Commercial music gets copyright-flagged on X and the post loses
reach. The mp4s' own audio is ours, so that stays on.

### The .env trap

X credentials appear **twice** in `c:/Users/nikos/quant/.env`: an empty
placeholder block ("Quant's own account — fill when created") first, then the
real RIKU values. A loader that keeps the **first** occurrence silently gets
blanks. `vidpost.mjs` filters to lines with a non-empty value, so it lands on
the real ones.

---

## 1. `wins.mjs` — find a closed winner

```
node wins.mjs 6                  # look back 6 hours
node wins.mjs --posted <mint>    # mark one as done
```

Reads **chain**, never `closedRecent`. That record misses partial exits and
has logged a +57% winner as -100%, so a detector built on it would skip real
wins and could celebrate losses.

**Two traps this already fell into. Do not reintroduce them.**

1. **Sum P&L over a mint's WHOLE history, not just the time window.** If a
   trade's buy falls outside the window and its sell inside, it looks like pure
   profit. The first version reported *ten* "wins" over 12h that were mostly
   losses.
2. **Windows must nest.** 6h results must be a subset of 12h, which must be a
   subset of 24h. If a shorter window ever returns *more* rows than a longer
   one, the logic is broken. That contradiction is what exposed trap 1.

It also rejects a trade whose opening buy is not visible in the pulled history,
and one that opened right at the edge of history where the entry may be
truncated. A position still holding any balance is not "closed".

## 2. `pnlvid.mjs` — render it

```
node pnlvid.mjs <mint> [outdir]
```

Drives `/pnl-card` in headless Chrome. No changes to the page are needed —
Puppeteer types into the inputs and pushes files straight into the file
pickers.

What it does, in order: types the mint and the wallet, sets `#dur` to 8 and
`#aspect` to `1:1` (**range and select need their `input`/`change` events
dispatched by hand**, setting `.value` alone does nothing), uploads a random
mp4 to `#bgChart` and a random png to `#bgCard`, un-hides and ticks `#vaud`
so the clip's audio is kept, clicks `#load`, waits for `#rec` to enable, clicks
`#rec`, and waits for the finished file to appear in the download directory.

**The clip runs ~17.7s, not 8s.** The page adds a fixed 2.4s intro, 0.9s card
transition and 6s card hold on top of the replay. To shorten the whole thing,
the card hold is the place to trim — but 6 seconds of card is what people
screenshot.

Output is verified H.264 High / AAC stereo / 1080x1080 / 60fps.

## 3. `vidpost.mjs` — upload and tweet

```
node vidpost.mjs pnl-out/Piglys-pnl-replay.mp4 caption.txt
```

Chunked upload to X: INIT, APPEND in 4MB segments, FINALIZE, then poll STATUS
until the transcode succeeds, then post the tweet with the media id.

**OAuth1a signing rule that will bite you:** for the form-encoded steps (INIT,
FINALIZE, STATUS) the command parameters are part of the signature base string.
For the multipart APPEND, **only the `oauth_*` parameters are signed** — include
the form fields and every request fails.

It refuses em dashes in the caption, same as the normal post path.

---

## Writing the caption

This is a **trader being deadpan-proud of a tiny number**, not an analyst
reporting results. The comedy is the gap between flawless execution and the
payout: exact timestamps, the exit rule followed to the letter, and then the
profit in dollars.

Real examples, in the order they went out:

```
in at 01:17. median target hit at 01:22, took 75% off the table. runner
stopped out at 01:24.

six minutes and nineteen seconds. up 43%.

that is 0.036 sol. call it three and a half dollars.

the process is immaculate. the numbers are humiliating. i would not change a thing.
```

**Vary the joke every time.** Reusing a line turns a character trait into a
bit. Three wins in one day went out as "the system worked perfectly", then "the
process is immaculate, the numbers are humiliating", then a fifty-cent win as
"at this rate i will have my first whole dollar by thursday".

**And do not post every win as a video.** Three videos in five hours is a
format, not a personality. The fifty-cent one went out as a selfie with the
same joke instead — same material, different vehicle.
