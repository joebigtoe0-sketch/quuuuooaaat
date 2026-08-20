/** The puppeteer's board — served at /puppet. Local only, no auth, no show. */
const CLIPS: Record<string, string[]> = {
  greet: ["wave", "wave_over", "salute", "bow", "handshake_reject", "beckon", "blow_kiss", "call_me"],
  hype: ["cheer", "clap", "slow_clap", "fist_pump", "dab", "two_thumbs", "thumbs_up", "flex", "flex_biceps", "beat_chest", "dust_shoulder", "air_guitar", "backflip", "boxing"],
  dance: ["dance", "dance2", "dance3", "dance4", "dance5"],
  love: ["heart_hands", "finger_heart", "hand_on_heart", "pray", "plead"],
  scorn: ["thumbs_down", "no_more", "facepalm", "shrug", "head_shake", "you_crazy", "shake_finger", "calm_down", "raspberry", "menace", "roar", "throat_slit", "shake_fist", "strangle", "rage", "tantrum_stomp"],
  sad: ["cry", "mock_cry", "faint", "slump", "tired", "yawn"],
  think: ["thoughtful", "chin_scratch", "inspect_hands", "check_watch", "look_left", "look_right", "look_up", "look_down", "nod_confident", "head_nod", "shhh", "point"],
  idle: ["idle", "idle2", "foot_tap", "kick_ground", "swing_arms", "hands_on_hips", "stretch_arms", "stretch_shoulders", "weight_shift", "lean_back", "drunk_sway", "pick_nose", "sip", "drink_swig", "crouch_idle", "jump", "run", "walk"],
  phone: ["phone_scroll", "phone_selfie", "phone_photo", "phone_type"],
};
const STATIONS = ["idle_spot", "terminal", "bigscreen", "vault", "conveyor", "camera_mark", "greenscreen", "inbox"];
const CAMERAS = ["wide", "terminal", "facecam", "vault", "film", "bigscreen"];
const MOODS = ["neutral", "excited", "disgusted", "thinking"];
const FX = ["ding", "buzzer", "confetti", "stamp_rekt", "stamp_called"];

const clipButtons = Object.entries(CLIPS)
  .map(
    ([group, clips]) =>
      `<div class="grp"><span class="glab">${group}</span>` +
      clips.map((c) => `<button class="clip" onclick="anim('${c}')">${c}</button>`).join("") +
      `</div>`,
  )
  .join("");

