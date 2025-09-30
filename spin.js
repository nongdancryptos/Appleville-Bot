// spin2.js — v5.0 "adaptive–multi-expert"
// ESM (package.json: { "type":"module" })
// Usage:
//   npm i undici
//   node spin2
//
// Optional:
//   BET_MODE=aggressive node spin2          // conservative | balanced | aggressive
//   OPENAI_API_KEY=sk-... AI_DECIDER=1 node spin2   // AI co-pilot (tùy chọn)
//
// Notes:
// - Không đảm bảo thắng. Server kiểm soát odds/payout/outcome.
// - Win xác định DUY NHẤT: landedIndex === arm (bỏ qua isWin/winAmount server).
// - Cookie: mỗi dòng trong data.txt (tab-sep ok). Proxy: proxy.txt (mỗi dòng 1 proxy).
// - Endpoint/payload giữ nguyên như bạn đã F12.

import fs from 'fs'
import { fetch, ProxyAgent } from 'undici'

/* =============================
   SERVER & STATICS
============================= */

const BASE_URL = 'https://app.appleville.xyz'
const ENDPOINT = `${BASE_URL}/api/trpc/cave.wheelSpin.spin?batch=1`

// Index↔Color
const IDX2 = ['RED','BLUE','GOLD','GREEN']
const COLOR2 = { RED:0, BLUE:1, GOLD:2, YELLOW:2, GREEN:3 }

// Payout multiplier WHEN you win:
const MULT = [150, 5, 20, 1.15]
const BREAKEVEN = MULT.map(m => 1/m)

/* =============================
   WINDOWS / PRIORS / GUARDS
============================= */

const W_FAST=48, W_SLOW=360, EMA_A=0.085
const Z_LCB=2.58, Z_UCB=2.33

// prior bias ưu tiên GREEN nhiều (theo thực nghiệm của bạn)
const PRIOR=[0.35, 1.35, 0.55, 8.25]

const WARMUP_UNTIL=90

// Gate sang màu khác chỉ khi EV rõ rệt:
const BASE_GATE_MARGIN=0.010
const GOLD_LOCK={ minObs:160, minLCB:BREAKEVEN[2]+0.018 }
const RED_LOCK ={ minObs:240, minLCB:BREAKEVEN[0]+0.026 }

// Bet guard
const ABS_MIN_BET=100
const MAX_BET=20000   // mở trần lên chút (nếu muốn, hạ về 12000)
const MIN_UNIT=50     // bội số làm tròn

// Pacing
const MIN_DELAY_OK=[680, 1150]
const MIN_DELAY_SAME=[900, 1500]
const DELAY_BACKOFF=[2200, 4200]
const JITTER_EXTRA=[0, 220]
const BURST_GAP_MS=300

// Vol & risk guards
const VOL_WIN=160, VOL_TARGET=0.12
const MAX_LOSS_STREAK=3, FIREWALL_SPINS=10, FIREWALL_CUT=0.45
const TILT_WINDOW=40, TILT_DD=-11000, TILT_COOL_MS=5500
const STREAK_WIN_BOOST_AFTER=3

// Session take profit / stop loss (tùy chọn, null = vô hiệu)
const TAKE_PROFIT=null
const STOP_LOSS=null

/* =============================
   STRATEGY PROFILES
============================= */

const STRATEGY = process.env.BET_MODE || 'balanced'
const PROFILES = {
  conservative: {
    MIN_FRAC:0.00012, MIN_FRAC_CAP:0.00045,
    RISK_BASE:0.0015, RISK_CAP:0.0048,
    KELLY_CAP:0.18, EDGE_BOOST:0.38,
    STREAK_WIN_BOOST:0.05,
    RECOV_CAP_FRAC:0.35,  // trần lane khôi phục
    RECOV_GAIN_FRAC:0.08, // nhích lại một phần lỗ chưa thu hồi
  },
  balanced: {
    MIN_FRAC:0.00018, MIN_FRAC_CAP:0.00075,
    RISK_BASE:0.0024, RISK_CAP:0.0085,
    KELLY_CAP:0.26, EDGE_BOOST:0.60,
    STREAK_WIN_BOOST:0.10,
    RECOV_CAP_FRAC:0.45,
    RECOV_GAIN_FRAC:0.12,
  },
  aggressive: {
    MIN_FRAC:0.00032, MIN_FRAC_CAP:0.00130,
    RISK_BASE:0.0035, RISK_CAP:0.0130,
    KELLY_CAP:0.36, EDGE_BOOST:0.92,
    STREAK_WIN_BOOST:0.16,
    RECOV_CAP_FRAC:0.55,
    RECOV_GAIN_FRAC:0.16,
  }
}
const P = PROFILES[STRATEGY] || PROFILES.balanced

