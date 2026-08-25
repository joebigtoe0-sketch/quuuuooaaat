// Find CLOSED, GREEN trades from on-chain history.
// Does NOT use producer-state closedRecent: that record misses partial exits
// and logged a +57% winner (GRILA) as -100%.
//
// Two-pass by design. The time window picks CANDIDATES (mints whose last swap
// is recent), but P&L is summed over the FULL pulled history for that mint.
// Summing only inside the window counts a sell whose buy fell outside it and
// reports a loss as a win.
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('C:/Users/nikos/quant/.env','utf8')
  .split(/\r?\n/).filter(l=>/^[A-Z_0-9]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()]}));
const W='DqMNcQmqxtHRGR4X1gHovtxbFYBuRHXbKHqRNCFriKu', K=env.HELIUS_API_KEY;
const RPC=`https://mainnet.helius-rpc.com/?api-key=${K}`;
const SEEN='wins-seen.json';
const seen = fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN,'utf8')) : {};
const rpc=async(m,p)=>(await(await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})})).json());

if (process.argv[2]==='--posted') {
  for (const m of process.argv.slice(3)) seen[m]=Date.now();
  fs.writeFileSync(SEEN,JSON.stringify(seen,null,1));
  console.log(`marked ${process.argv.length-3} posted (${Object.keys(seen).length} total)`);
  process.exit(0);
}
const HOURS = Number(process.argv[2] || 12);

let all=[], before='';
for (let p=0;p<6;p++){
  const r=await fetch(`https://api.helius.xyz/v0/addresses/${W}/transactions?api-key=${K}&limit=100${before?`&before=${before}`:''}`);
  const t=await r.json(); if(!Array.isArray(t)||!t.length) break;
  all.push(...t); before=t[t.length-1].signature;
}
const oldest = Math.min(...all.map(t=>t.timestamp));
const RIKU='8J15pUS8TcuoUhLeRfrGv8fv8Lkq5sLt5Hitk162pump';

// pass 1: full-history totals per mint
const per={};
for (const t of all) {
  if (t.type!=='SWAP') continue;
  const me=(t.accountData||[]).find(a=>a.account===W);
  const d=(me?.nativeBalanceChange||0)/1e9;
  const mints=[...new Set((t.tokenTransfers||[]).map(x=>x.mint)
    .filter(m=>m && m!=='So11111111111111111111111111111111111111112' && m!==RIKU))];
  for (const m of mints) {
    per[m]=per[m]||{net:0,n:0,first:t.timestamp,last:t.timestamp,spent:0};
    per[m].net+=d/mints.length; per[m].n++;
    if (d<0) per[m].spent += -d/mints.length;
    per[m].first=Math.min(per[m].first,t.timestamp); per[m].last=Math.max(per[m].last,t.timestamp);
  }
}
// pass 2: candidates = closed recently, green over their WHOLE life, and with
// their opening buy visible in the pulled history (else the entry is unknown)
const cutoff = Date.now()/1000 - HOURS*3600;
const out=[];
for (const [mint,v] of Object.entries(per)) {
  if (v.last < cutoff || v.n < 2 || v.net <= 0) continue;
  if (v.spent <= 0) continue;                       // never saw the buy -> cannot trust it
  if (v.first <= oldest + 60) continue;             // opened at/before the edge of history
  const ta = await rpc('getTokenAccountsByOwner',[W,{mint},{encoding:'jsonParsed'}]);
  const held=(ta.result?.value||[]).reduce((s,a)=>s+Number(a.account.data.parsed.info.tokenAmount.uiAmount||0),0);
  if (held>0) continue;                             // still open
  out.push({mint,net:v.net,spent:v.spent,swaps:v.n,mins:Math.round((v.last-v.first)/60),at:v.last,posted:!!seen[mint]});
}
out.sort((a,b)=>b.at-a.at);
if(!out.length){ console.log(`no closed green trades in the last ${HOURS}h`); process.exit(0); }
for (const w of out) {
  const pct = ((w.net/w.spent)*100).toFixed(0);
  console.log(`${w.posted?'   ':'>> '}${w.mint}  +${w.net.toFixed(4)} SOL (+${pct}% on ${w.spent.toFixed(3)} in)  ${w.swaps} swaps  ${w.mins}m`);
}
console.log(`\n${out.filter(w=>!w.posted).length} unposted. mark: node wins.mjs --posted <mint>`);
