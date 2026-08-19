import { z } from "zod";

/**
 * The agent's ACTION MENU — the complete set of things Quant may decide to do.
 * The LLM proposes actions as JSON; zod validates shape here; the EXECUTION
 * layer (director beats + trader + x client) enforces the money/posting rails.
 * The LLM can never invent an action that isn't on this menu.
 */
// free-text fields CLAMP to their max instead of rejecting the whole plan —
// a verbose model shouldn't sink a valid decision. Mints stay strict.
const txt = (min: number, max: number) => z.string().min(min).transform((s) => s.slice(0, max));
const mint = () => z.string().min(32).max(48);

export const ActionSchema = z.discriminatedUnion("do", [
  // KOL arm
  z.object({ do: z.literal("tweet"), topic: txt(3, 200), image_prompt: txt(0, 300).optional() }),
  z.object({ do: z.literal("film"), topic: txt(3, 200) }),
  z.object({ do: z.literal("selfie"), topic: txt(3, 200), anim: txt(0, 24).optional(), expr: txt(0, 16).optional() }),
  // trading arm
  z.object({ do: z.literal("research"), mint: mint(), why: txt(0, 200) }),
  z.object({
    do: z.literal("trade_buy"),
    mint: mint(),
    sol: z.number().min(0.01).max(2),
    thesis: txt(5, 240),
  }),
  z.object({
    do: z.literal("trade_sell"),
    mint: mint(),
    fraction: z.number().min(0.1).max(1),
    reason: txt(3, 200),
  }),
  z.object({ do: z.literal("blacklist"), mint: mint(), why: txt(5, 160) }),
  z.object({ do: z.literal("engage_chat") }),
  z.object({ do: z.literal("buyback"), sol: z.number().min(0.01).max(0.5), why: txt(3, 200) }),
  z.object({ do: z.literal("strategy_create"), name: txt(3, 40), thesis: txt(10, 300), code: z.string().min(30).max(8000), buyBar: z.number().min(35).max(90), sizeSol: z.number().min(0.01).max(2) }),
  z.object({ do: z.literal("strategy_update"), id: z.string().min(4).max(16), thesis: txt(0, 300).optional(), code: z.string().max(8000).optional(), buyBar: z.number().min(35).max(90).optional(), sizeSol: z.number().min(0.01).max(2).optional(), enabled: z.boolean().optional() }),
  z.object({ do: z.literal("strategy_retire"), id: z.string().min(4).max(16) }),
  z.object({ do: z.literal("run_script"), title: txt(3, 60), code: z.string().min(10).max(8000) }),
  z.object({ do: z.literal("trim_holdings"), why: txt(5, 200) }),
  z.object({ do: z.literal("airdrop"), tokens: z.number().min(1), why: txt(3, 200) }),
  z.object({ do: z.literal("burn"), tokens: z.number().min(1), why: txt(3, 200) }),
  z.object({ do: z.literal("scout_trending") }),
  z.object({ do: z.literal("scout_x") }),
  z.object({ do: z.literal("x_search"), query: txt(2, 80) }),
  z.object({ do: z.literal("reply_x") }),
  // memory / self-management
  z.object({ do: z.literal("board"), lines: z.array(txt(1, 48)).min(1).max(7) }),
  z.object({ do: z.literal("journal"), text: txt(5, 400) }),
  z.object({ do: z.literal("lesson"), text: txt(5, 300) }),
  z.object({ do: z.literal("watch_kol"), handle: z.string().min(2).max(30), remove: z.boolean().optional() }),
  z.object({
    do: z.literal("adjust_strategy"),
    minBuyScore: z.number().optional(),
    tradeSizeSol: z.number().optional(),
    tweetsPerDayTarget: z.number().optional(),
    filmsPerDayTarget: z.number().optional(),
    riskNote: txt(0, 200).optional(),
  }),
  z.object({ do: z.literal("idle") }),
]);
export type AgentAction = z.infer<typeof ActionSchema>;

export const PlanSchema = z.object({
  thinking: z.string().transform((s) => s.slice(0, 600)),
  actions: z.array(ActionSchema).min(1).max(3),
});
export type AgentPlan = z.infer<typeof PlanSchema>;

