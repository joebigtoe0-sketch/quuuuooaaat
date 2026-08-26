/* RIKU PNL Replay — canvas trade-replay video generator */
'use strict';

// ---------------------------------------------------------------- dom
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
const elStatus = $('status'), elSummary = $('summary');

// ---------------------------------------------------------------- RIKU palette + type
const C = {
  ink: '#100f0a', bg0: '#0a0a08', bg1: '#181712',
  cream: '#f4ecca', cream60: 'rgba(244,236,202,0.6)', cream35: 'rgba(244,236,202,0.35)',
  grid: 'rgba(244,236,202,0.09)',
  signal: '#ffc21a', acid: '#e8b62e',
  buy: '#3ddc78', sell: '#ff3a24',
  card: '#131209',
};
const DISP = "Anton, 'Arial Narrow', Impact, sans-serif";
const LAB = "Consolas, 'Cascadia Mono', monospace";
document.fonts.load("100px Anton").catch(() => {});

// ---------------------------------------------------------------- utils
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutExpo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
const easeOutBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

function fmtUsd(n, dec) {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (a >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(dec ?? 2);
}
function fmtSigned(n) { return (n >= 0 ? '+' : '-') + fmtUsd(Math.abs(n)); }
function fmtSol(n) { return (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)) + ' SOL'; }
function fmtPct(n) { return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%'; }
function fmtMc(price) { return fmtUsd(price * 1e9); } // pump.fun supply = 1B
function fmtTime(t, spanMs) {
  const d = new Date(t);
  if (spanMs > 48 * 3600e3) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  return d.toTimeString().slice(0, 5);
}
function shortAddr(a) { return a.slice(0, 4) + '…' + a.slice(-4); }
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let z = Math.imul(seed ^ seed >>> 15, 1 | seed);
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
  };
}
const IV_MS = { '1s': 1e3, '15s': 15e3, '30s': 30e3, '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 36e5, '4h': 144e5, '6h': 216e5, '12h': 432e5 };

// ---------------------------------------------------------------- state
const cfg = { durMs: 20000, aspect: '9:16', videoAudio: false };
let model = null;
let playing = false, playT0 = 0, lastFrameT = 0, playGen = 0, cueIdx = 0;
let smooth = { yMax: 0, yMin: 0, pnl: 0 };
let recorder = null, recChunks = [];
let chartBgImg = null, cardBgImg = null;
let xUser = '', xPfpImg = null;

const ASPECTS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const INTRO = 2400, CARD_IN = 900, CARD_HOLD = 6000;
const totalMs = () => INTRO + cfg.durMs + CARD_IN + CARD_HOLD;

// ---------------------------------------------------------------- audio (kha-ching + music)
let AC = null, masterGain = null, audioDest = null;
let musicBuf = null, musicSrc = null, musicGain = null;
function ensureAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = AC.createGain();
  masterGain.gain.value = 0.85;
  masterGain.connect(AC.destination);
  audioDest = AC.createMediaStreamDestination();
  masterGain.connect(audioDest);
}
function startMusic() {
  if (!musicBuf || !AC) return;
  stopMusic();
  musicGain = AC.createGain();
  musicGain.gain.value = 0.45; // under the chings
  const end = AC.currentTime + totalMs() / 1000;
  musicGain.gain.setValueAtTime(0.45, end - 1.1);
  musicGain.gain.linearRampToValueAtTime(0.0001, end); // fade out on the card
  musicSrc = AC.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.loop = true;
  musicSrc.connect(musicGain);
  musicGain.connect(masterGain);
  musicSrc.start();
}
function stopMusic() {
  if (musicSrc) { try { musicSrc.stop(); } catch {} musicSrc = null; }
}

// route a bg-video's soundtrack into the master graph (speakers + recording).
// createMediaElementSource is once-per-element, so mark the element; the
// muted flag then acts as the on/off switch for the routed audio.
function routeVideoAudio(v) {
  if (v._routed || !AC) return;
  try {
    const g = AC.createGain();
    g.gain.value = 0.9;
    AC.createMediaElementSource(v).connect(g);
    g.connect(masterGain);
    v._routed = true;
  } catch {}
}

function sfx(kind) {
  if (!AC) return;
  if (AC.state === 'suspended') AC.resume();
  const t = AC.currentTime + 0.01;
  if (kind === 'boom') { // multiplier slam: sub drop
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.45);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g); g.connect(masterGain); o.start(t); o.stop(t + 0.55);
    return;
  }
  // kha-ching: register click + two-note bell
  const nLen = Math.floor(AC.sampleRate * 0.05);
  const nBuf = AC.createBuffer(1, nLen, AC.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nLen; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 2);
  const src = AC.createBufferSource(); src.buffer = nBuf;
  const ng = AC.createGain(); ng.gain.value = 0.35;
  src.connect(ng); ng.connect(masterGain); src.start(t);

  const notes = kind === 'buy' ? [1046.5, 1568.0] : [932.3, 1396.9];
  notes.forEach((f, i) => {
    const t0 = t + 0.03 + i * 0.085;
    for (const [mult, vol] of [[1, 0.5], [2.01, 0.12]]) { // fundamental + shimmer partial
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'sine'; o.frequency.value = f * mult;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g); g.connect(masterGain); o.start(t0); o.stop(t0 + 0.55);
    }
  });
}

// ---------------------------------------------------------------- data
// the RIKU server reboots now and then; Railway answers 502 with an HTML page
// during those windows — retry through them instead of choking on '<!DOCTYPE'
async function fetchReplay(mint, wallet) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`api/replay?mint=${encodeURIComponent(mint)}&wallet=${encodeURIComponent(wallet)}`);
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    if (r.ok && data) return data;
    if (data && data.error) throw new Error(data.error); // real API error — no point retrying
    if (i < 3) {
      setStatus(`desk is rebooting (${r.status}) — retrying ${i + 1}/3…`);
      await new Promise(s => setTimeout(s, 2500 * (i + 1)));
    }
  }
  throw new Error('server unavailable — try again in a minute');
}

