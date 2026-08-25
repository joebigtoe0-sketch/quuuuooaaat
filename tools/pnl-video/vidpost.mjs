// Post a tweet with an mp4 attached, straight to X.
// The server can upload video but only from ITS own disk, and /admin/tweet-exact
// takes text only — so generated clips had to be posted by hand. This closes that.
//   node vidpost.mjs <file.mp4> <textfile>
import fs from 'node:fs';
import crypto from 'node:crypto';

const env = Object.fromEntries(fs.readFileSync('C:/Users/nikos/quant/.env','utf8')
  .split(/\r?\n/).filter(l=>/^[A-Z_0-9]+=.+/.test(l))       // skip the EMPTY placeholder block
  .map(l=>{const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).trim()];}));
const CK=env.X_CONSUMER_KEY, CS=env.X_CONSUMER_SECRET, AT=env.X_ACCESS_TOKEN, AS=env.X_ACCESS_SECRET;
if (!CK||!CS||!AT||!AS) { console.error('missing X OAuth1a credentials'); process.exit(2); }

const enc = s => encodeURIComponent(s).replace(/[!*()']/g, c => '%'+c.charCodeAt(0).toString(16).toUpperCase());
function oauth(method, url, extraParams = {}) {
  const p = {
    oauth_consumer_key: CK, oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: Math.floor(Date.now()/1000).toString(),
    oauth_token: AT, oauth_version: '1.0', ...extraParams,
  };
  const base = [method.toUpperCase(), enc(url),
    enc(Object.keys(p).sort().map(k=>`${enc(k)}=${enc(p[k])}`).join('&'))].join('&');
  const sig = crypto.createHmac('sha1', `${enc(CS)}&${enc(AS)}`).update(base).digest('base64');
  const all = { ...p, oauth_signature: sig };
  return 'OAuth ' + Object.keys(all).filter(k=>k.startsWith('oauth_')).sort()
    .map(k=>`${enc(k)}="${enc(all[k])}"`).join(', ');
}

const UP = 'https://upload.twitter.com/1.1/media/upload.json';
const mp4 = process.argv[2], textFile = process.argv[3];
const text = fs.readFileSync(textFile,'utf8').trim();
if (/[\u2014\u2013]/.test(text)) { console.error('REFUSED: em/en dash'); process.exit(2); }
const buf = fs.readFileSync(mp4);
console.log(`${mp4} (${(buf.length/1e6).toFixed(2)} MB), ${text.length} chars`);

// INIT — command params are form-encoded, so they join the signature base
const initParams = { command:'INIT', total_bytes:String(buf.length), media_type:'video/mp4', media_category:'tweet_video' };
let r = await fetch(UP, { method:'POST',
  headers:{ authorization: oauth('POST', UP, initParams), 'content-type':'application/x-www-form-urlencoded' },
  body: new URLSearchParams(initParams) });
let j = await r.json();
if (!j.media_id_string) { console.error('INIT failed', r.status, JSON.stringify(j).slice(0,300)); process.exit(2); }
const mediaId = j.media_id_string;
console.log('media_id', mediaId);

// APPEND — multipart, so ONLY oauth_* params are signed
const CHUNK = 4*1024*1024;
for (let i=0, seg=0; i<buf.length; i+=CHUNK, seg++) {
  const fd = new FormData();
  fd.append('command','APPEND'); fd.append('media_id', mediaId);
  fd.append('segment_index', String(seg));
  fd.append('media', new Blob([buf.subarray(i, Math.min(i+CHUNK, buf.length))]));
  const rr = await fetch(UP, { method:'POST', headers:{ authorization: oauth('POST', UP) }, body: fd });
  if (rr.status >= 300) { console.error('APPEND', seg, 'failed', rr.status, (await rr.text()).slice(0,200)); process.exit(2); }
  console.log(`  append ${seg} ok`);
}

const finParams = { command:'FINALIZE', media_id: mediaId };
r = await fetch(UP, { method:'POST',
  headers:{ authorization: oauth('POST', UP, finParams), 'content-type':'application/x-www-form-urlencoded' },
  body: new URLSearchParams(finParams) });
j = await r.json();
if (j.errors) { console.error('FINALIZE failed', JSON.stringify(j).slice(0,300)); process.exit(2); }

// video needs transcoding before it can be attached
let state = j.processing_info?.state;
while (state === 'pending' || state === 'in_progress') {
  const wait = (j.processing_info?.check_after_secs ?? 3) * 1000;
  await new Promise(z=>setTimeout(z, wait));
  const stParams = { command:'STATUS', media_id: mediaId };
  const q = new URLSearchParams(stParams);
  const sr = await fetch(`${UP}?${q}`, { headers:{ authorization: oauth('GET', UP, stParams) } });
  j = await sr.json(); state = j.processing_info?.state;
  console.log('  transcode:', state, j.processing_info?.progress_percent ?? '');
}
if (state === 'failed') { console.error('transcode failed', JSON.stringify(j.processing_info).slice(0,300)); process.exit(2); }

const TW = 'https://api.x.com/2/tweets';
r = await fetch(TW, { method:'POST',
  headers:{ authorization: oauth('POST', TW), 'content-type':'application/json' },
  body: JSON.stringify({ text, media:{ media_ids:[mediaId] } }) });
const out = await r.json();
if (!out?.data?.id) { console.error('TWEET FAILED', r.status, JSON.stringify(out).slice(0,300)); process.exit(2); }
console.log('POSTED', out.data.id);