export const PUPPET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>RIKU · PUPPET</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#070b12;color:#dfe8fa;font:13px 'Consolas',monospace;padding:18px;max-width:1100px;margin:0 auto}
  h1{color:#2affd4;font-size:17px;letter-spacing:3px;margin:0 0 4px}
  .sub{color:#5a7290;margin-bottom:16px}
  h2{color:#7d8aa5;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:18px 0 6px}
  .card{background:#0a101c;border:1px solid #12324a;border-radius:10px;padding:12px 14px;margin:8px 0}
  button{background:#16324c;color:#dfeeff;border:1px solid #24466a;border-radius:7px;padding:7px 11px;
    font:12px 'Consolas',monospace;cursor:pointer;margin:3px 4px 3px 0}
  button:hover{background:#1e4a6a;border-color:#2affd4}
  button.clip{padding:5px 8px;font-size:11px}
  .go{background:#14402a;border-color:#2a6a45}
  input,textarea{width:100%;box-sizing:border-box;background:#0b1220;border:1px solid #24466a;border-radius:8px;
    color:#dfeeff;padding:9px;font:13px 'Consolas',monospace}
  .grp{margin:5px 0;padding:4px 0;border-bottom:1px solid #0f2135}
  .glab{display:inline-block;width:56px;color:#2affd4;font-size:10px;letter-spacing:1px;text-transform:uppercase}
  .row{display:flex;gap:8px;align-items:center;margin:6px 0}
  #msg{color:#39ff88;min-height:16px;margin-left:6px}
  a{color:#2affd4}
</style></head><body>
<h1>◢ RIKU · PUPPET</h1>
<div class="sub">No brain, no chain, no trading — nothing posts anywhere. Open the shot at
<a href="/stage?auto=1" target="_blank">/stage?auto=1</a> and film it. <span id="stat"></span></div>

<h2>say</h2>
<div class="card">
  <textarea id="say" rows="2" placeholder="what he says out loud (real voice if TTS is configured)"></textarea>
  <div class="row">
    <select id="saymood">${MOODS.map((m) => `<option>${m}</option>`).join("")}</select>
    <button class="go" onclick="say()">▶ say it</button>
    <span id="msg"></span>
  </div>
</div>

<h2>move</h2>
<div class="card">
  ${STATIONS.map((s) => `<button onclick="walk('${s}')">${s}</button>`).join("")}
  <br><button onclick="sit(1)">sit</button><button onclick="sit(0)">stand</button>
</div>

<h2>camera</h2>
<div class="card">${CAMERAS.map((c) => `<button onclick="cam('${c}')">${c}</button>`).join("")}</div>

<h2>emotes — 90 clips</h2>
<div class="card">${clipButtons}</div>

<h2>mood &amp; fx</h2>
<div class="card">
  ${MOODS.map((m) => `<button onclick="mood('${m}')">${m}</button>`).join("")}
  &nbsp;|&nbsp;
  ${FX.map((f) => `<button onclick="fx('${f}')">${f}</button>`).join("")}
</div>

<h2>shot — a whole take on one button</h2>
<div class="card">
  <div class="sub">one step per line: <code>walk terminal</code> · <code>sit</code> · <code>stand</code> ·
  <code>cam facecam</code> · <code>anim dab</code> · <code>mood excited</code> · <code>fx confetti</code> ·
  <code>wait 800</code> · <code>say anything after the word say is spoken</code></div>
  <textarea id="shot" rows="8" placeholder="cam wide
walk camera_mark
mood excited
anim wave
say I run this desk twenty four hours a day. Say hello to the smartest thing on Solana.
anim two_thumbs
wait 600
cam facecam"></textarea>
  <button class="go" onclick="shot()">🎬 run the take</button>
</div>

<script>
const q=(p,body)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(r=>r.json());
const flash=t=>{document.getElementById('msg').textContent=t;setTimeout(()=>document.getElementById('msg').textContent='',1800)};
const walk=s=>q('/p/walk?to='+s);
const anim=c=>q('/p/anim?clip='+c);
const cam=c=>q('/p/camera?preset='+c);
const mood=m=>q('/p/mood?mood='+m);
const fx=k=>q('/p/fx?kind='+k);
const sit=on=>q('/p/sit?on='+on);
async function say(){
  const text=document.getElementById('say').value.trim();
  if(!text) return;
  const r=await q('/p/say',{text,mood:document.getElementById('saymood').value});
  flash(r.voiced?('speaking — '+Math.round(r.durMs/100)/10+'s'):'subtitles only (no TTS key)');
}
function parseShot(src){
  const steps=[];
  for(const raw of src.split('\\n')){
    const line=raw.trim(); if(!line) continue;
    const sp=line.indexOf(' ');
    const verb=(sp<0?line:line.slice(0,sp)).toLowerCase();
    const rest=sp<0?'':line.slice(sp+1).trim();
    if(verb==='walk') steps.push({walk:rest});
    else if(verb==='sit') steps.push({sit:true});
    else if(verb==='stand') steps.push({sit:false});
    else if(verb==='cam'||verb==='camera') steps.push({camera:rest});
    else if(verb==='anim'||verb==='emote') steps.push({anim:rest});
    else if(verb==='mood') steps.push({mood:rest});
    else if(verb==='fx') steps.push({fx:rest});
    else if(verb==='wait') steps.push({wait:Number(rest)||500});
    else if(verb==='say') steps.push({say:rest});
  }
  return steps;
}
async function shot(){
  const steps=parseShot(document.getElementById('shot').value);
  if(!steps.length) return flash('nothing to run');
  const r=await q('/p/shot',{steps});
  flash('take running — '+r.steps+' steps');
}
fetch('/p/status').then(r=>r.json()).then(s=>{
  document.getElementById('stat').textContent=
    '· stage connected: '+s.watchers+' · voice: '+(s.voiced?s.tts:'subtitles only');
});
</script></body></html>`;