// resolve the X handle's pfp (best-effort, capped so it never stalls the load)
async function loadXIdentity() {
  xUser = $('xuser').value.trim().replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
  xPfpImg = null;
  if (!xUser) return;
  await new Promise(resolve => {
    const im = new Image();
    const done = setTimeout(() => resolve(), 4000);
    im.onload = () => { xPfpImg = im; clearTimeout(done); resolve(); };
    im.onerror = () => { clearTimeout(done); resolve(); };
    im.src = 'api/xpfp?u=' + encodeURIComponent(xUser);
  });
}

async function load() {
  const mint = $('mint').value.trim(), wallet = $('wallet').value.trim();
  if (!mint || !wallet) return setStatus('need both addresses', true);
  setStatus('fetching trades + chart…');
  $('load').disabled = true;
  try {
    const [data] = await Promise.all([fetchReplay(mint, wallet), loadXIdentity()]);
    await document.fonts.load("100px Anton").catch(() => {});
    model = buildModel(data, wallet);
    setStatus(`${model.meta.symbol}: ${model.rawTrades.length} fills → ${model.events.length} events, ${data.candles.length} candles (${data.interval})`);
    renderSummary();
    $('play').disabled = $('rec').disabled = $('png').disabled = false;
    ensureAudio();
    play();
  } catch (e) {
    setStatus(String(e.message || e), true);
  } finally { $('load').disabled = false; }
}

function buildModel(data, wallet) {
  const { t0, tEnd } = data.range;
  const trades = data.trades;
  const span = tEnd - t0;
  const ivMs = IV_MS[data.interval] || 60e3;

  // price series: candle closes + exact trade fills, merged
  let pts = data.candles.map(c => ({ t: clamp(c.t, t0, tEnd), p: c.c }));
  for (const tr of trades) pts.push({ t: tr.t, p: tr.priceUsd });
  pts.sort((a, b) => a.t - b.t);
  if (!pts.length) pts = [{ t: t0, p: trades[0].priceUsd }];
  if (pts[0].t > t0) pts.unshift({ t: t0, p: pts[0].p });
  if (pts[pts.length - 1].t < tEnd) pts.push({ t: tEnd, p: pts[pts.length - 1].p });

  // running extremes for the adaptive camera
  let mx = 0, mn = Infinity;
  const runMax = [], runMin = [];
  for (const pt of pts) { mx = Math.max(mx, pt.p); mn = Math.min(mn, pt.p); runMax.push(mx); runMin.push(mn); }

  // cumulative position after each raw fill (live pnl)
  let inv = 0, rec = 0, tok = 0;
  const cum = trades.map(tr => {
    if (tr.type === 'buy') { inv += tr.usd; tok += tr.tokens; }
    else { rec += tr.usd; tok -= tr.tokens; }
    return { t: tr.t, inv, rec, tok };
  });

  // display events: merge fills of the same type in the same tx or close together
  const events = [];
  const mergeGap = Math.max(span * 0.004, ivMs);
  for (const tr of trades) {
    const last = events[events.length - 1];
    if (last && last.type === tr.type && (last.tx === tr.tx || tr.t - last.tEndRaw < mergeGap)) {
      last.usd += tr.usd; last.sol += tr.sol;
      last.price = (last.price * last.tokens + tr.priceUsd * tr.tokens) / (last.tokens + tr.tokens || 1);
      last.tokens += tr.tokens; last.tEndRaw = tr.t;
    } else {
      events.push({ t: tr.t, tEndRaw: tr.t, type: tr.type, usd: tr.usd, sol: tr.sol, tokens: tr.tokens, price: tr.priceUsd, tx: tr.tx });
    }
  }

  const finalPrice = pts[pts.length - 1].p;
  const invested = inv, received = rec, tokensLeft = Math.max(0, tok);
  const holdingsUsd = tokensLeft * finalPrice;
  const dust = holdingsUsd < 1;
  const netUsd = received + (dust ? 0 : holdingsUsd) - invested;
  const investedSol = trades.filter(t => t.type === 'buy').reduce((s, t) => s + t.sol, 0);
  const receivedSol = trades.filter(t => t.type === 'sell').reduce((s, t) => s + t.sol, 0);

  const m = {
    meta: data.meta, wallet, t0, tEnd, span, pts, runMax, runMin, cum, events,
    rawTrades: trades, solPrice: data.solPrice, ivMs,
    totals: {
      invested, received, investedSol, receivedSol,
      tokensLeft: dust ? 0 : tokensLeft, holdingsUsd: dust ? 0 : holdingsUsd,
      netUsd, roi: invested > 0 ? netUsd / invested * 100 : 0,
      buys: trades.filter(t => t.type === 'buy').length,
      sells: trades.filter(t => t.type === 'sell').length,
      oversold: tok < -1,
    },
    img: null,
  };

  buildWarp(m);
  buildCues(m);

  if (data.meta.image) {
    const im = new Image();
    im.onload = () => { m.img = im; if (!playing) renderFrame(lastFrameT); };
    im.src = 'api/img?u=' + encodeURIComponent(data.meta.image);
  }
  return m;
}

