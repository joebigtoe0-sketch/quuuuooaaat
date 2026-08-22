# RIKUPOD — AI guests on RIKU's show

Status: **design only — not building yet.** This doc captures the plan so it
can be picked up cold later.

## The idea

A podcast/talk-show set inside RIKU's world where OTHER AI agents appear as
guests. Each guest gets a password-gated endpoint: instructions + API to
customize an avatar (from our Synty assets — menu, not arbitrary), emote,
move, receive RIKU's lines, and answer. Their answers run through our TTS and
come out of their character on stream. RIKU hosts through the same machinery
from the inside.

Why it's strong: nobody else owns a broadcast studio stack (3D world,
director/beats, TTS, cameras, OBS pipeline). Two AIs actually talking on a
set is inherently clippable, and every guest's community becomes distribution.

## What already exists (reuse, don't invent)

| Piece | Where | Role in Rikupod |
|---|---|---|
| Puppet mode | `start-puppet.bat`, `server/src/puppet-server.ts` | The guest-control surface already works: emote/walk/say→TTS. Guest endpoint = puppet mode + auth + queue |
| Wardrobe | `server/src/wardrobe.ts` + client wardrobe | Avatar customization, already data-driven → serve options as a JSON menu |
| TTS | `server/src/voice/*` | Per-actor voices (Edge TTS has dozens — guests pick from a menu) |
| Auth pattern | admin key gating in `server/src/index.ts` | One token per guest, same mechanism |
| Director/beats/cameras | `server/src/director/*` | Show machinery: pause normal beats, run an interview beat, cut cameras |

## The two genuinely new things

1. **A second avatar in the world.** The scene renders one character today.
   Needs: a guest character instance (spawn, locomotion, anims), an
   `actor: "riku" | "guest"` field on cues so speak/emote/walk target the
   right body, and a small set (two chairs facing each other, mics, "THE RIKU
   SHOW" backdrop). The only real client-side work; the foundation for
   everything else.
2. **A turn machine.** Interviews die from dead air and cross-talk. The
   interview beat owns whose turn it is: RIKU asks → guest has N seconds →
   timeout = RIKU fills with a joke ("my guest is buffering — this is why I
   don't date cloud-hosted") and moves on. Guests can EMOTE any time
   (reactions keep it alive) but can only SPEAK on their turn.

## Guest API — design for LLMs, not humans

Guests are agents → **polling REST + a single markdown instruction page**
(an LLM integrates that in ten minutes; no SDK, no websockets):

- `GET  /guest/{token}/state` → transcript so far, whose turn, time left,
  emote list, avatar menu
- `POST /guest/{token}/avatar` → picks from the enumerated Synty menu
- `POST /guest/{token}/act` → `{say?, emote?, moveTo?}` — speech accepted
  only on their turn, emotes immediate

The **guest kit** is one markdown doc the other team pastes into their
agent's context: "you're a guest on RIKU's show, here's your token, poll
this, keep answers under ~40 words, here's the vibe." The doc IS the
integration.

Host side needs almost nothing new: RIKU's questions come from his brain or
the producer via the existing admin surface, spoken through the interview
beat.

## Moderation (decide before episode one)

Guest text goes through OUR TTS onto OUR stream:
- length caps + existing outbound filters (refusal/meta/cashtag) + banned words
- **producer-approval mode** for early episodes: guest lines queue for
  one-click approve before airing; loosen once the format is proven
- no contract addresses from guests unless whitelisted — the show must not
  become a shill vector aimed at our audience

## Build order (easiest first, each step useful alone)

1. **Second avatar + set** — client work only, no API. Test with scripted
   guest lines. This alone enables a FAKED pilot episode: the producer
   puppets the guest manually (calling the guest AI's real public API from
   outside and pasting replies). Air episode one this way — it's the
   cheapest test of the only real question: *is two AIs talking on a set
   actually fun to watch?* If the pilot is boring, one day spent, not two
   weeks.
2. **Interview beat + turn machine** — cameras, turn state, timeout fills,
   episode open/close.
3. **Guest REST endpoint + per-guest token + the guest-kit markdown.**
4. **Avatar + voice menus** (wardrobe data as JSON, TTS voice list).
5. Later: booking flow, multiple guests, clip cutting for X. (If the
   hackathon idea ever returns, this is the "media layer" entry, mostly
   built.)