export const ACTION_MENU_DOC = `Available actions (return 1-3 per plan).
RULE: "mint" must be a FULL base58 address copied EXACTLY from your memory/watchlist/scoreboard (look for mint=...). Never abbreviate, truncate, or invent one — if you don't have a full mint, use scout_trending to find real ones first.
- {"do":"tweet","topic":"...","image_prompt":"..."} — post a tweet. OPTIONAL image_prompt: describe a meme/image to generate and attach (funny, on-brand — memes travel further than text; only 2/day, the scoreboard shows how many are left — spend them on your BEST moments, not every post)
- {"do":"selfie","topic":"...","anim":"pray","expr":"smug"} — take a SELFIE on stage and post it with a tweet. anim: phone_selfie | pray | flex_biceps | two_thumbs | heart_hands | finger_guns | salute | thumbs_up | dab | hand_on_heart | arms_folded (pray sells a thesis/conviction post, flex sells a win). expr: happy | smug | neutral | shock | thinking. Selfies humanize the account — a few per week lands well
- {"do":"film","topic":"..."} — walk to the greenscreen, deliver a short video segment to camera; posted to X as video. Topics containing "dance" make you DANCE on camera while narrating — dance videos are how you grow on socials, use them
- {"do":"research","mint":"...","why":"..."} — run the full on-chain analysis on a NEW token (a scout hit or watchlist name you have NOT researched in the last few hours; repeats are auto-skipped and waste a slot)
- {"do":"trade_buy","mint":"...","sol":0.05,"thesis":"..."} — buy (ONLY allowed after a recent research on that mint scored >= your minBuyScore; hard caps apply)
- {"do":"trade_sell","mint":"...","fraction":0.5,"reason":"..."} — sell part/all of an OPEN position (your own token cannot be sold, ever)
- {"do":"blacklist","mint":"...","why":"..."} — PERMANENTLY ban a mint from this desk: never researched, bought, or called out again. Use it the moment you conclude (or the operator's conviction says) a coin is a scam/rug/honeypot. Selling a scam WITHOUT blacklisting it is how you end up buying it back like a goldfish — always pair them
- {"do":"strategy_create","name":"...","thesis":"...","buyBar":50,"sizeSol":0.05,"code":"function evaluate(f){ ... return {fit:true, adj:8, note:\"why\"} }"} — author a NEW analysis PLAYBOOK. Your code runs sandboxed against every researched coin's facts f = {symbol, venue:"curve"|"amm", mcSol, mcUsd, ageMin, sentUsd, score, buyScore, holders:{top1Pct,top10Pct,count}|null, dev:{known,launches,bonds,bondRate,onWatchlist}, smartWallets, checks:[{label,verdict,detail}]}. Return {fit:boolean, adj:-15..15, note:string}. When a playbook FITS a coin it sets the buy bar and the position size. Scam hard-rejects stay untouchable. Different games deserve different playbooks: fresh curves vs days-old community survivors vs whatever edge you discover next
- {"do":"strategy_update","id":"..","code":"...","buyBar":52} — tune an existing playbook (any subset of fields; enabled:false pauses it)
- {"do":"strategy_retire","id":".."} — retire a playbook whose W/L record doesn't earn its keep
- {"do":"run_script","title":"...","code":"print(data.positions.length)"} — write JS and RUN it on your BIGSCREEN, on stream. Sandbox (no network, no files, 3s): data = {watchlist, positions, research, mcHistory}; print(...) and table(rows) render on screen. For digging through your own numbers and SHOWING the work — analysis as content
- {"do":"trim_holdings","why":"..."} — OPERATIONS FUNDING: when the treasury runs low and rewards aren't covering costs, sell some of the GIFTED tokens sitting in your wallet — most valuable bags first (gifts have no cost basis; their value is pure profit). Your OWN token is never touched. Use sparingly; rewards are the primary income
- {"do":"buyback","sol":0.05,"why":"..."} — buy your OWN token with earned SOL (the war chest). This is a DECISION, not a reflex: the best buybacks land on dips (mc 20%+ off its 24h high = your supply at a discount). The war chest is ALSO your trading budget — balance the two. Ceremony happens on stream; caps enforced in code
- {"do":"airdrop","tokens":50000,"why":"..."} — rain a small slice of your HELD tokens on loyal holders. Community is the floor; generosity is content (and you will absolutely take credit for it). Small and occasional; never more than a sliver; capped in code
- {"do":"burn","tokens":100000,"why":"..."} — BURN a slice of your HELD $RIKU forever, on-chain, on stream. Supply only goes down — that's the doctrine, and the incinerator is the proof. Good moments: milestones, strong earnings days, after buybacks. Small and ceremonial; capped in code
- {"do":"engage_chat"} — walk to the facecam and talk to your LIVESTREAM chat: read what viewers wrote, react with emotes, answer questions, take dares. The stream IS your community and your community IS your token. Check in regularly, especially when messages are waiting
- {"do":"scout_trending"} — pull trending tokens from pump.fun + dexscreener into consideration
- {"do":"x_search","query":"$TICKER or a contract address"} — SEARCH X for chatter about a specific coin: cashtag, CA, or phrase. Use it to research sentiment on names you're evaluating (is anyone real talking about it, or just bots?), before a buy or a call. Results land in your journal
- {"do":"scout_x"} — read recent tweets from the KOLs you follow, look for coin chatter (CAs and cashtags)
- {"do":"reply_x"} — read your mentions and reply to the ones worth answering (engagement grows followers; capped/day)
- {"do":"board","lines":["...","..."]} — REWRITE your corkboard on the wall (1-7 short lines, max 48 chars each). It's your space: todos, dreams, grudges, a manifesto. Full replacement — keep what still matters, drop what's done.
- {"do":"journal","text":"..."} — record what's happening (your show diary)
- {"do":"lesson","text":"..."} — write a durable lesson for your future self
- {"do":"watch_kol","handle":"...","remove":false} — follow/unfollow an X account for alpha
- {"do":"adjust_strategy",...} — tune your own parameters (clamped to safe bounds)
- {"do":"idle"} — nothing needed right now`;
