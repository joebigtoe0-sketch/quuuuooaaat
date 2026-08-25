// Drive /pnl-card headlessly and save the mp4. No changes to the page.
// usage: node pnlvid.mjs <mint> [outdir]
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const MINT = process.argv[2];
const OUT = path.resolve(process.argv[3] || './pnl-out');
const WALLET = 'DqMNcQmqxtHRGR4X1gHovtxbFYBuRHXbKHqRNCFriKu';
const ASSETS = 'C:/Users/nikos/pnl-assets';
if (!MINT) { console.error('usage: node pnlvid.mjs <mint> [outdir]'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// mix and match so consecutive videos do not look identical
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const vids = fs.readdirSync(ASSETS).filter(f => f.endsWith('.mp4'));
const imgs = fs.readdirSync(ASSETS).filter(f => f.endsWith('.png'));
const vid = path.join(ASSETS, pick(vids));
const img = path.join(ASSETS, pick(imgs));
console.log('chart bg:', path.basename(vid), '| card bg:', path.basename(img));

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=IsolateOrigins,site-per-process',
    '--allow-file-access-from-files',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const client = await page.target().createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });

page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('  [page]', t.slice(0, 120)); });

await page.goto('https://quantriku.fun/pnl-card', { waitUntil: 'networkidle2', timeout: 60000 });

await page.type('#mint', MINT);
await page.type('#wallet', WALLET);

// range + select need their events fired by hand
await page.evaluate(() => {
  const d = document.getElementById('dur');
  d.value = '8'; d.dispatchEvent(new Event('input', { bubbles: true }));
  const a = document.getElementById('aspect');
  a.value = '1:1'; a.dispatchEvent(new Event('change', { bubbles: true }));
});

await (await page.$('#bgChart')).uploadFile(vid);
await (await page.$('#bgCard')).uploadFile(img);
await page.evaluate(() => {
  document.querySelectorAll('[hidden]').forEach(e => { if (e.id === 'vaudWrap') e.hidden = false; });
});
// the mp4 audio is ours, so keep it; no mp3 (commercial music gets X copyright-flagged)
await page.evaluate(() => {
  const v = document.getElementById('vaud');
  if (v && !v.checked) { v.checked = true; v.dispatchEvent(new Event('change', { bubbles: true })); }
});

console.log('loading trade…');
await page.click('#load');
await page.waitForFunction(() => !document.getElementById('rec').disabled, { timeout: 90000 });
const meta = await page.evaluate(() => document.getElementById('status')?.textContent || '');
console.log('loaded:', meta.slice(0, 100));

console.log('recording 8s + server mp4 convert…');
await page.click('#rec');

const before = new Set(fs.readdirSync(OUT));
const deadline = Date.now() + 180000;
let saved = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000));
  const now = fs.readdirSync(OUT).filter(f => !before.has(f) && !f.endsWith('.crdownload'));
  if (now.length) { saved = now[0]; break; }
}
if (saved) {
  const p = path.join(OUT, saved);
  console.log(`SAVED ${p} (${(fs.statSync(p).size / 1e6).toFixed(2)} MB)`);
} else {
  console.log('NO FILE — status:', await page.evaluate(() => document.getElementById('status')?.textContent || '(none)'));
}
await browser.close();
