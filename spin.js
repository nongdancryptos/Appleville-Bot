// spin-pro.js — FIXED (ESM)
// npm i undici

import fs from 'fs'
import { fetch, ProxyAgent } from 'undici'

// ================== Endpoint ==================
const BASE_URL = 'https://app.appleville.xyz'
const ENDPOINT = `${BASE_URL}/api/trpc/cave.wheelSpin.spin?batch=1`

// Index ↔ Color (theo payload: GREEN=3)
const INDEX_TO_COLOR = ['RED','BLUE','GOLD','GREEN']
const COLOR_TO_INDEX = { RED:0, BLUE:1, GOLD:2, YELLOW:2, GREEN:3 }

// ===== Payout & (tham chiếu) Odds =====
const MULT = [150, 5, 20, 1.15]          // payout mapping cố định theo màu BẠN ĐÃ BET
const BREAKEVEN = MULT.map(m => 1/m)     // p* để EV=0

// ===== Tuning an toàn =====
const BASE_BET   = 1000
const MIN_BET    = 100
const MAX_BET    = 4000
const KELLY_FRAC = 0.25

const W1 = 60    // short window
const W2 = 260   // medium window
const EMA_A = 0.06
const Z_LCB = 2.58    // 99% LCB để “chắc kèo”
const Z_UCB = 2.33

const GATE_MARGIN = 0.008      // phải vượt EV(GREEN)+0.8% mới rời GREEN
const GOLD_LOCK   = {          // KHÓ mở GOLD/RED
  minSamples: 120,             // cần >= 120 quan sát trong w2
  extraLCB:   0.015            // LCB(color) phải > p* + 1.5%
}
const RED_LOCK = { minSamples: 180, extraLCB: 0.02 }

const DELAY_FAST    = [160, 420]
const DELAY_BACKOFF = [2200, 4200]

// Rủi ro
const MAX_LOSS_STREAK = 3
const FIREWALL_SPINS  = 10
const FIREWALL_CUT    = 0.35
const VOL_WIN         = 120
const VOL_TARGET      = 0.14
const TILT_WINDOW     = 30
const TILT_DD         = -6000
const TILT_COOL_MS    = 4000

// Stop/Take (tùy chọn)
const TAKE_PROFIT = null
const STOP_LOSS   = null

const LOG_EVERY = 1

// ================== Utils ==================
const sleep   = ms => new Promise(r=> setTimeout(r, ms))
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a
const clamp   = (x,lo,hi)=> Math.max(lo, Math.min(hi, x))

