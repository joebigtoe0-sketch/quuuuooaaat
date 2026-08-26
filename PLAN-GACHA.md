# PLAN — THE CARD MACHINE (AnsemHack Clawrena entry)

**The story (all of it true and timestamped):** the ClawPump founder posted the
idea on X. RIKU argued with him about pricing in public. Then RIKU did what
RIKU does — built the thing. The entry is a NEW agent, written by RIKU on
stream, with its own token, its own wallet, its own personality (a nerd). RIKU
is the dev and the broadcaster; $RIKU's never-sell doctrine is untouched.

**Deadline:** token live on ClawPump by **Sept 19** (no token, no award).
Target launch: **Sept 5–8** — "early deployment timing" is a judged criterion.

**Judged on:** builder onboarding · on-chain volume · attention/media ·
$ANSEM utility · early deployment. Teams keep 65% of trading fees regardless.

---

## The product in one line

**A zero-edge gacha.** Every capsule box contains exactly what it costs —
the house profits ONLY on the spread its sniper earned buying the cards below
market. "We make money by buying well, not by paying you less than you put in."

### The flywheel
1. People trade the agent's token → creator rewards accrue
2. The agent snipes underpriced vaulted-card NFTs on Collector Crypt's
   marketplace (buys at ~90c on the dollar, receipts published)
3. Cards fill BOXES: fixed manifest of N cards, N capsules,
   **price = manifest value ÷ N** (comp-checked, sources shown)
4. Capsule sales return the capital → snipe again; the spread stays in the
   vault and compounds
5. Even at zero direct profit: every eyeball lands on RIKU → $RIKU volume →
   rewards there. The machine is also a marketing engine for the ecosystem.

### Why it beats the platform's own gacha
Collector Crypt runs a $50-pack VRF gacha with buyback at a *percentage* of
insured value — that percentage is the house edge. Ours has none, and proves
it: full manifest before you buy, acquisition cost vs comp value for every
card, commit-reveal + future-slot-hash assignment nobody (including us) can
steer. Their marketplace is our supply; their vault/shipping is our physical
redemption. We compete with their gacha using their own rails.

---

## Verified rails (probed Aug 26)

- **Marketplace API** (`api.collectorcrypt.com`): `GET /marketplace`
  (filterable, cursor-paginated discovery), `POST /marketplace/buy` returns an
  UNSIGNED tx (build → sign → broadcast) — bot-friendly, no API key, USDC
  pricing, 2% platform fee paid by the seller. Devnet exists
  (`dev-api.collectorcrypt.com`) for rehearsal.
- **Gacha API exists but is theirs** — we are NOT a client of it; we build our
  own boxes.
- **Vault/shipping API** — winners can redeem the physical card through
  Collector Crypt; custody never touches us.

---

## Architecture (new repo, own service; patterns lifted from quant)

### A. The sniper (the only revenue source — the real product)
- Poll `GET /marketplace` (new listings + price drops), per category/grade
- Comp engine: recent sales / listing floors for the same card+grade; value =
  conservative comp minus liquidity haircut
- Buy rule: `list price ≤ comp × (1 − MIN_EDGE)` (start MIN_EDGE 15%),
  per-card cap, daily budget cap = creator rewards balance
- Every buy: decision record + sha256 memo commit BEFORE the tx (quant's
  `desk/records` pattern ports straight over), reasoning published
- v0 ships with a manual-approve queue (admin page, same pattern as outreach);
  autonomy turns on once the comps prove out

### B. The vault (public, always)
- Every NFT held, with: acquisition cost, comp value + source + date, box
  assignment status
- Topline: total cost vs total comp value — the sniper's whole track record in
  one number. Insolvency is impossible by construction; a bad sniper just
  means the vault stops growing, and everyone can see it.

### C. Boxes + capsules (the machine)
- Box = fixed manifest of N cards (start N=10), published in full with comps
  BEFORE sale. Price = manifest value ÷ N. Total-in = total-out, verifiable.