// ---- time-warp: whole token life fits the replay, but trading moments play slow
// and dead stretches fast-forward. Piecewise-linear map tokenTime <-> videoTime.
function buildWarp(m) {
  const { t0, tEnd, span, events, ivMs } = m;
  const hw = Math.max(span * 0.008, ivMs * 2); // half-width of a "slow-mo" window
  const wins = [];
  for (const ev of events) {
    const a = clamp(ev.t - hw, t0, tEnd), b = clamp(ev.tEndRaw + hw, t0, tEnd);
    const last = wins[wins.length - 1];
    if (last && a <= last.b) { last.b = Math.max(last.b, b); last.n += 1; }
    else wins.push({ a, b, n: 1 });
  }
  // alternating idle/active segments over [t0, tEnd]
  const segs = [];
  let cur = t0;
  for (const w of wins) {
    if (w.a > cur) segs.push({ tk0: cur, tk1: w.a, active: false, n: 0 });
    segs.push({ tk0: w.a, tk1: w.b, active: true, n: w.n });
    cur = w.b;
  }
  if (cur < tEnd) segs.push({ tk0: cur, tk1: tEnd, active: false, n: 0 });

  const idleLen = segs.filter(s => !s.active).reduce((s, x) => s + (x.tk1 - x.tk0), 0);
  const nEvents = Math.max(1, events.length);
  // more trades → more of the video (and screen width) spent in slow-mo
  const activeShare = idleLen > 0 ? clamp(0.25 + 0.06 * nEvents, 0.3, 0.6) : 1;
  let v = 0;
  for (const s of segs) {
    const share = s.active
      ? activeShare * (s.n / nEvents)
      : (1 - activeShare) * ((s.tk1 - s.tk0) / (idleLen || 1));
    s.v0 = v; v += share; s.v1 = v;
  }
  for (const s of segs) { s.v0 /= v; s.v1 /= v; } // normalize to [0,1]
  m.segs = segs;
}
function tokenAtVideo(frac) { // frac 0..1 of replay -> token time
  const segs = model.segs;
  frac = clamp(frac, 0, 1);
  let lo = 0, hi = segs.length - 1;
  while (hi - lo > 0) { const mid = (lo + hi) >> 1; (segs[mid].v1 < frac ? lo = mid + 1 : hi = mid); }
  const s = segs[lo];
  return lerp(s.tk0, s.tk1, (frac - s.v0) / (s.v1 - s.v0 || 1));
}
function videoAtToken(t) { // token time -> ms on the replay clock
  const segs = model.segs;
  t = clamp(t, model.t0, model.tEnd);
  let lo = 0, hi = segs.length - 1;
  while (hi - lo > 0) { const mid = (lo + hi) >> 1; (segs[mid].tk1 < t ? lo = mid + 1 : hi = mid); }
  const s = segs[lo];
  return lerp(s.v0, s.v1, (t - s.tk0) / (s.tk1 - s.tk0 || 1)) * cfg.durMs;
}

// ---- cues: trade pops + price-multiple slams, with sounds
function buildCues(m) {
  const cues = m.events.map((ev, i) => ({ kind: ev.type, ev, i, t: ev.t }));
  // multiplier milestones vs the wallet's first entry
  const base = m.events[0].price;
  const seen = new Set();
  for (const th of [2, 3, 5, 10, 20, 50, 100, 500, 1000]) {
    for (const pt of m.pts) {
      if (pt.t <= m.events[0].t) continue;
      if (pt.p >= base * th) { cues.push({ kind: 'boom', mult: th, t: pt.t }); seen.add(th); break; }
    }
  }
  cues.sort((a, b) => a.t - b.t);
  m.cues = cues;
}
function cueVidT(cue) { return videoAtToken(cue.t); }

// ---------------------------------------------------------------- series lookups
function priceAt(t) {
  const p = model.pts;
  let lo = 0, hi = p.length - 1;
  if (t <= p[0].t) return p[0].p;
  if (t >= p[hi].t) return p[hi].p;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (p[mid].t <= t ? lo = mid : hi = mid); }
  const a = p[lo], b = p[hi];
  return lerp(a.p, b.p, (t - a.t) / (b.t - a.t || 1));
}
function idxAt(t) {
  const p = model.pts;
  let lo = 0, hi = p.length - 1;
  if (t >= p[hi].t) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (p[mid].t <= t ? lo = mid : hi = mid); }
  return lo;
}
function positionAt(t) {
  const c = model.cum;
  let lo = -1, hi = c.length - 1;
  if (!c.length || t < c[0].t) return { inv: 0, rec: 0, tok: 0 };
  if (t >= c[hi].t) return c[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (c[mid].t <= t ? lo = mid : hi = mid); }
  return c[lo];
}

// ---------------------------------------------------------------- layout
function layout() {
  const W = cv.width, H = cv.height;
  const u = Math.min(W, H) / 1080;
  const vert = cfg.aspect === '9:16';
  const chart = {
    x: W * 0.075, w: W * 0.85,
    y: H * (vert ? 0.30 : 0.34),
    h: H * (vert ? 0.48 : 0.46),
  };
  return { W, H, u, chart, vert };
}

// small helper: letter-spaced Consolas label
function labText(txt, x, y, sizePx, color, align, spacingPx) {
  ctx.save();
  ctx.font = `700 ${Math.round(sizePx)}px ${LAB}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(spacingPx ?? sizePx * 0.22).toFixed(1)}px`;
  ctx.fillStyle = color; ctx.textAlign = align || 'left';
  ctx.fillText(txt, x, y);
  ctx.restore();
}