/* =============================
   OPTIONAL AI DECIDER
============================= */

const AI_DECIDER = process.env.AI_DECIDER === '1' || process.env.AI_DECIDER === 'true'
let openaiClient = null
async function aiReady(){
  if(!AI_DECIDER) return false
  if(!process.env.OPENAI_API_KEY) return false
  if(openaiClient) return true
  try{
    const mod = await import('openai')
    openaiClient = new mod.default({ apiKey: process.env.OPENAI_API_KEY })
    return true
  }catch{ return false }
}
async function aiSuggest({ ctx, signals, proposal }){
  if(!(await aiReady())) return null
  const model = process.env.AI_MODEL || 'gpt-5-mini'
  const json_schema = {
    name:"SpinDecision",
    schema:{
      type:"object", additionalProperties:false,
      properties:{
        arm:{type:"integer",enum:[0,1,2,3]},
        betMultiplier:{type:"number",minimum:0,maximum:3},
        reason:{type:"string",maxLength:512}
      },
      required:["arm","betMultiplier","reason"]
    }
  }
  try{
    const resp = await openaiClient.responses.create({
      model, reasoning:{effort:"medium"},
      input:[
        {role:"system",content:"You optimize EV with minimal DD. Return JSON only."},
        {role:"user",content:[
          {type:"text",text:"Return JSON by schema."},
          {type:"input_json",input_json:{context:ctx, signals, internalProposal:proposal}}
        ]}
      ],
      response_format:{type:"json_schema", json_schema}
    })
    const out = resp.output?.[0]?.content?.[0]
    const txt = out?.type==="output_text" ? out.text : null
    if(!txt) return null
    let parsed; try{ parsed=JSON.parse(txt) }catch{ return null }
    if(typeof parsed.arm!=='number'||parsed.arm<0||parsed.arm>3) return null
    if(typeof parsed.betMultiplier!=='number'||!isFinite(parsed.betMultiplier)) return null
    parsed.betMultiplier = Math.max(0, Math.min(3, parsed.betMultiplier))
    return parsed
  }catch{ return null }
}

/* =============================
   UTILS
============================= */

const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const randInt=(a,b)=>Math.floor(Math.random()*(b-a+1))+a
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x))
const now=()=>Date.now()
const same=(a,b)=>a===b
const roundUnit=(x,unit=MIN_UNIT)=>Math.round(x/unit)*unit