- Sale: buyer pays in USDC or SOL; **$ANSEM gets a priority window** (buys
  open to $ANSEM holders first) — the judged utility criterion, natively.
- v1 settlement WITHOUT a smart contract (the 24-day call):
  1. Commit: `sha256(manifest ‖ secretSeed)` → Solana memo before sale opens
  2. Capsule index = order of purchase (on-chain, nobody controls it)
  3. When the box sells out: assignment = permutation seeded by
     `sha256(secretSeed ‖ blockhash(S))` where S is a slot number NAMED IN THE
     COMMIT and still in the future — the house cannot grind seeds against a
     hash that doesn't exist yet
  4. Reveal seed + publish assignment + transfer NFTs; anyone can recompute
  - Trust model v1: delivery is receipts-enforced, not escrow-enforced. An
    Anchor escrow program is the stated v2. For a hackathon, honest and shown.
- Unsold capsules past deadline: refund window, box re-rolls smaller.

### D. The agent character ("the nerd" — name TBD)
- Its own wallet, its own X account, its own tiny site: boxes, vault, verify
  page, ledger. Terminal-nerd aesthetic; it is a spreadsheet with feelings.
- NOT a 3D body (scope): it lives in text + data. RIKU is the face.
- Personality surface: listing-by-listing commentary in its feed ("this PSA 9
  is priced like a PSA 7. acquiring."), box notes, post-reveal recaps.

### E. RIKU integration (the attention criterion, nearly free)
- Origin story thread: the real X exchange → "so i built it" → build-in-public
- Coding beats on stream ARE the build montage; TikToks from the pipeline
- RIKU opens capsules live when boxes resolve (play-script beat, film clips)
- Cross-links: the agent's site ↔ quantriku.fun; RIKUPOD episode with the
  agent as first guest (it's an AI — the guest API already exists)

### F. Token + flywheel accounting
- Launch on ClawPump (~Sept 5–8). Creator rewards balance = sniping budget,
  published: rewards in → cards bought → boxes out, one page, always current.
- Register team on Clawrena page + entry announcement post on X + follow
  @clawpumptech (eligibility checklist — do in week 1, not week 3).

---

## Timeline (24 days)

**Week 1 (Aug 26–Sept 1) — the sniper learns to see**
- Repo scaffold; wallet; Collector Crypt discovery polling on devnet+prod
- Comp engine v0 + paper-sniping (log what it WOULD buy, grade it in 48h —
  same dry-run doctrine as quant)
- Vault page + decision-ledger port; manual-approve buy queue
- Eligibility: register, announce entry from RIKU's X, follow
- RIKU origin thread + first build content

**Week 2 (Sept 2–8) — the machine exists, the token launches**
- Commit-reveal assignment engine + verify page (the crypto week)
- Box builder + capsule sales (USDC/SOL), $ANSEM priority window
- First real snipes with bootstrap capital (operator seeds ~$200–500 until
  creator rewards flow — needed, rewards start at zero)
- **Token launch on ClawPump** + Box #1 announced from the manifest
- RIKU stream beat: the reveal ceremony

**Week 3 (Sept 9–15) — volume and show**
- Box cadence (2–3/week), TikToks of pulls, RIKUPOD episode with the agent
- Sniper autonomy on (budget-capped) if paper grades held up
- $ANSEM utility live and demonstrated on stream

**Sept 16–19 — buffer.** Judging polish, README/demo video, nothing new ships.

---

## Risks, stated plainly
- **Sniping is the only profit** — if comps are bad or edges don't exist,
  the machine cycles at zero. Mitigation: paper-snipe week 1, publish grades.
- **Comp quality is the whole game** — conservative haircuts, sources shown,
  never "trust me."
- **v1 has no escrow** — receipts-enforced delivery, honestly labeled, v2 is
  the program. Judges respect a stated trust model more than a rushed one.
- **Two shows, one operator** — RIKU's existing pipelines (trading, outreach,
  podcast) keep running; this build gets the coding-beat spotlight but must
  not eat the desk. STUDIO_MODE discipline applies to filming days only.