// pfp circle + @handle, centered on (cx, cy) as one unit
function drawIdentityRow(cx, cy, r, fontPx, color) {
  const text = '@' + xUser;
  ctx.save();
  ctx.font = `700 ${Math.round(fontPx)}px ${LAB}`;
  const tw = ctx.measureText(text).width;
  const gap = r * 0.55;
  const left = cx - (r * 2 + gap + tw) / 2;
  // avatar (or monogram circle if the pfp didn't resolve)
  ctx.beginPath(); ctx.arc(left + r, cy, r, 0, 7); ctx.closePath();
  ctx.strokeStyle = C.signal; ctx.lineWidth = Math.max(2, r * 0.09); ctx.stroke();
  ctx.save();
  ctx.clip();
  if (xPfpImg) ctx.drawImage(xPfpImg, left, cy - r, r * 2, r * 2);
  else {
    ctx.fillStyle = '#221f10'; ctx.fillRect(left, cy - r, r * 2, r * 2);
    ctx.fillStyle = C.signal; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `400 ${Math.round(r * 1.1)}px ${DISP}`;
    ctx.fillText(xUser[0].toUpperCase(), left + r, cy + r * 0.06);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  ctx.font = `700 ${Math.round(fontPx)}px ${LAB}`;
  ctx.textAlign = 'left'; ctx.fillStyle = color;
  ctx.fillText(text, left + r * 2 + gap, cy + fontPx * 0.35);
  ctx.restore();
}

function drawCover(img, x, y, w, h) {
  // works for <img> and <video> alike
  const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ---------------------------------------------------------------- master render
function renderFrame(t) {
  lastFrameT = t;
  const L = layout();
  drawBackdrop(L, t);

  let scene = 'replay';
  if (t < INTRO) {
    scene = 'intro';
    drawIntro(L, t / INTRO);
  } else if (t < INTRO + cfg.durMs) {
    drawReplay(L, (t - INTRO) / cfg.durMs, t);
  } else {
    scene = 'card';
    drawReplay(L, 1, t, true);
    const ct = t - INTRO - cfg.durMs;
    drawCard(L, clamp(ct / CARD_IN, 0, 1), ct);
  }
  drawWatermark(L, scene);
}

function drawBackdrop(L, t) {
  const { W, H } = L;
  if (chartBgImg) {
    drawCover(chartBgImg, 0, 0, W, H);
    ctx.fillStyle = 'rgba(10,10,8,0.78)';
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, C.bg1); g.addColorStop(1, C.bg0);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  // drifting dot grid
  const s = 64 * L.u, off = (t * 0.004) % s;
  ctx.fillStyle = 'rgba(244,236,202,0.045)';
  for (let x = -off; x < W; x += s) for (let y = -off; y < H; y += s) ctx.fillRect(x, y, 2, 2);
}

// ---------------------------------------------------------------- intro
function drawIntro(L, k) {
  const { W, H, u } = L;
  const cx = W / 2, cy = H * (L.vert ? 0.40 : 0.42);
  const a1 = clamp(k / 0.35, 0, 1), a2 = clamp((k - 0.2) / 0.35, 0, 1), a3 = clamp((k - 0.4) / 0.35, 0, 1);

  const R = 120 * u * easeOutBack(clamp(a1, 0.001, 1));
  drawTokenImage(cx, cy - 130 * u, Math.max(R, 0.001), a1);

  ctx.textAlign = 'center';
  ctx.globalAlpha = a2;
  ctx.fillStyle = C.cream;
  ctx.font = `400 ${Math.round(96 * u)}px ${DISP}`;
  ctx.fillText(model.meta.name.toUpperCase().slice(0, 16), cx, cy + 105 * u);
  ctx.fillStyle = C.signal;
  ctx.font = `400 ${Math.round(52 * u)}px ${DISP}`;
  ctx.fillText('$' + model.meta.symbol.toUpperCase(), cx, cy + 172 * u);

  ctx.globalAlpha = a3;
  labText('T R A D E   R E P L A Y', cx, cy + 245 * u, 28 * u, C.acid, 'center', 8 * u);
  if (xUser) {
    drawIdentityRow(cx, cy + 310 * u, 26 * u, 26 * u, C.cream);
    labText(shortAddr(model.wallet), cx, cy + 372 * u, 20 * u, C.cream60, 'center', 3 * u);
  } else {
    labText(shortAddr(model.wallet), cx, cy + 292 * u, 22 * u, C.cream60, 'center', 3 * u);
  }
  ctx.globalAlpha = 1;
}

function drawTokenImage(x, y, r, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.closePath();
  ctx.strokeStyle = C.signal; ctx.lineWidth = Math.max(3, r * 0.045); ctx.stroke();
  ctx.clip();
  if (model.img) ctx.drawImage(model.img, x - r, y - r, r * 2, r * 2);
  else {
    ctx.fillStyle = '#221f10'; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = C.signal; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `400 ${Math.round(r * 1.1)}px ${DISP}`;
    ctx.fillText(model.meta.symbol[0] || '?', x, y + r * 0.06);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

// ---------------------------------------------------------------- replay
// impulse from recent cues → screen shake / zoom punch / flash
function impulseAt(replayT) {
  let amt = 0, flash = 0;
  for (const cue of model.cues) {
    const age = replayT - cueVidT(cue);
    if (age < 0 || age > 460) continue;
    const k = Math.pow(1 - age / 460, 2);
    amt += k * (cue.kind === 'boom' ? 1.5 : 1);
    if (age < 180) flash += (1 - age / 180) * (cue.kind === 'boom' ? 0.32 : 0.22);
  }
  return { amt: Math.min(amt, 2.2), flash: Math.min(flash, 0.4) };
}

function drawReplay(L, prog, masterT, frozen) {
  const { W, H, u, chart } = L;
  const { t0, tEnd, span, pts } = model;
  prog = clamp(prog, 0, 1);
  const tCur = frozen ? tEnd : tokenAtVideo(prog);
  const replayT = masterT - INTRO;

  // LMG-vibe camera hit
  const imp = frozen ? { amt: 0, flash: 0 } : impulseAt(replayT);
  ctx.save();
  if (imp.amt > 0.01) {
    const a = imp.amt;
    const dx = Math.sin(replayT * 0.11) * 9 * u * a, dy = Math.cos(replayT * 0.137) * 7 * u * a;
    ctx.translate(W / 2 + dx, H / 2 + dy);
    ctx.scale(1 + 0.028 * a, 1 + 0.028 * a);
    ctx.translate(-W / 2, -H / 2);
  }

  const i = idxAt(tCur);
  const tgtMax = model.runMax[i] * 1.15, tgtMin = model.runMin[i] * 0.82;
  if (!smooth.yMax) { smooth.yMax = tgtMax; smooth.yMin = tgtMin; }
  const k = frozen ? 1 : 0.12;
  smooth.yMax = lerp(smooth.yMax, tgtMax, k);
  smooth.yMin = lerp(smooth.yMin, tgtMin, k);
  // x follows the VIDEO clock, not token time: the tip sweeps at constant speed,
  // trade windows get stretched wide, dead stretches compress (the time-warp).
  const X = t => chart.x + videoAtToken(t) / cfg.durMs * chart.w;
  const Y = p => chart.y + chart.h - (p - smooth.yMin) / (smooth.yMax - smooth.yMin || 1) * chart.h;

  drawHeader(L, tCur);
  drawGrid(L, X, Y);

  // price path
  let tipX = X(tCur), tipY = Y(priceAt(tCur));
  const tracePath = () => {
    ctx.beginPath();
    let started = false;
    for (let j = 0; j <= i; j++) {
      const px = X(pts[j].t), py = Y(pts[j].p);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true;
    }
    ctx.lineTo(tipX, tipY);
  };
  tracePath();
  ctx.lineTo(tipX, chart.y + chart.h); ctx.lineTo(chart.x, chart.y + chart.h); ctx.closePath();
  const fill = ctx.createLinearGradient(0, chart.y, 0, chart.y + chart.h);
  fill.addColorStop(0, 'rgba(255,194,26,0.26)'); fill.addColorStop(1, 'rgba(255,194,26,0)');
  ctx.fillStyle = fill; ctx.fill();
  tracePath();
  ctx.strokeStyle = C.signal; ctx.lineWidth = 3.5 * u; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(255,194,26,0.5)'; ctx.shadowBlur = 14 * u;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // pulsing tip
  if (!frozen) {
    const pulse = 1 + 0.25 * Math.sin(masterT / 140);
    ctx.fillStyle = C.signal;
    ctx.beginPath(); ctx.arc(tipX, tipY, 7 * u * pulse, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,194,26,0.22)';
    ctx.beginPath(); ctx.arc(tipX, tipY, 16 * u * pulse, 0, 7); ctx.fill();
  }

  // trade markers
  for (const ev of model.events) {
    const evVidT = videoAtToken(ev.t);
    if (evVidT > replayT && !frozen) continue;
    const age = frozen ? 1e9 : replayT - evVidT;
    drawMarker(L, X(clamp(ev.t, t0, tEnd)), Y(ev.price), ev, age);
  }

  drawPnlBadge(L, tCur, frozen);

  if (!frozen) {
    drawMultSlams(L, replayT);
    drawEventPops(L, replayT);
  }
  ctx.restore();

  // impact flash on top of everything
  if (imp.flash > 0.01) {
    ctx.fillStyle = `rgba(244,236,202,${imp.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawHeader(L, tCur) {
  const { u, vert } = L;
  const topY = (vert ? 100 : 64) * u;
  const r = 34 * u, ix = 64 * u + r;
  drawTokenImage(ix, topY, r, 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.cream;
  ctx.font = `400 ${Math.round(44 * u)}px ${DISP}`;
  ctx.fillText('$' + model.meta.symbol.toUpperCase(), ix + r + 18 * u, topY + 6 * u);
  labText(model.meta.name.toUpperCase().slice(0, 22), ix + r + 20 * u, topY + 34 * u, 16 * u, C.cream60, 'left', 3 * u);
  labText('MARKET CAP', L.W - 64 * u, topY - 16 * u, 16 * u, C.acid, 'right', 4 * u);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.signal;
  ctx.font = `400 ${Math.round(52 * u)}px ${DISP}`;
  ctx.fillText(fmtMc(priceAt(tCur)), L.W - 64 * u, topY + 40 * u);
}

function drawPnlBadge(L, tCur, frozen) {
  const { W, u, chart } = L;
  const pos = positionAt(tCur);
  const unreal = Math.max(0, pos.tok) * priceAt(tCur);
  const pnl = pos.rec + unreal - pos.inv;
  smooth.pnl = frozen ? pnl : lerp(smooth.pnl, pnl, 0.15);
  const shown = Math.abs(smooth.pnl) < 0.005 ? 0 : smooth.pnl;
  const col = shown >= 0 ? C.buy : C.sell;
  const y = chart.y - 40 * u;
  labText('LIVE PNL', W / 2, y - 58 * u, 20 * u, C.acid, 'center', 6 * u);
  ctx.textAlign = 'center';
  ctx.fillStyle = col;
  ctx.font = `400 ${Math.round(78 * u)}px ${DISP}`;
  ctx.fillText(fmtSigned(shown), W / 2, y + 14 * u);
}

function drawGrid(L, X, Y) {
  const { u, chart } = L;
  const { t0, span } = model;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const p = smooth.yMin + (smooth.yMax - smooth.yMin) * i / 3;
    const y = Y(p);
    if (y < chart.y - 4 || y > chart.y + chart.h + 4) continue;
    ctx.beginPath(); ctx.moveTo(chart.x, y); ctx.lineTo(chart.x + chart.w, y); ctx.stroke();
    labText(fmtMc(p), chart.x + 6 * u, y - 8 * u, 17 * u, C.cream35, 'left', 1.5 * u);
  }
  // time ticks at fixed screen positions, labeled with the warped token time there
  for (let i = 0; i <= 2; i++) {
    const t = tokenAtVideo(i / 2);
    labText(fmtTime(t, model.span), chart.x + chart.w * i / 2, chart.y + chart.h + 34 * u, 17 * u, C.cream35, 'center', 1.5 * u);
  }
}

function drawMarker(L, x, y, ev, age) {
  const { u } = L;
  const buy = ev.type === 'buy';
  const col = buy ? C.buy : C.sell;
  const s = 15 * u * (age < 400 ? easeOutBack(clamp(age / 400, 0.001, 1)) : 1);
  if (age < 900) {
    const k = age / 900;
    ctx.strokeStyle = col; ctx.globalAlpha = (1 - k) * 0.8; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.arc(x, y, 12 * u + k * 55 * u, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (buy) { ctx.moveTo(0, -s); ctx.lineTo(s * 0.95, s * 0.7); ctx.lineTo(-s * 0.95, s * 0.7); }
  else { ctx.moveTo(0, s); ctx.lineTo(s * 0.95, -s * 0.7); ctx.lineTo(-s * 0.95, -s * 0.7); }
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.strokeStyle = C.bg0; ctx.lineWidth = 3 * u;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

// BUY/SELL: raw text mid-screen, grows from invisible to huge, fast, then gone
function drawEventPops(L, replayT) {
  const { W, u, chart } = L;
  const LIFE = 820;
  model.events.forEach((ev, i) => {
    const age = replayT - videoAtToken(ev.t);
    if (age < 0 || age >= LIFE) return;
    const buy = ev.type === 'buy';
    const grow = easeOutExpo(clamp(age / 300, 0, 1));       // 0 → 1 fast
    const scale = 0.04 + grow * 1.06 + (age / LIFE) * 0.22; // keeps swelling till death
    const alpha = age < 560 ? 1 : 1 - (age - 560) / (LIFE - 560);
    const rot = (((i * 7919) % 9) - 4) * 0.012;             // deterministic slight tilt
    const cx = W / 2, cy = chart.y + chart.h * 0.42 + (i % 2 ? 40 : -30) * u;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.font = `400 ${Math.round(170 * u)}px ${DISP}`;
    const label = (buy ? 'BUY ' : 'SELL ') + fmtUsd(ev.usd);
    ctx.lineWidth = 14 * u; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(10,10,8,0.9)';
    ctx.strokeText(label, 0, 0);
    ctx.shadowColor = buy ? 'rgba(61,220,120,0.6)' : 'rgba(255,58,36,0.6)';
    ctx.shadowBlur = 30 * u;
    ctx.fillStyle = buy ? C.buy : C.sell;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

// price-multiple slams: outline-stroke Anton "10X" (landing h1 style), slams in with a boom
function drawMultSlams(L, replayT) {
  const { W, u, chart } = L;
  const LIFE = 1250;
  for (const cue of model.cues) {
    if (cue.kind !== 'boom') continue;
    const age = replayT - cueVidT(cue);
    if (age < 0 || age >= LIFE) continue;
    const slam = easeOutCubic(clamp(age / 280, 0, 1));
    const scale = lerp(2.6, 1, slam);
    const alpha = (age < 900 ? 1 : 1 - (age - 900) / 350) * clamp(age / 60, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, chart.y + chart.h * 0.22);
    ctx.rotate(-0.09);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.font = `400 ${Math.round(230 * u)}px ${DISP}`;
    ctx.lineWidth = 5 * u;
    ctx.strokeStyle = C.cream;
    ctx.fillStyle = 'rgba(244,236,202,0.07)';
    ctx.fillText(cue.mult + 'X', 0, 0);
    ctx.strokeText(cue.mult + 'X', 0, 0);
    ctx.restore();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- end card
function drawCard(L, kIn, cardT) {
  const { W, H, u } = L;
  const T = model.totals;
  const win = T.netUsd >= 0;

  ctx.fillStyle = `rgba(8,7,3,${0.75 * kIn})`;
  ctx.fillRect(0, 0, W, H);

  if (win) drawConfetti(L, cardT);

  const cw = Math.min(W * 0.86, 900 * u), chh = Math.min(990 * u, H * 0.92);
  const cx = W / 2, top = H / 2 - chh / 2 + (1 - easeOutCubic(kIn)) * 80 * u;
  const left = cx - cw / 2, right = cx + cw / 2;
  ctx.save();
  ctx.globalAlpha = kIn;

  // panel (optional uploaded backdrop, dimmed for legibility)
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40 * u;
  roundRect(left, top, cw, chh, 10 * u);
  ctx.fillStyle = C.card; ctx.fill();
  ctx.shadowBlur = 0;
  if (cardBgImg) {
    ctx.save();
    roundRect(left, top, cw, chh, 10 * u); ctx.clip();
    drawCover(cardBgImg, left, top, cw, chh);
    ctx.fillStyle = 'rgba(10,9,3,0.82)';
    ctx.fillRect(left, top, cw, chh);
    ctx.restore();
  }
  roundRect(left, top, cw, chh, 10 * u);
  ctx.strokeStyle = 'rgba(244,236,202,0.35)'; ctx.lineWidth = 1.5 * u; ctx.stroke();

  // case-file header strip
  labText('RIKU · TRADE REPLAY', left + 34 * u, top + 52 * u, 17 * u, C.acid, 'left', 5 * u);
  labText(fmtTime(model.t0, 99e9) + ' – ' + fmtTime(model.tEnd, 99e9), right - 34 * u, top + 52 * u, 15 * u, C.cream35, 'right', 3 * u);
  ctx.strokeStyle = 'rgba(244,236,202,0.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left + 30 * u, top + 72 * u); ctx.lineTo(right - 30 * u, top + 72 * u); ctx.stroke();

  drawTokenImage(cx, top + 172 * u, 62 * u, 1);
  ctx.textAlign = 'center';
  ctx.fillStyle = C.cream;
  ctx.font = `400 ${Math.round(58 * u)}px ${DISP}`;
  ctx.fillText(model.meta.name.toUpperCase().slice(0, 18), cx, top + 305 * u);
  ctx.fillStyle = C.signal;
  ctx.font = `400 ${Math.round(32 * u)}px ${DISP}`;
  ctx.fillText('$' + model.meta.symbol.toUpperCase(), cx, top + 350 * u);

  // rows
  const rowY0 = top + 425 * u, rh = 62 * u, lx = left + 50 * u, rx = right - 50 * u;
  const row = (i, label, val, valCol) => {
    const y = rowY0 + i * rh;
    labText(label, lx, y, 19 * u, C.cream60, 'left', 4 * u);
    ctx.textAlign = 'right'; ctx.fillStyle = valCol || C.cream;
    ctx.font = `700 ${Math.round(25 * u)}px ${LAB}`;
    ctx.fillText(val, rx, y);
  };
  row(0, 'BOUGHT', `${fmtUsd(T.invested)}  (${fmtSol(T.investedSol)})`);
  row(1, 'SOLD', `${fmtUsd(T.received)}  (${fmtSol(T.receivedSol)})`);
  row(2, 'STILL HOLDING', T.holdingsUsd > 0 ? fmtUsd(T.holdingsUsd) : 'fully exited', T.holdingsUsd > 0 ? C.cream : C.cream35);
  row(3, 'TRADES', `${T.buys} buys · ${T.sells} sells`);

  ctx.strokeStyle = 'rgba(244,236,202,0.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lx, rowY0 + 4 * rh - 28 * u); ctx.lineTo(rx, rowY0 + 4 * rh - 28 * u); ctx.stroke();

  // hero number
  const heroY = rowY0 + 4 * rh + 88 * u;
  const col = win ? C.buy : C.sell;
  labText('NET PROFIT', cx, heroY - 82 * u, 19 * u, C.acid, 'center', 6 * u);
  const count = easeOutCubic(clamp((cardT - 500) / 1400, 0, 1));
  ctx.textAlign = 'center';
  ctx.fillStyle = col;
  ctx.font = `400 ${Math.round(118 * u)}px ${DISP}`;
  ctx.fillText(fmtSigned(T.netUsd * count), cx, heroY + 24 * u);
  ctx.font = `400 ${Math.round(46 * u)}px ${DISP}`;
  ctx.fillText(fmtPct(T.roi * count), cx, heroY + 84 * u);

  // footer
  if (xUser) {
    drawIdentityRow(cx, top + chh - 112 * u, 20 * u, 21 * u, C.cream);
    labText(shortAddr(model.wallet), cx, top + chh - 66 * u, 17 * u, C.cream60, 'center', 3 * u);
  } else {
    labText(shortAddr(model.wallet), cx, top + chh - 66 * u, 19 * u, C.cream60, 'center', 3 * u);
  }
  labText('QUANTRIKU.FUN', cx, top + chh - 32 * u, 17 * u, C.signal, 'center', 6 * u);
  ctx.restore();
}

function drawConfetti(L, cardT) {
  const { W, H, u } = L;
  const rnd = mulberry32(1337);
  const cols = [C.signal, C.acid, C.buy, C.cream, '#ff9d90'];
  for (let i = 0; i < 110; i++) {
    const birth = rnd() * 4500, x0 = rnd() * W, vx = (rnd() - 0.5) * 0.12,
      vy = 0.18 + rnd() * 0.22, rot = rnd() * 6.28, vr = (rnd() - 0.5) * 0.01,
      col = cols[(rnd() * cols.length) | 0], sz = (6 + rnd() * 9) * u;
    const age = cardT - birth;
    if (age < 0) continue;
    const y = -20 * u + vy * age;
    if (y > H + 20) continue;
    const x = x0 + vx * age + Math.sin(age / 300 + i) * 30 * u;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot + vr * age);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = col;
    ctx.fillRect(-sz / 2, -sz / 4, sz, sz / 2);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawWatermark(L, scene) {
  const { W, H, u } = L;
  labText('RIKU — QUANTRIKU.FUN', W - 28 * u, H - 26 * u, 18 * u, 'rgba(244,236,202,0.5)', 'right', 3 * u);
  if (xUser && model && scene === 'replay') {
    // trader identity bottom-left, mirroring the watermark
    const r = 16 * u;
    ctx.save();
    ctx.font = `700 ${Math.round(18 * u)}px ${LAB}`;
    const tw = ctx.measureText('@' + xUser).width;
    drawIdentityRow(28 * u + (r * 2 + r * 0.55 + tw) / 2, H - 32 * u, r, 18 * u, 'rgba(244,236,202,0.75)');
    ctx.restore();
  }
}

// ---------------------------------------------------------------- playback
function play() {
  if (!model) return;
  applyAspect();
  ensureAudio();
  if (AC.state === 'suspended') AC.resume();
  smooth = { yMax: 0, yMin: 0, pnl: 0 };
  cueIdx = 0;
  playing = true;
  playT0 = performance.now();
  if (chartBgImg && chartBgImg.tagName === 'VIDEO') {
    try { chartBgImg.currentTime = 0; } catch {}
    routeVideoAudio(chartBgImg);
    chartBgImg.muted = !cfg.videoAudio;
    chartBgImg.play().catch(() => {});
  }
  startMusic();
  const g = ++playGen;
  requestAnimationFrame(now => tick(now, g));
}
function tick(now, g) {
  if (!playing || g !== playGen) return;
  const t = now - playT0;
  if (t >= totalMs()) {
    renderFrame(totalMs() - 1);
    playing = false;
    stopMusic();
    if (chartBgImg && chartBgImg.tagName === 'VIDEO') chartBgImg.muted = true; // keep looping, silently
    if (recorder && recorder.state === 'recording') setTimeout(stopRecording, 400);
    return;
  }
  // fire sound cues crossed since last frame
  const replayT = t - INTRO;
  while (cueIdx < model.cues.length && cueVidT(model.cues[cueIdx]) <= replayT) {
    sfx(model.cues[cueIdx].kind);
    cueIdx++;
  }
  renderFrame(t);
  requestAnimationFrame(n => tick(n, g));
}

function applyAspect() {
  const [w, h] = ASPECTS[cfg.aspect];
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

// ---------------------------------------------------------------- recording
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function record() {
  if (!model || recorder) return;
  playing = false; // interrupt any running preview; play() below restarts cleanly
  applyAspect();
  ensureAudio();
  if (AC.state === 'suspended') AC.resume();
  const stream = cv.captureStream(60);
  for (const tr of audioDest.stream.getAudioTracks()) stream.addTrack(tr);
  // record webm, then ALWAYS convert via server ffmpeg → real H.264+AAC mp4.
  // (browser-native 'video/mp4' is a trap: Chromium muxes VP9/Opus into the
  // mp4 container, which X/TikTok reject just like webm)
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14e6 });
  recChunks = [];
  recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    const name = `${model.meta.symbol}-pnl-replay`;
    recorder = null;
    $('rec').classList.remove('recording');
    $('rec').textContent = '⏺ Record .mp4';
    const webm = new Blob(recChunks, { type: 'video/webm' });
    setStatus('converting to mp4…');
    try {
      const r = await fetch('api/mp4', { method: 'POST', headers: { 'content-type': 'video/webm' }, body: webm });
      if (!r.ok) throw new Error(String(r.status));
      saveBlob(await r.blob(), `${name}.mp4`);
      setStatus('video saved ✓ (converted to mp4)');
    } catch {
      saveBlob(webm, `${name}.webm`);
      setStatus('mp4 conversion unavailable right now — saved .webm instead');
    }
  };
  recorder.start();
  $('rec').classList.add('recording');
  $('rec').textContent = '⏺ recording…';
  setStatus('recording — leave this tab visible until it finishes');
  play();
}
function stopRecording() { if (recorder && recorder.state === 'recording') recorder.stop(); }

// ---------------------------------------------------------------- ui glue
function setStatus(msg, err) {
  elStatus.textContent = msg;
  elStatus.classList.toggle('err', !!err);
}
function renderSummary() {
  const T = model.totals;
  const cls = T.netUsd >= 0 ? 'pos' : 'neg';
  elSummary.innerHTML =
    `bought <b>${fmtUsd(T.invested)}</b> · sold <b>${fmtUsd(T.received)}</b><br>` +
    (T.holdingsUsd > 0 ? `holding <b>${fmtUsd(T.holdingsUsd)}</b> (at current price)<br>` : '') +
    `net <b class="${cls}">${fmtSigned(T.netUsd)} (${fmtPct(T.roi)})</b>` +
    (T.oversold ? `<br><span class="neg">note: wallet sold more than it bought here — pnl counts only this token's trades</span>` : '');
}
function hookBgInput(id, assign) {
  $(id).addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) { assign(null); if (model && !playing) renderFrame(lastFrameT); return; }
    if (f.type.startsWith('video/')) {
      // looping muted <video>; drawImage picks up the current frame each render
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true;
      v.src = URL.createObjectURL(f);
      v.onloadeddata = () => {
        assign(v);
        if (id === 'bgChart') $('vaudWrap').hidden = false;
        v.play().catch(() => {});
        if (model && !playing) renderFrame(lastFrameT);
      };
      v.onerror = () => setStatus('could not load that video file', true);
      return;
    }
    if (id === 'bgChart') $('vaudWrap').hidden = true;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => { assign(im); if (model && !playing) renderFrame(lastFrameT); };
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
  });
}
hookBgInput('bgChart', im => { chartBgImg = im; });
hookBgInput('bgCard', im => { cardBgImg = im; });

$('vaud').onchange = e => {
  cfg.videoAudio = e.target.checked;
  if (chartBgImg && chartBgImg.tagName === 'VIDEO' && playing) chartBgImg.muted = !cfg.videoAudio;
};

$('music').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) { musicBuf = null; stopMusic(); return; }
  try {
    ensureAudio();
    musicBuf = await AC.decodeAudioData(await f.arrayBuffer());
    setStatus(`music loaded: ${f.name} (${musicBuf.duration.toFixed(0)}s, loops + fades on the card)`);
  } catch {
    musicBuf = null;
    setStatus('could not decode that audio file', true);
  }
});