const readLines = p => fs.existsSync(p)
  ? fs.readFileSync(p,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
  : []

const loadAccounts = ()=> readLines('data.txt').map((line,i)=>({ i, cookie: line.split('\t')[0] }))
const loadProxies  = ()=> readLines('proxy.txt')
const pickProxy    = (list,i)=> list.length? new ProxyAgent(list[i%list.length]): undefined

const headersFor = (cookie)=> ({
  'accept':'*/*',
  'content-type':'application/json',
  'cookie':cookie,
  'origin':BASE_URL,
  'referer':`${BASE_URL}/`,
  'trpc-accept':'application/jsonl',
  'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'x-client-version':'1.0.0',
  'x-trpc-source':'nextjs-react',
})
const bodyFor = (idx,bet)=> JSON.stringify({'0':{json:{selectedIndex:idx, betAmount:bet}}})

function parseJSON(text){
  try { return JSON.parse(text) } catch {
    const arr = text.split('\n').filter(Boolean)
    if(arr.length===1){ try{return JSON.parse(arr[0])}catch{return text} }
    return arr.map(l=>{ try{return JSON.parse(l)}catch{return{raw:l}} })
  }
}

// ---- Robust extractor (lấy cả isWin) ----
function extractOutcome(raw){
  const hunt = (x)=>{
    if(!x||typeof x!=='object') return null
    if('winningIndex'in x||'winningColor'in x||'isWin'in x||'winAmount'in x||'resultIndex'in x) return x
    if(Array.isArray(x)){ for(const it of x){ const f=hunt(it); if(f) return f } return null }
    for(const k of Object.keys(x)){ const f=hunt(x[k]); if(f) return f }
    return null
  }
  const n = hunt(raw) || (Array.isArray(raw)? raw.at(-1) : raw)
  const landedIndex = (typeof n?.winningIndex==='number') ? n.winningIndex
                    : (typeof n?.resultIndex==='number') ? n.resultIndex
                    : undefined
  const color = typeof n?.winningColor==='string'
      ? n.winningColor.toUpperCase()
      : (typeof landedIndex==='number' ? INDEX_TO_COLOR[landedIndex] : undefined)
  const isWin = typeof n?.isWin === 'boolean' ? n.isWin : undefined
  const winAmount = typeof n?.winAmount==='number' ? n.winAmount : undefined
  const balance   = typeof n?.newBalance==='number' ? n.newBalance : undefined
  return { landedIndex, color, isWin, winAmount, balance, raw:n||raw }
}

async function spin({cookie, idx, bet, dispatcher}){
  const res = await fetch(ENDPOINT, {
    method:'POST',
    headers: headersFor(cookie),
    body: bodyFor(idx,bet),
    dispatcher
  })
  const text = await res.text()
  return { ok:res.ok, status:res.status, parsed:parseJSON(text) }
}

// ================== Stats (2 cửa sổ + EMA) ==================
class DualWindow {
  constructor(k=4, n1=W1, n2=W2, alpha=EMA_A){
    this.k=k
    this.n1=n1; this.q1=[]; this.c1=Array(k).fill(0)
    this.n2=n2; this.q2=[]; this.c2=Array(k).fill(0)
    this.ema=Array(k).fill(0); this.a=alpha
  }
  push(i){
    if(typeof i!=='number') return
    this.q1.push(i); this.c1[i]++; if(this.q1.length>this.n1){ const o=this.q1.shift(); this.c1[o]-- }
    this.q2.push(i); this.c2[i]++; if(this.q2.length>this.n2){ const o=this.q2.shift(); this.c2[o]-- }
    for(let a=0;a<this.k;a++){ this.ema[a] = this.a*(a===i?1:0) + (1-this.a)*this.ema[a] }
  }
  total(){ return this.q2.length }
  p1(a){ const N=this.q1.length||1; const freq=this.c1[a]/N; return clamp(0.7*freq+0.3*this.ema[a],0,1) }
  p2(a){ const N=this.q2.length||1; const freq=this.c2[a]/N; return clamp(0.8*freq+0.2*this.ema[a],0,1) }
  count2(a){ return this.c2[a] }
  wilsonLCB(a, z=Z_LCB){
    const n=this.q2.length; if(n<=0) return 0
    const x=this.c2[a]; const ph=x/n; const den=1+z*z/n
    const center=(ph+z*z/(2*n))/den
    const delta=z*Math.sqrt((ph*(1-ph)+z*z/(4*n))/n)/den
    return clamp(center-delta,0,1)
  }
  wilsonUCB(a, z=Z_UCB){
    const n=this.q2.length; if(n<=0) return 1
    const x=this.c2[a]; const ph=x/n; const den=1+z*z/n
    const center=(ph+z*z/(2*n))/den
    const delta=z*Math.sqrt((ph*(1-ph)+z*z/(4*n))/n)/den
    return clamp(center+delta,0,1)
  }
}

// Volatility tracker
class Vol {
  constructor(n=VOL_WIN){ this.n=n; this.q=[] }
  push(ret){ this.q.push(ret); if(this.q.length>this.n) this.q.shift() }
  stdev(){ const N=this.q.length; if(N<2) return 0; const mu=this.q.reduce((a,b)=>a+b,0)/N; const v=this.q.reduce((s,x)=>s+(x-mu)*(x-mu),0)/(N-1); return Math.sqrt(v) }
}

// ================== Decision & Bet ==================
function kellyFraction(p,m){ const num=p*m-1, den=m-1; return den>0? clamp(num/den,0,1):0 }

function chooseArm(est){
  // baseline: GREEN theo p1 (phản ứng nhanh)
  const evG = est.p1(3)*MULT[3]-1

  // LCB & EV_lcb cho từng màu (w2)
  const LCB = [0,1,2,3].map(a => est.wilsonLCB(a))
  const EVl = LCB.map((p,a)=> p*MULT[a]-1)

  // Gating: chỉ rời GREEN khi EV_lcb(color) > EV(GREEN)+margin
  let best=3, bestScore=evG
  for(let a=0;a<4;a++){
    if(a===3) continue
    let needLCB = BREAKEVEN[a] + 0.002 // +0.2% buffer
    let needSamples = 0
    if(a===2){ // GOLD: đòi hỏi rất chặt
      needLCB      = BREAKEVEN[a] + GOLD_LOCK.extraLCB
      needSamples  = GOLD_LOCK.minSamples
      if(est.count2(a) < needSamples) continue
    }
    if(a===0){ // RED: siêu chặt
      needLCB      = BREAKEVEN[a] + RED_LOCK.extraLCB
      needSamples  = RED_LOCK.minSamples
      if(est.count2(a) < needSamples) continue
    }
    const cand = EVl[a]
    if(LCB[a] >= needLCB && cand > 0 && cand >= evG + GATE_MARGIN){
      if(cand > bestScore){ bestScore=cand; best=a }
    }
  }
  return { arm: best, evG, evArm: (best===3? evG: EVl[best]) }
}

function betSize(pEst, arm, firewall, vol){
  const ev=pEst*MULT[arm]-1
  const k = kellyFraction(pEst, MULT[arm])
  let b = Math.max(MIN_BET, Math.round(BASE_BET * Math.max(0.05, Math.min(KELLY_FRAC, k))))
  if (ev>0){ const factor = clamp(1+10*ev, 1, MAX_BET/BASE_BET); b = Math.round(clamp(b*factor, MIN_BET, MAX_BET)) }
  else { b = Math.max(MIN_BET, Math.round(b*0.5)) }
  if (firewall) b = Math.max(MIN_BET, Math.round(b*FIREWALL_CUT))
  const sd=vol.stdev(); if(sd>VOL_TARGET){ const scale=clamp(VOL_TARGET/(sd+1e-9),0.4,1); b=Math.max(MIN_BET, Math.round(b*scale)) }
  return b
}
const nextDelay = (s)=> String(s||'').startsWith('429')||String(s||'').startsWith('5') ? randInt(...DELAY_BACKOFF) : randInt(...DELAY_FAST)

// ================== Main loop ==================
async function runAccount({ idxAcc, cookie, dispatcher }){
  console.log(`\n===== ACCOUNT #${idxAcc+1} (pro-fixed) =====`)
  const est = new DualWindow(4, W1, W2, EMA_A)
  const vol = new Vol(VOL_WIN)

  let t=0, pnl=0, lossStreak=0, firewall=0, lastStatus=200

  while(true){
    t++

    const { arm, evG, evArm } = chooseArm(est)
    const color = INDEX_TO_COLOR[arm]
    const pEst  = est.p2(arm)
    const bet   = betSize(pEst, arm, firewall>0, vol)

    // --- Call API ---
    let res; try{ res = await spin({ cookie, idx:arm, bet, dispatcher }) }
    catch(e){ console.log(`[${idxAcc+1}] neterr: ${e?.message||e}`); await sleep(nextDelay('net')); continue }
    lastStatus = res.status

    // --- Parse & PAYOUT CORRECTLY ---
    const out = extractOutcome(res.parsed)
    const landed = (typeof out.landedIndex==='number') ? out.landedIndex : null
    const landedName = out.color || (landed!=null? INDEX_TO_COLOR[landed] : 'unknown')

    // ❗ CHỈ THẮNG khi isWin===true (nếu server cung cấp) hoặc landed===arm
    const win = (typeof out.isWin==='boolean') ? out.isWin : (landed===arm)
    const payout = win
      ? (typeof out.winAmount==='number' ? out.winAmount : Math.round(bet*MULT[arm]))
      : 0

    const net = payout - bet
    pnl += net

    if (landed!=null) est.push(landed)
    vol.push((payout-bet)/Math.max(1,bet))

    // firewall
    if(net<0) lossStreak++; else lossStreak=0
    if(lossStreak>=MAX_LOSS_STREAK && firewall===0) firewall=FIREWALL_SPINS
    else if(firewall>0) firewall--

    // Log
    if(t%LOG_EVERY===0){
      const pA = est.p2(arm), evA = pA*MULT[arm]-1
      const tags = `${firewall>0?' | FW:'+firewall:''}${win?' | WIN':''}`
      console.log(`[${idxAcc+1}] t=${t} bet=${bet} on ${color} → landed=${landedName} | net=${net>=0?'+':''}${net} | PnL=${pnl>=0?'+':''}${pnl} | EV(G)~${(evG*100).toFixed(2)}% EV(${color})~${(evA*100).toFixed(2)}%${tags}`)
    }

    if(TAKE_PROFIT!=null && pnl>=TAKE_PROFIT){ console.log('🎯 Take-profit'); break }
    if(STOP_LOSS!=null   && pnl<=STOP_LOSS){   console.log('🛑 Stop-loss'); break }

    await sleep(nextDelay(lastStatus))
  }
}

// ================== Driver ==================
async function main(){
  const accs = loadAccounts()
  if(!accs.length){ console.error('❌ data.txt empty or missing.'); process.exit(1) }
  const proxies = loadProxies()
  for(let i=0;i<accs.length;i++){
    const dispatcher = pickProxy(proxies, i)
    await runAccount({ idxAcc:i, cookie: accs[i].cookie, dispatcher })
  }
}
main().catch(e=>{ console.error(e); process.exit(1) })
