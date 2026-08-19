/** The producer's control room — served at /admin, password-gated. */
export const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>RIKU · PRODUCER</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#070b12;color:#dfe8fa;font:14px 'Consolas',monospace;padding:24px;max-width:760px;margin:0 auto}
  h1{color:#2affd4;font-size:18px;letter-spacing:3px} h2{color:#7d8aa5;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:26px 0 8px}
  input,textarea{width:100%;box-sizing:border-box;background:#0b1220;border:1px solid #24466a;border-radius:8px;color:#dfeeff;padding:10px;font:13px 'Consolas',monospace}
  button{background:#16324c;color:#dfeeff;border:1px solid #24466a;border-radius:8px;padding:9px 14px;font:13px 'Consolas',monospace;cursor:pointer;margin:4px 6px 4px 0}
  button:hover{background:#1e4a6a} .danger{background:#4c1620;border-color:#6a2436} .danger:hover{background:#6a1e2e}
  .go{background:#14402a} .note{color:#5a7290;font-size:12px;margin:4px 0}
  .card{background:#0a101c;border:1px solid #12324a;border-radius:10px;padding:14px 16px;margin:10px 0}
  .dir{display:flex;align-items:center;gap:8px;margin:6px 0} .dir span{flex:1}
  #panel{display:none} .ok{color:#39ff88} .err{color:#ff4d6d}
</style></head><body>
<h1>◢ RIKU · PRODUCER ROOM</h1>

<div id="login" class="card">
  <div class="note">This room is for the producer. The actor never knows it exists.</div>
  <input id="pw" type="password" placeholder="password" onkeydown="if(event.key==='Enter')login()">
  <button class="go" onclick="login()">enter</button> <span id="loginmsg"></span>
</div>

<div id="panel">
  <h2>whisper — he'll believe it was his own idea</h2>
  <div class="card">
    <textarea id="wtext" rows="2" placeholder="e.g. following other traders and callers back tends to earn followbacks — cheap growth early on"></textarea>
    <button class="go" onclick="whisper()">whisper it</button>
    <div class="note">Active convictions (click ✕ to make him forget):</div>
    <div id="dirs"></div>
  </div>

  <h2>quick direction</h2>
  <div class="card">
    <input id="topic" placeholder="topic (for tweet / film)">
    <button onclick="agent('tweet')">tweet it</button>
    <button onclick="agent('film')">film it</button>
    <button onclick="act({do:'scout_trending'})">scout trending (watchlist)</button>
    <button class="go" onclick="researchNow()">🔬 research a fresh coin NOW</button>
    <button onclick="act({do:'reply_x'})">reply to mentions</button>
    <br>
    <textarea id="kolpool" placeholder="paste your ct-accounts JSON here to load the follow pool" style="width:98%;height:60px;font:11px monospace"></textarea>
    <button onclick="poolImport()">📥 import follow pool</button>
    <br>
    <button onclick="kolLoad()">🐦 load KOL roster</button>
    <button onclick="kolSave()">💾 save roster</button>
    <button onclick="act({do:'engage_kols'})">▶ do a timeline session NOW</button>
    <br>
    <textarea id="kols" placeholder="click load KOL roster" style="width:98%;height:110px;font:12px monospace"></textarea>
    <br>
    <button onclick="factsLoad()">📋 load fact sheet</button>
    <button onclick="factsSave()">💾 save facts</button>
    <span style="opacity:.6">— settled truths he answers from (bubble maps, tokenomics…)</span>
    <br>
    <textarea id="facts" placeholder="click 'load fact sheet'" style="width:98%;height:150px;font:12px monospace"></textarea>
    <br>
    <input id="opmint" placeholder="CA — buy it &amp; stage as HIS find" style="width:340px">
    <input id="opsol" placeholder="sol (blank=auto)" style="width:110px">
    <button class="go" onclick="opCall()">🎯 place the call</button>
    <br>
    <input id="blmint" placeholder="mint to blacklist" style="width:340px">
    <input id="blwhy" placeholder="why (scam, rug...)" style="width:180px">
    <button onclick="blAdd()">🚫 blacklist</button>
    <button onclick="blList()">📖 show black book</button>
    <button onclick="q('/admin/pause','POST')">⏸ pause show</button>
    <button onclick="q('/admin/resume','POST')">▶ resume</button>
  </div>

  <h2>livestream chat — relay pump.fun chat to him</h2>
  <div class="card">
    <input id="chatuser" placeholder="viewer name" style="width:140px">
    <input id="chattext" placeholder="their message — he reads chat at the facecam">
    <button class="go" onclick="chatSend()">send to his chat</button>
    <button onclick="act({do:'engage_chat'})">📣 make him check chat now</button>
    <div class="note" id="chatinfo"></div>
  </div>

  <h2>🖥️ make him run a script on the bigscreen NOW</h2>
  <div class="card">
    <div class="note">He walks to the bigscreen and RUNS this JS live (sandbox: no network/files, 3s).
    Data available: <code>data.positions</code>, <code>data.watchlist</code>, <code>data.research</code>, <code>data.mcHistory</code>.
    Use <code>print(...)</code> and <code>table(rows)</code> to render on screen.</div>
    <input id="scripttitle" placeholder="title (e.g. MY OPEN POSITIONS)" style="width:340px">
    <textarea id="scriptcode" style="width:100%;height:120px" placeholder="print('my open bags: ' + data.positions.length);&#10;for (const p of data.positions) print('  $' + p.symbol + '  cost ' + p.costSol.toFixed(3) + ' SOL');"></textarea>
    <button class="go" onclick="runScript()">▶ run it on stream</button>
    <span id="scriptmsg"></span>
    <div style="margin-top:10px"><button onclick="loadSample()">load a sample (position report)</button></div>
  </div>

  <h2>corkboard — his on-stream goals</h2>
  <div class="card">
    <div class="note">one goal per line (max 7). overwrites his board immediately.</div>
    <textarea id="boardtext" style="width:100%;height:88px" placeholder="pump $RIKU to $1M market cap&#10;become the greatest KOL alive&#10;never sell $RIKU"></textarea>
    <button class="go" onclick="setBoard()">set the board</button>
    <span id="boardmsg"></span>
  </div>

  <h2>status</h2>
  <div class="card" id="status">loading…</div>

  <h2>🔴 go live</h2>
  <div class="card">
    <div class="note">THE one-way button. Paste the pre-generated $RIKU contract address and press: it stores the mint (buyback flywheel + own-mc tracking + airdrops), flips CALLOUT/TRADE/AIRDROP dry-runs OFF, injects the CA into the landing page + pump.fun links, wipes ALL test memory/positions/state, arms the LIVE marker, and reboots him into the real world. Restarts after this KEEP his memory (sim mode hard-disabled). No env edits needed.</div>
    <button onclick="liveCheck()">🧪 check readiness</button>
    <div id="livechecks" class="note"></div>
    <input id="livemint" value="8J15pUS8TcuoUhLeRfrGv8fv8Lkq5sLt5Hitk162pump" placeholder="$RIKU contract address (pre-generated)" style="width:340px">
    <input id="liveconfirm" placeholder="type GOLIVE" style="width:120px">
    <button class="go" onclick="goLive()">🔴 GO LIVE</button>
    <span id="livemsg"></span>
  </div>

  <h2>queue — what's waiting to run</h2>
  <div class="card">
    <button onclick="loadQueue()">↻ refresh</button>
    <button onclick="clearQueue('agent')">clear agent queue</button>
    <div id="queue" class="note" style="margin-top:8px">press refresh</div>
  </div>

  <h2>filmed clips — download & post by hand</h2>
  <div class="card">
    <button onclick="loadClips()">↻ refresh</button>
    <div id="clips" class="note" style="margin-top:8px">press refresh</div>
  </div>

  <h2>system log — ops only, viewers never see this</h2>
  <div class="card">
    <button onclick="syslog()">↻ refresh</button>
    <div id="syslog" style="max-height:320px;overflow-y:auto;font-size:12px;line-height:1.5;margin-top:8px"></div>
  </div>

  <h2>danger zone</h2>
  <div class="card">
    <button onclick="restart()">restart the show</button>
    <div class="note" style="margin-top:10px">Full reset erases his memory: journal, lessons, watchlist, strategy, board,
    convictions, paper positions, bankroll, callout history. He starts life over.</div>
    <input id="confirm" placeholder='type RESET to arm'>
    <button class="danger" onclick="reset()">⚠ WIPE MEMORY + START FRESH</button>
    <span id="dangermsg"></span>
  </div>
</div>

<script>
const q = (p, method='GET', body) => fetch(p, {method, headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined}).then(r=>r.json());
async function login(){
  const r = await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pw:document.getElementById('pw').value})});
  if(r.ok){document.getElementById('login').style.display='none';document.getElementById('panel').style.display='block';refresh();}
  else document.getElementById('loginmsg').innerHTML='<span class="err">wrong password</span>';
}
async function whisper(){
  const t=document.getElementById('wtext').value.trim();
  if(t.length<4)return;
  await q('/admin/directive?text='+encodeURIComponent(t));
  document.getElementById('wtext').value='';
  refresh();
}
async function act(a){ await q('/admin/agent','POST',a); }
async function researchNow(){ const r=await q('/admin/research-now','POST'); console.log('research queued', r); }
async function poolImport(){
  const t=document.getElementById('kolpool').value.trim();
  if(!t) return alert('paste the JSON first');
  const r=await fetch('/admin/kol-pool',{method:'POST',headers:{'content-type':'text/plain'},body:t}).then(x=>x.json());
  alert(r.ok?('imported '+r.imported+' handles into the follow pool'):('failed: '+r.why));
}
async function kolLoad(){
  const r=await fetch('/admin/kol-roster'); document.getElementById('kols').value=await r.text();
}
async function kolSave(){
  const t=document.getElementById('kols').value;
  const r=await fetch('/admin/kol-roster',{method:'POST',headers:{'content-type':'text/plain'},body:t}).then(x=>x.json());
  alert(r.ok?(r.handles+' handles — '+r.apiCallsPerSweep+' API calls per sweep'):('failed: '+r.why));
}
async function factsLoad(){
  const r=await fetch('/admin/facts'); document.getElementById('facts').value=await r.text();
}
async function factsSave(){
  const t=document.getElementById('facts').value;
  const r=await fetch('/admin/facts',{method:'POST',headers:{'content-type':'text/plain'},body:t}).then(x=>x.json());
  alert(r.ok?('saved — '+r.chars+' chars, live within 20s'):('failed: '+r.why));
}
async function opCall(){
  const m=document.getElementById('opmint').value.trim(), s=document.getElementById('opsol').value.trim();
  if(!m) return alert('mint?');
  const r=await q('/admin/operator-call?mint='+encodeURIComponent(m)+(s?'&sol='+encodeURIComponent(s):''),'POST');
  alert(r.ok ? ('filled '+r.sol+' SOL'+(r.dry?' [dry]':'')+' — his discovery airs in a couple min') : ('failed: '+r.why));
}
async function blAdd(){
  const m=document.getElementById('blmint').value.trim(), w=document.getElementById('blwhy').value.trim();
  if(!m) return alert('mint?');
  const r=await q('/admin/blacklist?mint='+encodeURIComponent(m)+'&why='+encodeURIComponent(w||'operator flagged'),'POST');
  alert('black-booked. total: '+Object.keys(r.blacklist||{}).length);
}
async function blList(){
  const r=await q('/admin/blacklist');
  const rows=Object.entries(r.blacklist||{}).map(([m,b])=>m+'  ['+b.by+'] '+b.reason).join('\\n');
  alert(rows||'(black book empty)');
}
async function liveCheck(){
  const r=await q('/admin/go-live-check');
  document.getElementById('livechecks').innerHTML=
    (r.live?'<div class="ok">ALREADY LIVE</div>':'')+
    (r.checks||[]).map(c=>'<div>'+(c.ok?'<span class="ok">✓</span>':'<span class="err">✗</span>')+' '+c.name+' — '+c.note+'</div>').join('')+
    '<div style="margin-top:6px">'+(r.ready?'<span class="ok">READY (dry-run switches are your call)</span>':'<span class="err">BLOCKERS above — fix or force</span>')+'</div>';
}
async function goLive(){
  if(document.getElementById('liveconfirm').value!=='GOLIVE'){document.getElementById('livemsg').innerHTML=' <span class="err">type GOLIVE first</span>';return;}
  const mint=document.getElementById('livemint').value.trim();
  const r=await q('/admin/go-live?confirm=GOLIVE&mint='+encodeURIComponent(mint),'POST');
  if(r.err){document.getElementById('livemsg').innerHTML=' <span class="err">'+r.err+' (see readiness)</span>';liveCheck();return;}
  document.getElementById('livemsg').innerHTML=' <span class="ok">🔴 LIVE — wiped '+(r.wiped||[]).join(', ')+', rebooting…</span>';
  setTimeout(liveCheck, 8000);
}
async function loadQueue(){
  const r=await q('/admin/queue');
  const rows=(r.queue||[]);
  document.getElementById('queue').innerHTML = rows.length
    ? rows.map(j=>'<div>['+j.queue+'] '+j.summary.replace(/</g,'&lt;')+' <button onclick="rmQueue(\\''+j.queue+'\\','+j.i+')" style="padding:1px 8px">✕</button></div>').join('')
    : '(empty — nothing queued)';
}
async function rmQueue(queue,i){ await q('/admin/queue-remove?queue='+queue+'&i='+i,'POST'); loadQueue(); }
async function rm(id){ await q('/admin/directive?remove='+encodeURIComponent(id)); refresh(); }
async function runScript(){
  const title=(document.getElementById('scripttitle').value||'LIVE ANALYSIS').slice(0,60);
  const code=document.getElementById('scriptcode').value.trim();
  if(code.length<10){document.getElementById('scriptmsg').innerHTML=' <span class="err">write at least a line of code</span>';return;}
  const r=await q('/admin/agent','POST',{do:'run_script',title,code});
  document.getElementById('scriptmsg').innerHTML=r.err?' <span class="err">'+r.err+'</span>':' <span class="ok">queued — he\\'ll run it on the bigscreen shortly</span>';
}
function loadSample(){
  document.getElementById('scripttitle').value='POSITION REPORT';
  document.getElementById('scriptcode').value=
    "print('open positions: ' + data.positions.length);\\n"+
    "let green = 0;\\n"+
    "for (const p of data.positions) { print('  $' + p.symbol + '  cost ' + p.costSol.toFixed(3) + ' SOL'); }\\n"+
    "print('coins researched recently: ' + data.research.length);\\n"+
    "print('own mc history points: ' + data.mcHistory.length);";
}
async function setBoard(){
  const lines=document.getElementById('boardtext').value.split('\\n').map(l=>l.trim()).filter(Boolean).slice(0,7);
  if(!lines.length){document.getElementById('boardmsg').innerHTML=' <span class="err">write at least one goal</span>';return;}
  await q('/admin/agent','POST',{do:'board',lines});
  document.getElementById('boardmsg').innerHTML=' <span class="ok">board updated — he\\'ll show it next time he\\'s at the board</span>';
}
async function loadClips(){
  const r=await q('/admin/clips');
  const rows=(r.clips||[]);
  document.getElementById('clips').innerHTML = rows.length
    ? rows.map(c=>'<div><a href="/admin/clip-file/'+c.file+'?key='+encodeURIComponent(document.getElementById('pw').value||'')+'" download>⬇ '+c.file+'</a> · '+(c.size/1e6).toFixed(2)+' MB</div>').join('')
    : '(no clips yet — films save here when the stage/OBS page is connected with audio armed)';
}
async function clearQueue(queue){ await q('/admin/queue-remove?queue='+queue,'POST'); loadQueue(); }
async function syslog(){
  const r=await q('/admin/syslog');
  const color=k=>k.startsWith('error')?'#ff4d6d':k.startsWith('warn')?'#ffb454':'#5a7290';
  document.getElementById('syslog').innerHTML=(r.entries||[]).slice().reverse().map(e=>
    '<div><span style="color:#3d4a63">'+new Date(e.at).toLocaleTimeString()+'</span> '+
    '<span style="color:'+color(e.kind)+';font-weight:bold">'+e.kind.toUpperCase()+'</span> '+
    e.text.replace(/</g,'&lt;')+'</div>').join('')||'<div class="note">(quiet)</div>';
}
async function chatSend(){
  const u=document.getElementById('chatuser').value.trim()||'viewer';
  const t=document.getElementById('chattext').value.trim();
  if(!t)return;
  const r=await q('/admin/chat-add?user='+encodeURIComponent(u)+'&text='+encodeURIComponent(t));
  document.getElementById('chattext').value='';
  document.getElementById('chatinfo').textContent=r.ok?('queued — '+r.unread+' unread; he reads them at the facecam'):'failed';
}
function agent(kind){
  const t=document.getElementById('topic').value.trim()||'progress from the desk';
  act({do:kind, topic:t});
}
async function restart(){ await q('/admin/restart','POST'); document.getElementById('dangermsg').innerHTML=' <span class="ok">restarting…</span>'; setTimeout(refresh, 6000); }
async function reset(){
  if(document.getElementById('confirm').value!=='RESET'){document.getElementById('dangermsg').innerHTML=' <span class="err">type RESET first</span>';return;}
  const r=await q('/admin/reset','POST',{confirm:'RESET'});
  document.getElementById('dangermsg').innerHTML=' <span class="ok">wiped: '+(r.wiped||[]).join(', ')+' — rebooting a blank Quant…</span>';
  setTimeout(refresh, 6000);
}
async function refresh(){
  try{
    const d=await q('/admin/directive');
    document.getElementById('dirs').innerHTML=(d.directives||[]).map(x=>
      '<div class="dir"><span>'+x.text.replace(/</g,'&lt;')+'</span><button onclick="rm(\\''+x.id+'\\')">✕</button></div>').join('')||'<div class="note">(none yet)</div>';
    const h=await q('/health');
    const s=await q('/public/stats');
    document.getElementById('status').innerHTML=
      'state: <b>'+h.state+'</b> · watchers: '+h.watchers+' · brain: '+(h.brain.hasKey?'<span class="ok">LIVE</span>':'<span class="err">NO KEY</span>')+
      ' · spend today: $'+h.brain.spendTodayUsd+(h.brain.lastError?' · <span class="err">'+h.brain.lastError.note+'</span>':'')+
      '<br>calls: '+s.calls+' · bankroll: '+Number(s.trading.paperBankSol).toFixed(3)+' SOL · open: '+s.trading.openPositions+
      ' · realized: '+Number(s.trading.realizedPnlSol).toFixed(3)+' SOL · posts today: '+s.xPostsToday;
  }catch(e){ document.getElementById('status').textContent='server unreachable (restarting?)'; }
}
setInterval(()=>{ if(document.getElementById('panel').style.display==='block') refresh(); }, 10000);
// already logged in? (cookie survives)
q('/admin/directive').then(d=>{ if(!d.err){document.getElementById('login').style.display='none';document.getElementById('panel').style.display='block';refresh();} }).catch(()=>{});
</script></body></html>`;