$('png').onclick = async () => {
  if (!model) return;
  playing = false;
  stopMusic();
  // token image loads async; give it a moment so the card doesn't ship the monogram fallback
  for (let i = 0; i < 30 && model.meta.image && !model.img; i++) await new Promise(r => setTimeout(r, 100));
  applyAspect();
  renderFrame(totalMs() - 1); // final card frame
  cv.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${model.meta.symbol}-pnl-card.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus('card saved ✓');
  }, 'image/png');
};

// support-the-creator popup
$('donate').onclick = () => { $('dmodal').hidden = false; };
$('dclose').onclick = () => { $('dmodal').hidden = true; };
$('dmodal').addEventListener('click', e => { if (e.target === $('dmodal')) $('dmodal').hidden = true; });
$('dcopy').onclick = async () => {
  const addr = $('daddr').textContent.trim();
  try { await navigator.clipboard.writeText(addr); } catch {
    const ta = document.createElement('textarea');
    ta.value = addr; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  $('dcopy').textContent = 'Copied ✓';
  setTimeout(() => { $('dcopy').textContent = 'Copy address'; }, 1500);
};

$('load').onclick = load;
$('play').onclick = () => play();
$('rec').onclick = record;
$('dur').oninput = e => { cfg.durMs = +e.target.value * 1000; $('durLabel').textContent = e.target.value + 's'; };
$('aspect').onchange = e => { cfg.aspect = e.target.value; if (model && !playing) { applyAspect(); renderFrame(lastFrameT); } };
['mint', 'wallet', 'xuser'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') load(); }));

// idle backdrop
applyAspect();
(function idle() {
  if (!model) {
    const L = layout();
    drawBackdrop(L, performance.now());
    ctx.textAlign = 'center';
    ctx.fillStyle = C.cream35;
    ctx.font = `400 ${Math.round(44 * L.u)}px ${DISP}`;
    ctx.fillText('LOAD A TRADE TO START', L.W / 2, L.H / 2);
    drawWatermark(L);
    requestAnimationFrame(idle);
  }
})();