const readLines = p => fs.existsSync(p)
  ? fs.readFileSync(p,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
  : []

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

// chọn node chứa nhiều dấu hiệu nhất (winningIndex/winningColor/...)
function extractOutcome(raw){
  const weight = (x)=> !x||typeof x!=='object' ? -1 :
    (('winningIndex'in x)*3 + ('winningColor'in x)*3 + ('resultIndex'in x) + ('newBalance'in x))
  const hunt = (x)=>{
    if(!x||typeof x!=='object') return null
    if(Array.isArray(x)){ let best=null,sc=-1; for(const it of x){ const c=hunt(it); const w=weight(c); if(c&&w>sc){best=c;sc=w}} return best }
    let bestSelf = weight(x)>0 ? x : null
    let bestChild=null, sc=-1
    for(const k of Object.keys(x)){ const c=hunt(x[k]); const w=weight(c); if(c&&w>sc){bestChild=c; sc=w} }
    return (weight(bestChild)>=weight(bestSelf)) ? bestChild : bestSelf
  }
  const n = hunt(raw) || (Array.isArray(raw)? raw.at(-1) : raw)
  const landedIndex = Number.isInteger(n?.winningIndex) ? n.winningIndex
                    : Number.isInteger(n?.resultIndex)  ? n.resultIndex
                    : undefined
  const color = typeof n?.winningColor==='string'
      ? n.winningColor.toUpperCase()
      : (Number.isInteger(landedIndex) ? IDX2[landedIndex] : undefined)
  const balance   = typeof n?.newBalance==='number' ? n.newBalance : undefined
  return { landedIndex, color, balance, raw:n||raw }
}

async function spin({cookie, idx, bet, dispatcher}){
  const res = await fetch(ENDPOINT, { method:'POST', headers:headersFor(cookie), body:bodyFor(idx,bet), dispatcher })
  const text = await res.text()
  return { ok:res.ok, status:res.status, parsed:parseJSON(text) }
}
function minDelayFor(status, prevSame){
  const s=String(status||'')
  if(s.startsWith('429')||s.startsWith('5')) return randInt(...DELAY_BACKOFF)
  return randInt(...(prevSame? MIN_DELAY_SAME : MIN_DELAY_OK))
}

/* =============================
   STATS, EXPERTS & REGIME
============================= */

class Ensemble {
  constructor(k=4, nF=W_FAST, nS=W_SLOW, alpha=EMA_A, prior=PRIOR){
    this.k=k
    this.nF=nF; this.nS=nS; this.alpha=alpha
    this.qF=[]; this.cF=Array(k).fill(0)
    this.qS=[]; this.cS=Array(k).fill(0)
    this.ema=Array(k).fill(0)
    this.prior = prior.slice()
    this.mk1 = Array.from({length:k}, ()=> Array(k).fill(0))
    this.mk2 = {}
    this.h1=null; this.h2=null
    this.greenStreak=0
    this.winStreak=0
    this.last=null
    // expert weights (will adapt online)
    this.expertW = { FreqEMA:1, LCB:1, TS:1, MK1:1, MK2:1, Streak:1 }
  }
  reset(keep=0.35){
    const scale=x=>Math.round(x*keep)
    this.cF=this.cF.map(scale); this.cS=this.cS.map(scale)
    this.qF=this.qF.slice(-Math.round(this.qF.length*keep))
    this.qS=this.qS.slice(-Math.round(this.qS.length*keep))
    this.ema=this.ema.map(x=>x*keep)
    for(let i=0;i<this.k;i++) for(let j=0;j<this.k;j++) this.mk1[i][j]=Math.round(this.mk1[i][j]*keep)
    Object.keys(this.mk2).forEach(key=>{
      this.mk2[key]=this.mk2[key].map(scale)
      if(this.mk2[key].every(v=>v===0)) delete this.mk2[key]
    })
    if(this.greenStreak>0) this.greenStreak=Math.round(this.greenStreak*keep)
    if(this.winStreak>0)   this.winStreak=Math.round(this.winStreak*keep)
    // soften expert weights
    for(const k of Object.keys(this.expertW)) this.expertW[k] = 0.6*this.expertW[k] + 0.4
  }
  push(i, didWin){
    if(typeof i==='number'){
      this.qF.push(i); this.cF[i]++; if(this.qF.length>this.nF){ const o=this.qF.shift(); this.cF[o]-- }
      this.qS.push(i); this.cS[i]++; if(this.qS.length>this.nS){ const o=this.qS.shift(); this.cS[o]-- }
      for(let a=0;a<this.k;a++) this.ema[a]=this.alpha*(a===i?1:0)+(1-this.alpha)*this.ema[a]
      if(this.last!=null) this.mk1[this.last][i]++
      if(this.h1!=null && this.h2!=null){
        const key=`${this.h1},${this.h2}`
        if(!this.mk2[key]) this.mk2[key]=Array(this.k).fill(0)
        this.mk2[key][i]++
      }
      this.h1=this.h2; this.h2=i
      this.last = i
      if(i===3) this.greenStreak++; else this.greenStreak=0
    }
    if(typeof didWin==='boolean'){
      if(didWin) this.winStreak++; else this.winStreak=0
    }
  }
  len(){ return this.qS.length }
  cnt(a){ return this.cS[a] }
  pFast(a){ const N=this.qF.length, S=this.prior.reduce((s,x)=>s+x,0); const f=(this.cF[a]+this.prior[a])/(N+S||1); return clamp(0.55*f+0.45*this.ema[a],0,1) }
  pSlow(a){ const N=this.qS.length, S=this.prior.reduce((s,x)=>s+x,0); const f=(this.cS[a]+this.prior[a])/(N+S||1); return clamp(0.70*f+0.30*this.ema[a],0,1) }
  wilsonLCB(a,z=Z_LCB){ const n=this.qS.length; if(n<=0) return 0; const x=this.cS[a]; const ph=x/n; const den=1+z*z/n; const center=(ph+z*z/(2*n))/den; const delta=z*Math.sqrt((ph*(1-ph)+z*z/(4*n))/n)/den; return clamp(center-delta,0,1) }
  wilsonUCB(a,z=Z_UCB){ const n=this.qS.length; if(n<=0) return 1; const x=this.cS[a]; const ph=x/n; const den=1+z*z/n; const center=(ph+z*z/(2*n))/den; const delta=z*Math.sqrt((ph*(1-ph)+z*z/(4*n))/n)/den; return clamp(center+delta,0,1) }
  tsSample(){
    const samp = new Array(this.k).fill(0)
    const S = this.cS.reduce((s,x,i)=> s + (x + this.prior[i] + 1e-3), 0) || 1
    const N = Math.max(1,this.len())
    for(let a=0;a<this.k;a++){
      const alpha = this.cS[a] + this.prior[a] + 1e-3
      const mean = alpha / S
      const sd   = Math.sqrt(mean*(1-mean)/N)
      const z    = (Math.random()*2-1)*1.0
      samp[a] = clamp(mean + z*sd, 0, 1)
    }
    return samp
  }
  pMarkov1(next){
    if(this.last==null) return 0.25
    const row=this.mk1[this.last]; const sum=row.reduce((a,b)=>a+b,0)
    return sum? clamp(row[next]/sum,0,1) : 0.25
  }
  pMarkov2(next){
    if(this.h1==null||this.h2==null) return 0.25
    const row=this.mk2[`${this.h1},${this.h2}`]
    if(!row) return 0.25
    const sum=row.reduce((a,b)=>a+b,0)
    return sum? clamp(row[next]/sum,0,1) : 0.25
  }
  // === Expert aggregator ===
  expertProbs(){
    // 6 experts → một vector p[4] mỗi expert, rồi trọng số
    const pTS = this.tsSample()
    const pE = new Array(4).fill(0)
    const norm=(v)=>{ const s=v.reduce((a,b)=>a+b,0)||1; return v.map(x=>x/s) }

    const ex = {
      FreqEMA: norm([0,1,2,3].map(a=> 0.45*this.pSlow(a)+0.55*this.pFast(a) )),
      LCB    : norm([0,1,2,3].map(a=> this.wilsonLCB(a) )),
      TS     : norm(pTS),
      MK1    : norm([0,1,2,3].map(a=> this.pMarkov1(a) )),
      MK2    : norm([0,1,2,3].map(a=> this.pMarkov2(a) )),
      Streak : norm([0,1,2,3].map(a=>{
        // nếu GREEN đang streak dài, ưu tiên giữ GREEN; nếu không, giảm nhẹ GREEN
        const base = this.pSlow(a)
        if(a===3){
          return base * (1 + Math.min(0.25, this.greenStreak*0.03))
        } else {
          return base * (1 - Math.min(0.12, this.greenStreak*0.02))
        }
      }))
    }
    const W = this.expertW
    const sumW = Object.values(W).reduce((a,b)=>a+b,0)||1
    for(const [name, vec] of Object.entries(ex)){
      const w = (W[name]||1)/sumW
      for(let a=0;a<4;a++) pE[a] += w*vec[a]
    }
    return clampVec(pE)
  }
  updateExpertWeights(landed){
    // multiplicative weights (hedge): tăng trọng số các expert dự đoán cao xác suất landed
    if(landed==null) return
    const probs = {
      FreqEMA: probOf(this,'FreqEMA', landed),
      LCB    : probOf(this,'LCB', landed),
      TS     : probOf(this,'TS', landed),
      MK1    : probOf(this,'MK1', landed),
      MK2    : probOf(this,'MK2', landed),
      Streak : probOf(this,'Streak', landed),
    }
    const eta=0.25
    for(const k of Object.keys(this.expertW)){
      const p = clamp(probs[k], 1e-6, 1-1e-6)
      this.expertW[k] *= Math.exp(eta*Math.log(p))
      // tránh tràn/teo quá mức
      this.expertW[k] = clamp(this.expertW[k], 0.25, 8)
    }
  }
}
function clampVec(v){ const s=v.reduce((a,b)=>a+b,0)||1; return v.map(x=> clamp(x/s,0,1)) }
function probOf(est, which, a){
  // tái tạo cùng cách tính trong expertProbs()
  const norm=(v)=>{ const s=v.reduce((x,y)=>x+y,0)||1; return v.map(z=>z/s) }
  if(which==='TS'){
    const pTS = est.tsSample()
    const v = clampVec(pTS)
    return v[a]
  }
  if(which==='FreqEMA'){
    const v = norm([0,1,2,3].map(i=> 0.45*est.pSlow(i)+0.55*est.pFast(i) ))
    return v[a]
  }
  if(which==='LCB'){
    const v = norm([0,1,2,3].map(i=> est.wilsonLCB(i) ))
    return v[a]
  }
  if(which==='MK1'){
    const v = norm([0,1,2,3].map(i=> est.pMarkov1(i) ))
    return v[a]
  }
  if(which==='MK2'){
    const v = norm([0,1,2,3].map(i=> est.pMarkov2(i) ))
    return v[a]
  }
  if(which==='Streak'){
    const v = norm([0,1,2,3].map(i=>{
      const base = est.pSlow(i)
      if(i===3) return base * (1 + Math.min(0.25, est.greenStreak*0.03))
      return base * (1 - Math.min(0.12, est.greenStreak*0.02))
    }))
    return v[a]
  }
  return 0.25
}

// Explorer: EXP3 + UCB
class Explorer {
  constructor(k=4){ this.k=k; this.w=Array(k).fill(1); this.t=0; this.r=Array(k).fill(0); this.n=Array(k).fill(0); this.sq=Array(k).fill(0) }
  exp3Prob(gamma=0.08){
    const W=this.w.reduce((a,b)=>a+b,0)||1
    return this.w.map(w=> (1-gamma)*(w/W) + gamma/this.k )
  }
  updateExp3(a, reward, gamma=0.08){
    this.t++
    const p=this.exp3Prob(gamma)[a]
    const x = reward/p
    this.w[a] *= Math.exp((gamma*x)/this.k)
  }
  ucbTuned(){
    const t=Math.max(1,this.t)
    const res=new Array(this.k).fill(0)
    for(let a=0;a<this.k;a++){
      const n=this.n[a]||1e-9
      const mean=this.r[a]/Math.max(1,this.n[a])
      const varU = this.sq[a]/Math.max(1,this.n[a]) - mean*mean + Math.sqrt(2*Math.log(t)/Math.max(1,this.n[a]))
      res[a]= mean + Math.sqrt(Math.log(t)/Math.max(1,this.n[a]) * Math.min(0.25, varU))
    }
    return res
  }
  updateUCB(a, reward){
    this.t++
    this.n[a]=(this.n[a]||0)+1
    this.r[a]=(this.r[a]||0)+reward
    this.sq[a]=(this.sq[a]||0)+reward*reward
  }
}

// Regime detector
class Regime {
  constructor(thup=3.0, thdn=-3.0){
    this.g=0; this.G=0; this.thUp=thup; this.thDn=thdn
    this.lastReset=now()
    this.mu=0; this.beta=0.02
    // slow drift
    this.slow=0; this.betaS=0.004
  }
  push(x){ // x: GREEN share - baseline
    this.mu = (1-this.beta)*this.mu + this.beta*x
    const z = x - this.mu
    this.g = Math.max(0, this.g + z)
    this.G = Math.min(0, this.G + z)
    let changed=false
    if(this.g>this.thUp || this.G<this.thDn){ changed=true; this.lastReset=now(); this.g=0; this.G=0 }
    // drift slow:
    this.slow = (1-this.betaS)*this.slow + this.betaS*x
    const drift = Math.abs(this.slow)>0.10
    return {changed, drift}
  }
}

/* =============================
   VOLATILITY & RISK
============================= */

class Vol{
  constructor(n=VOL_WIN){ this.n=n; this.q=[] }
  push(ret){ this.q.push(ret); if(this.q.length>this.n) this.q.shift() }
  stdev(){ const N=this.q.length; if(N<2) return 0; const mu=this.q.reduce((a,b)=>a+b,0)/N; const v=this.q.reduce((s,x)=>s+(x-mu)*(x-mu),0)/(N-1); return Math.sqrt(v) }
}

class RiskManager{
  constructor(){ this.peak=null; this.bankroll=0; this.pnlSession=0; this.pnlPeak=0 }
  update(bankroll, pnlSession){
    if(typeof bankroll==='number'){ this.bankroll=bankroll; if(this.peak===null||bankroll>this.peak) this.peak=bankroll }
    if(typeof pnlSession==='number'){ this.pnlSession=pnlSession; if(this.pnlSession>this.pnlPeak) this.pnlPeak=this.pnlSession }
  }
  ddFrac(){ if(!this.peak) return 0; return (this.bankroll-this.peak)/this.peak } // ≤0 is drawdown
  throttle(){
    const f=this.ddFrac()
    if(f>=-0.03) return 1.00
    if(f>=-0.06) return 0.88
    if(f>=-0.10) return 0.75
    if(f>=-0.16) return 0.60
    return 0.45
  }
}

/* =============================
   COLOR DECISION
============================= */

function chooseArm(est, ex, gateMargin){
  // Expert mixture
  const mix = est.expertProbs() // length=4
  // Base assume GREEN unless clear gain
  let best = 3, why='green-baseline'
  let bestScore = mix[3]*MULT[3]-1

  // Gate sang màu khác theo EV (dùng LCB protection)
  for(let a of [0,1,2]){
    if(a===2 && (est.len()<W_SLOW || est.cnt(2)<GOLD_LOCK.minObs)) continue
    if(a===0 && (est.len()<W_SLOW || est.cnt(0)<RED_LOCK.minObs)) continue
    const pLCB = est.wilsonLCB(a)
    const need = a===2? GOLD_LOCK.minLCB : a===0? RED_LOCK.minLCB : BREAKEVEN[a]+0.002
    const evLCB = pLCB*MULT[a]-1
    const evMix = mix[a]*MULT[a]-1
    if(pLCB>=need && evLCB>0 && evMix >= bestScore + gateMargin){
      best=a; bestScore=evMix; why=`gate-${IDX2[a]}`
    }
  }

  // Explore thận trọng RED/GOLD khi vẫn GREEN
  if(best===3 && est.len()>WARMUP_UNTIL){
    const pExp = ex.exp3Prob(), ucb=ex.ucbTuned()
    let cand=-1, score=-1e9
    for(let a of [0,2]){
      const ev = mix[a]*MULT[a]-1 + 0.25*ucb[a] + 0.05*Math.log(1+pExp[a])
      if(ev>score){ score=ev; cand=a }
    }
    if(cand!==-1 && score > bestScore + gateMargin*0.6){
      best=cand; bestScore=score; why=`explore-${IDX2[cand]}`
    }
  }
  // Nâng/giảm gate nếu streak xanh dài/đỏ dài
  if(best!==3 && est.greenStreak>=5) { best=3; bestScore=mix[3]*MULT[3]-1; why='green-streak-lock' }

  return { arm:best, evG:mix[3]*MULT[3]-1, evArm:bestScore, why, mix }
}

/* =============================
   SIZING (MetaSizer)
============================= */

const kelly=(p,m)=>{ const num=p*m-1, den=m-1; return den>0? clamp(num/den,0,1):0 }

function dynamicMinBet(bankroll, est){
  const frac = clamp(P.MIN_FRAC, 0, P.MIN_FRAC_CAP)
  let b = roundUnit(Math.max(ABS_MIN_BET, bankroll*frac))
  const n = est.len()
  if(n>=W_SLOW){
    const greenRate = est.cnt(3)/n
    if(greenRate > 0.835){
      const boost = 1 + 0.14 * Math.min(1, (greenRate-0.805)/0.05)
      b = roundUnit(b*boost)
    }
  }
  return clamp(b, ABS_MIN_BET, MAX_BET)
}

class BetGovernor{
  constructor(){ this.last=null }
  adjust(proposed){
    if(this.last==null){ this.last=proposed; return proposed }
    const up = roundUnit(this.last*1.45)   // tăng tối đa +45%/spin
    const dn = roundUnit(this.last*0.38)   // giảm tối đa −62%/spin
    const bounded = clamp(proposed, dn, up)
    this.last = bounded
    return bounded
  }
}

function metaSizeBet({bankroll, est, arm, pMean, pLCB, m, firewall, vol, rsk, gov, recovState}){
  bankroll = Math.max(bankroll||0, 1)
  const minBet = dynamicMinBet(bankroll, est)
  const breakeven = 1/m

  // Lanes:
  // 1) Kelly (mean)
  const fMean  = Math.min(kelly(pMean,m), P.KELLY_CAP)
  // 2) Kelly (LCB)
  const fLCB   = Math.min(kelly(pLCB,m), P.KELLY_CAP*0.85)
  // 3) Risk budget từ EV (LCB):
  const ev_lcb = Math.max(0, pLCB*m - 1)
  const riskFrac= clamp(P.RISK_BASE + P.EDGE_BOOST*ev_lcb, 0, P.RISK_CAP)
  // 4) Volatility scaling
  const sd = vol.stdev()
  const volScale = sd > VOL_TARGET ? clamp(VOL_TARGET/(sd+1e-9), 0.33, 1) : 1
  // 5) Recovery (khôi phục dần dần một phần DD/PnL âm)
  let recovAdd = 0
  if(recovState && recovState.runningLoss<0){
    const cap = bankroll * P.RECOV_CAP_FRAC * fLCB
    const want = Math.min(cap, Math.abs(recovState.runningLoss)*P.RECOV_GAIN_FRAC)
    recovAdd = roundUnit(want)
  }

  // Base stake = bankroll * risk * (blend kelly)
  const kBlend = Math.max(0.25*fLCB + 0.75*fMean, 0)
  let stake = bankroll * riskFrac * kBlend
  // streak boost khi xanh và winStreak kéo dài
  if(est.winStreak >= STREAK_WIN_BOOST_AFTER && arm===3){
    stake *= (1 + P.STREAK_WIN_BOOST)
  }
  // firewall
  if(firewall) stake *= FIREWALL_CUT
  // apply vol
  stake *= volScale

  // chuyển stake → bet tiền, cộng lane khôi phục
  let bet = Math.max(minBet, roundUnit(stake) + recovAdd)
  // drawdown throttle + governor
  bet = roundUnit(bet * rsk.throttle())
  bet = gov.adjust(bet)

  return clamp(bet, ABS_MIN_BET, MAX_BET)
}

/* =============================
   MAIN LOOP
============================= */

async function runAccount({ idxAcc, cookie, dispatcher }){
  console.log(`\n===== ACCOUNT #${idxAcc+1} (v5.0 ${STRATEGY}) =====`)
  const est = new Ensemble(4, W_FAST, W_SLOW, EMA_A, PRIOR)
  const vol = new Vol(VOL_WIN)
  const ex  = new Explorer(4)
  const reg = new Regime()
  const rsk = new RiskManager()
  const gov = new BetGovernor()

  let t=0, pnl=0, lossStreak=0, firewall=0, lastStatus=200
  let bankroll=null
  const recents=[]
  let lastSpinAt = 0
  let prevLanded = null
  let gateMargin = BASE_GATE_MARGIN

  // recovery state
  const recovState = { runningLoss:0 } // âm khi thua chuỗi

  while(true){
    t++
    // pacing
    const nowMs = now()
    const since = nowMs - lastSpinAt
    const baseDelay = minDelayFor(lastStatus, same(prevLanded, est.last))
    const delayNeed = Math.max(baseDelay, BURST_GAP_MS)
    if(since < delayNeed){
      await sleep(delayNeed - since + randInt(...JITTER_EXTRA))
    }

    // choose arm
    let arm=3, evG=null, evArm=null, why='warmup', mix=[0.25,0.25,0.25,0.25]
    if(est.len() < WARMUP_UNTIL){ 
      const mix0=[0.18,0.09,0.08,0.65]; mix=mix0
      evG = mix0[3]*MULT[3]-1; evArm = evG
    } else {
      const res = chooseArm(est, ex, gateMargin)
      arm=res.arm; evG=res.evG; evArm=res.evArm; why=res.why; mix=res.mix
    }

    const { p, pLCB, pS } = (()=>{ 
      const pS = est.pSlow(arm)
      const pLCB = est.wilsonLCB(arm)
      // nhẹ nhàng pha theo expert mix để phản ứng nhanh
      const pBlend = clamp(0.65*pS + 0.35*mix[arm],0,1)
      return { p:pBlend, pLCB, pS }
    })()

    // sizing (MetaSizer)
    let bet = metaSizeBet({
      bankroll, est, arm,
      pMean:p, pLCB, m:MULT[arm],
      firewall: firewall>0, vol, rsk, gov, recovState
    })

    // AI advisory (tùy chọn)
    if (await aiReady()) {
      const signals = [0,1,2,3].map(a=>{
        const m=MULT[a], pS=est.pSlow(a), pLCB=est.wilsonLCB(a)
        return {
          color:IDX2[a], m, pMean:pS, pLCB,
          evMean:pS*m-1, evLCB:pLCB*m-1,
          cnt:est.cnt(a), share: est.len()? est.cnt(a)/est.len():0
        }
      })
      const ctx = {
        bankroll, minBet: dynamicMinBet(Math.max(1,bankroll||0), est),
        maxBet: MAX_BET, firewall: firewall>0,
        volSd: vol.stdev(),
        greenHeat: est.len()? est.cnt(3)/est.len() : 0,
        baseGate: BASE_GATE_MARGIN, mode: STRATEGY
      }
      const ai = await aiSuggest({ ctx, signals, proposal:{arm, bet, why} })
      if (ai){
        const safeSwitch =
          !(ai.arm===0 && (est.len()<W_SLOW || est.cnt(0)<RED_LOCK.minObs)) &&
          !(ai.arm===2 && (est.len()<W_SLOW || est.cnt(2)<GOLD_LOCK.minObs))
        if(safeSwitch){
          const evNew = signals[ai.arm].evMean
          const evGre = signals[3].evMean
          if (evNew >= evGre - 0.003) {
            arm = ai.arm
            const scaled = roundUnit(clamp(bet * ai.betMultiplier, ABS_MIN_BET, MAX_BET))
            if (scaled >= ABS_MIN_BET) bet = gov.adjust(scaled)
            why += ` | ai(${IDX2[ai.arm]},x${ai.betMultiplier.toFixed(2)})`
          }
        }
      }
    }

    // API call
    let res
    try { res = await spin({ cookie, idx:arm, bet, dispatcher }) }
    catch(e){ console.log(`[${idxAcc+1}] neterr: ${e?.message||e}`); lastStatus='net'; continue }
    lastStatus = res.status

    // Parse & settle — FIX: win ONLY if landedIndex === arm
    const out = extractOutcome(res.parsed)
    if (typeof out.balance === 'number'){
      bankroll = Math.max(1, out.balance)
      rsk.update(bankroll, pnl)
    }
    const landed = Number.isInteger(out?.landedIndex) ? out.landedIndex : null
    const landedName = out?.color || (landed != null ? IDX2[landed] : 'unknown')

    const win = (landed != null) && (landed === arm)
    const payout = win ? Math.round(bet * MULT[arm]) : 0
    const net = payout - bet; pnl += net

    // update stats
    if(landed!=null) est.push(landed, win)
    est.updateExpertWeights(landed)
    vol.push((payout - bet)/Math.max(1,bet))

    // explorer feedback
    const reward = clamp((payout - bet)/Math.max(1,bet), -1, 1)
    ex.updateExp3(arm, Math.max(0, reward))
    ex.updateUCB(arm, (reward+1)/2)

    // regime
    if(landed!=null){
      const gShare = est.cnt(3)/Math.max(1,est.len())
      const dev = gShare - 0.70
      const ch = reg.push(dev)
      if(ch.changed){
        console.log(`[${idxAcc+1}] 🔁 regime-change → soft-reset & loosen gate`)
        est.reset(0.40)
        gateMargin = Math.max(0.006, gateMargin*0.78)
      } else {
        gateMargin = gateMargin*0.985 + BASE_GATE_MARGIN*0.015
      }
      if(ch.drift){
        // drift chậm → giảm nhẹ sức nặng Markov
        est.expertW.MK1 *= 0.9
        est.expertW.MK2 *= 0.9
      }
    }

    // guards, recovery state
    if(net<0){ lossStreak++; recovState.runningLoss += net } else { lossStreak=0; recovState.runningLoss = Math.min(0, recovState.runningLoss+net) }
    if(lossStreak>=MAX_LOSS_STREAK && firewall===0) firewall=FIREWALL_SPINS
    else if(firewall>0) firewall--

    const recentLen = recents.push(net); if(recentLen>TILT_WINDOW) recents.shift()
    const dd = recents.reduce((a,b)=>a+b,0)
    if(dd<=TILT_DD){
      console.log(`[${idxAcc+1}] ⚠️ tilt-guard DD=${dd} → cooldown ${TILT_COOL_MS}ms`)
      await sleep(TILT_COOL_MS)
      lossStreak=0
      firewall = Math.max(firewall, Math.ceil(FIREWALL_SPINS/2))
    }

    // log
    const evShow = ((p*MULT[arm]-1)*100).toFixed(2)
    const evGShow= ((est.pSlow(3)*MULT[3]-1)*100).toFixed(2)
    console.log(`[${idxAcc+1}] t=${t} bet=${bet} on ${IDX2[arm]} → ${landedName} | ${win?'WIN':'LOSE'} | net=${net>=0?'+':''}${net} | PnL=${pnl>=0?'+':''}${pnl} | EV(${IDX2[arm]})~${evShow}% EV(G)~${evGShow}%${firewall>0?` | FW:${firewall}`:''}${bankroll?` | bankroll=${Math.round(bankroll)}`:''} | ${why}`)

    if(TAKE_PROFIT!=null && pnl>=TAKE_PROFIT){ console.log('🎯 Take-profit hit.'); break }
    if(STOP_LOSS!=null   && pnl<=STOP_LOSS){   console.log('🛑 Stop-loss hit.');  break }

    lastSpinAt = now()
    prevLanded = landed
  }
}

/* =============================
   DRIVER
============================= */

const readLinesMaybe = p => { try{ return readLines(p) }catch{ return [] } }

async function main(){
  const accs = readLinesMaybe('data.txt').map((line,i)=>({ i, cookie: line.split('\t')[0] }))
  if(!accs.length){
    console.error('❌ data.txt is empty or missing. Put one cookie per line.')
    process.exit(1)
  }
  const proxyList = readLinesMaybe('proxy.txt')
  for(let i=0;i<accs.length;i++){
    const dispatcher = proxyList.length? new ProxyAgent(proxyList[i%proxyList.length]) : undefined
    await runAccount({ idxAcc:i, cookie:accs[i].cookie, dispatcher })
  }
}
main().catch(e=>{ console.error(e); process.exit(1) })
