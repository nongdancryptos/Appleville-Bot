// spinx.js — Ultra-Strategy, Full-Stack Bot (no cuts, strict PnL by color match)
// Author: CQ (+assist). Node >=18
// Run: node spinx.js --ui=dashboard --log-every=1 --rounds=0 (0 = infinite)

import fs from 'fs'
import readline from 'readline'
import { fetch, ProxyAgent } from 'undici'

// ========================== ENDPOINT & MAPPING ==========================
const BASE_URL = 'https://app.appleville.xyz'
const ENDPOINT = `${BASE_URL}/api/trpc/cave.wheelSpin.spin?batch=1`

const INDEX_TO_COLOR = ['RED', 'BLUE', 'GOLD', 'GREEN']
const COLOR_TO_INDEX = { RED: 0, BLUE: 1, GOLD: 2, YELLOW: 2, GREEN: 3 }

// helper: tên màu an toàn từ index
function colorNameFromIndexSafe(i){
  return (Number.isInteger(i) && i>=0 && i<INDEX_TO_COLOR.length)
    ? INDEX_TO_COLOR[i] : null
}

// UI Official odds (from in-game "How it works")
const OFFICIAL_P = [0.0050, 0.1500, 0.0400, 0.8050] // red, blue, gold, green
let MULTIPLIERS = [150, 5, 20, 1.15]

// ============================== MASTER CONFIG ===========================
const DEFAULT_ROUNDS = 0            // 0 = infinite
const WARMUP_ROUNDS = 24            // round robin 4 colors (tiny bet)  <-- (giữ hằng số, nhưng logic chọn đã thông minh hơn)
const DECAY = 0.99990               // Dirichlet soft memory
const MULT_EMA = 0.05               // learn multipliers if payout provided

const EPS_START = 0.04
const EPS_END   = 0.008
const EPS_DECAY = 450

const KELLY_CAP = 0.22              // max kelly fraction “effective”
const BET_MIN_FACTOR = 0.28
const BET_MAX_FACTOR = 1.25
const RISK_AVERSION  = 0.85
const EV_GATE_FACTOR = 0.20         // when EV_LCB<=0

const MIN_DELAY = 900
const MAX_DELAY = 2200
const RETRIES = 3
const BACKOFF_BASE = 600

const STOP_LOSS = null              // e.g. -50000
const TAKE_PROFIT = null            // e.g. +50000

const MAX_BANK_FRAC = 0.08          // cap by bankroll
const VAR_CAP_SIGMA = 2.2           // VaR-ish cap (higher = more risk)

// Rolling winrate cooldown
const ROLL_N = 50
const ROLL_MIN_WINRATE = 0.29
const COOLDOWN_ROUNDS = 22
const COOLDOWN_BET_FACTOR = 0.25

// Detector params
const WIN_MAIN = 256
const WIN_SHORT = 48
const DISCOUNT = 0.9988
const CHI_P_THRESH = 0.010
const KL_TAU = 0.015
const STREAK_MIN = 5
const MKV_SELF_STRONG = 0.62
const CYCLE_SCORE_TAU = 0.18
const EXP3_GAMMA = 0.07
const RISK_BOOST_BLUE_GOLD = 1.15
const BOOST_BLUE_MULT = 1.18        // light boost if clear evidence

// Page-Hinkley/CUSUM
const PH_DELTA = 0.002
const PH_LAMBDA = 0.04
const CUSUM_K = 0.0035
const CUSUM_H = 0.06

// Logging
const LOG_FILE = 'spin-log.csv'

// ============================== UTILITIES ===============================
const waitMs = (ms) => new Promise(r => setTimeout(r, ms))
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a
const clamp = (x,lo,hi)=> Math.min(hi, Math.max(lo,x))
const epsAtRound = r => Math.max(EPS_END, EPS_START * Math.exp(-r/ EPS_DECAY))

function csv(v){ if (v==null) return ''; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s }
const nf = (n,d=4)=> (typeof n==='number' && isFinite(n)) ? Number(n).toFixed(d) : ''
const ni = (n)=> (typeof n==='number' && isFinite(n)) ? Math.round(n) : ''
const pfx = (n)=> (n>=0?`+${n}`:`${n}`)

// ============================== IO: ACCOUNTS ============================
function parseAccounts(file = 'data.txt') {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return lines.map((line, i) => {
    const parts = line.split('\t')
    const cookie = parts[0]
    const bet = Number(parts[1] ?? NaN)
    const index = Number(parts[2] ?? NaN)
    return { i, cookie, bet, index }
  })
}
function parseProxies(file = 'proxy.txt') {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}
function pickProxyAgent(proxies, i) {
  if (!proxies.length) return null
  const url = proxies[i % proxies.length]
  try { return new ProxyAgent(url) } catch { return null }
}
function headersFor(cookie) {
  return {
    'accept': '*/*',
    'content-type': 'application/json',
    'cookie': cookie,
    'origin': BASE_URL,
    'referer': `${BASE_URL}/`,
    'trpc-accept': 'application/jsonl',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'x-client-version': '1.0.0',
    'x-trpc-source': 'nextjs-react',
  }
}
const buildBody = (idx, bet)=> JSON.stringify({ '0': { json: { selectedIndex: idx, betAmount: bet } } })

// ============================== PARSE RESPONSE ==========================
function safeJsonParse(text) {
  try { return JSON.parse(text) } catch {
    const arr = text.split('\n').filter(Boolean)
    if (arr.length === 1) { try { return JSON.parse(arr[0]) } catch { return text } }
    return arr.map(l => { try { return JSON.parse(l) } catch { return { raw: l } } })
  }
}
function extractOutcome(raw) {
  const hunt = (x) => {
    if (!x || typeof x !== 'object') return null
    if ('winningIndex' in x || 'winningColor' in x || 'isWin' in x || 'winAmount' in x || 'resultIndex' in x || 'balance' in x) return x
    if (Array.isArray(x)) { for (const it of x){ const f = hunt(it); if (f) return f } return null }
    for (const k of Object.keys(x)){ const f = hunt(x[k]); if (f) return f }
    return null
  }
  const data = hunt(raw)
  const landedIndex =
    (typeof data?.winningIndex === 'number' ? data.winningIndex : undefined) ??
    (typeof data?.resultIndex === 'number'  ? data.resultIndex  : undefined)
  const payout =
    (typeof data?.winAmount === 'number' ? data.winAmount : undefined) ??
    (typeof data?.payout   === 'number' ? data.payout   : undefined)
  const balance =
    (typeof data?.newBalance === 'number' ? data.newBalance : undefined) ??
    (typeof data?.balance    === 'number' ? data.balance    : undefined)
  const color = (typeof data?.winningColor === 'string' ? data.winningColor.toUpperCase() : undefined)
  return { landedIndex, payout, balance, color, raw: data ?? raw }
}

// ============================== MATH HELPERS ============================
function gammaSample(shape){
  if (shape < 1) { const u = Math.random(); return gammaSample(shape + 1) * Math.pow(u, 1/shape) }
  const d = shape - 1/3, c = 1/Math.sqrt(9*d)
  while (true){
    let x, v
    do {
      const u1 = Math.random(), u2 = Math.random()
      const z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2)
      x = z; v = 1 + c*x
    } while (v <= 0)
    v = v*v*v
    const u = Math.random()
    if (u < 1 - 0.0331 * (x*x)*(x*x)) return d*v
    if (Math.log(u) < 0.5*x*x + d*(1 - v + Math.log(v))) return d*v
  }
}
function dirichletSample(alpha){
  const g = alpha.map(a => gammaSample(Math.max(1e-6, a)))
  const s = g.reduce((x,y)=>x+y,0) || 1
  return g.map(v=>v/s)
}
function wilsonLCB(succ, n, z=2.33){
  if(n<=0) return 0;
  const ph=succ/n, z2=z*z, den=1+z2/n;
  const center=(ph + z2/(2*n))/den;
  const margin=z*Math.sqrt(ph*(1-ph)/n + z2/(4*n*n))/den;
  return Math.max(0, center - margin);
}
function chiSquare(obs, exp){
  let X=0, n=obs.reduce((a,b)=>a+b,0);
  for(let i=0;i<obs.length;i++){
    const Ei=Math.max(1e-9, exp[i]*n), diff=obs[i]-Ei;
    X+= diff*diff/Ei;
  }
  const p = Math.exp(-X/2)*(1+X/2); // df=3 approx
  return {X,p};
}
function KL(p,q){
  let s=0;
  for(let i=0;i<p.length;i++){
    const a=Math.max(1e-9,p[i]), b=Math.max(1e-9,q[i]);
    s+= a*Math.log(a/b);
  }
  return s;
}
const mean = a => a.length? a.reduce((x,y)=>x+y,0)/a.length : 0
const variance = a => {
  if (!a.length) return 0
  const m = mean(a)
  return a.reduce((s,v)=>s+(v-m)*(v-m),0)/(a.length||1)
}

// ============================== PRIORS/TS ===============================
function priorFromMultipliers(mults, S0 = 800) {
  const raw = mults.map(m => Math.max(1e-6, 1 / Math.max(1.001, m)))
  const sum = raw.reduce((s,v)=>s+v,0)
  const p = raw.map(v=>v/sum)
  return p.map(pi => Math.max(1, pi * S0))
}
class DirichletTS {
  constructor(K, initAlpha=1){
    this.K = K
    this.alpha = Array(K).fill(initAlpha)
    this.mults = MULTIPLIERS.slice()
  }
  setAlpha(a){ if (Array.isArray(a) && a.length===this.K) this.alpha = a.slice() }
  decay(f=DECAY){ for (let i=0;i<this.K;i++) this.alpha[i] = Math.max(1, this.alpha[i]*f) }
  updateFromLanded(idx){ if (Number.isInteger(idx) && idx>=0 && idx<this.K) this.alpha[idx] += 1 }
  learnMultiplier(arm, observedMult){
    if (!Number.isFinite(observedMult) || observedMult <= 0) return
    const eta = MULT_EMA
    const next = (1-eta)*this.mults[arm] + eta*observedMult
    this.mults[arm] = Math.max(0.5 * MULTIPLIERS[arm], next)
  }
  postMean(){ const S = this.alpha.reduce((s,v)=>s+v,0); return this.alpha.map(a=>a/S) }
  getAlpha(){ return this.alpha.slice() }
  getMults(){ return this.mults.slice() }
}

// ============================== RISK / KELLY ============================
function kellyFraction(p, mult){
  const b = Math.max(1e-9, mult - 1), q = 1 - p
  return Math.max(0, (b*p - q)/b)
}

// ============================== HTTP CALL ===============================
async function spinOnce({ cookie, betAmount, armIndex, dispatcher }) {
  const headers = headersFor(cookie)
  const body = buildBody(armIndex, betAmount)
  for (let t=0; t<=RETRIES; t++){
    try{
      const res = await fetch(ENDPOINT, { method:'POST', headers, body, dispatcher })
      const text = await res.text()
      return { ok: res.ok, status: res.status, text, attempt: t+1 }
    }catch(e){
      if (t === RETRIES) throw e
    }
    await waitMs(BACKOFF_BASE * Math.pow(2,t) + randInt(0,300))
  }
  return { ok:false, status:0, text:'', attempt:RETRIES+1 }
}

// ============================== CSV LOG ================================
function ensureLogHeader(){
  if (!fs.existsSync(LOG_FILE)){
    fs.writeFileSync(LOG_FILE, [
      'ts','round','acc','bet_base','bet_used','bet_factor','index','color',
      'ok','status','landedIndex','payout','balance',
      'p_mean','p_lcb','mult_est','EV_LCB','edge_mean','kelly',
      'net','pnl','reason','alpha','mults','detector','raw'
    ].join(',')+'\n')
  }
}
function appendLog(row){
  const line = [
    csv(new Date().toISOString()),
    csv(row.round),
    csv(row.acc),
    csv(row.betBase),
    csv(row.betUsed),
    csv(nf(row.betFactor,6)),
    csv(row.index),
    csv(row.color),
    csv(row.ok),
    csv(row.status),
    csv(row.landedIndex ?? ''),
    csv(row.payout ?? ''),
    csv(row.balance ?? ''),
    csv(nf(row.pMean,6)),
    csv(nf(row.pLCB,6)),
    csv(nf(row.multEst,6)),
    csv(nf(row.evLCB,6)),
    csv(nf(row.edgeMean,6)),
    csv(nf(row.kelly,6)),
    csv(row.net),
    csv(row.pnl),
    csv(row.reason.join('|')),
    csv(JSON.stringify(row.alpha)),
    csv(JSON.stringify(row.mults)),
    csv(JSON.stringify(row.detector)),
    csv(JSON.stringify(row.raw))
  ].join(',')+'\n'
  fs.appendFileSync(LOG_FILE, line)
}

// ============================== ANSI UI (pretty/dashboard) =============
const C = {
  reset: s=>`\x1b[0m${s}\x1b[0m`,
  dim:   s=>`\x1b[2m${s}\x1b[0m`,
  gray:  s=>`\x1b[90m${s}\x1b[0m`,
  red:   s=>`\x1b[31m${s}\x1b[0m`,
  green: s=>`\x1b[32m${s}\x1b[0m`,
  yellow:s=>`\x1b[33m${s}\x1b[0m`,
  blue:  s=>`\x1b[34m${s}\x1b[0m`,
  cyan:  s=>`\x1b[36m${s}\x1b[0m`,
  bgRed: s=>`\x1b[41m${s}\x1b[0m`,
  bgBlue:s=>`\x1b[44m${s}\x1b[0m`,
  bgYellow:s=>`\x1b[43m${s}\x1b[0m`,
  bgGreen:s=>`\x1b[42m${s}\x1b[0m`,
}
const ANSI_RE = /\x1B\[[0-9;]*m/g
const stripAnsi = s => String(s).replace(ANSI_RE, '')
const visLen = s => stripAnsi(s).length
function truncAnsi(s, width){
  s = String(s)
  if (visLen(s) <= width) return s
  const ell = '…'
  const target = Math.max(0, width - ell.length)
  let out = '', v = 0
  for (let i=0;i<s.length;i++){
    const ch = s[i]
    if (ch === '\x1b'){
      const m = s.slice(i).match(/^\x1B\[[0-9;]*m/)
      if (m){ out += m[0]; i += m[0].length-1; continue }
    }
    if (v < target){ out += ch; v++ } else break
  }
  return out + ell
}
function padAnsi(s, width, align='left'){
  s = String(s)
  const pad = Math.max(0, width - visLen(s))
  if (align === 'right') return ' '.repeat(pad) + s
  if (align === 'center') {
    const l = Math.floor(pad/2), r = pad - l
    return ' '.repeat(l) + s + ' '.repeat(r)
  }
  return s + ' '.repeat(pad)
}
const COL = {
  round: 8,  pick: 4,  color: 7,  p: 7,  lcb: 7, mult: 6, EV: 7, edge: 7,
  baseUsed: 16, landed: 8, payout: 9, net: 10, pnl: 12, tags: 34
}
const SEP = ' │ '
const HR = '─'.repeat(
  COL.round+COL.pick+COL.color+COL.p+COL.lcb+COL.mult+COL.EV+COL.edge+
  COL.baseUsed+COL.landed+COL.payout+COL.net+COL.pnl+COL.tags + 13*3
)
const colorBadge = (name) => {
  const m = { RED: C.bgRed(' RED '), BLUE: C.bgBlue(' BLUE '), GOLD: C.bgYellow(' GOLD '), GREEN: C.bgGreen(' GREEN ') }
  return m[name] || name
}
function makePrettyHeader(){
  return [
    padAnsi('r',       COL.round,  'right'),
    padAnsi('pick',    COL.pick),
    padAnsi('color',   COL.color),
    padAnsi('p',       COL.p,      'right'),
    padAnsi('lcb',     COL.lcb,    'right'),
    padAnsi('mult',    COL.mult,   'right'),
    padAnsi('EV',      COL.EV,     'right'),
    padAnsi('edge',    COL.edge,   'right'),
    padAnsi('base→used',COL.baseUsed),
    padAnsi('landed',  COL.landed),
    padAnsi('payout',  COL.payout, 'right'),
    padAnsi('net',     COL.net,    'right'),
    padAnsi('pnl',     COL.pnl,    'right'),
    padAnsi('tags',    COL.tags),
  ].join(SEP)
}
function makePrettyRow(o){
  const colorTxt = colorBadge(o.color)
  const evTxt   = (o.evLCB!=null && o.evLCB<=0) ? C.red(nf(o.evLCB,4)) : C.green(nf(o.evLCB,4))
  const edgeTxt = (o.edgeMean!=null && o.edgeMean<=0) ? C.red(nf(o.edgeMean,4)) : C.green(nf(o.edgeMean,4))
  const netTxt  = (o.net>=0) ? C.green(pfx(ni(o.net))) : C.red(pfx(ni(o.net)))
  const pnlTxt  = (o.pnl>=0) ? C.green(pfx(ni(o.pnl))) : C.red(pfx(ni(o.pnl)))
  const landed  = colorBadge(o.landedName || '-')
  const tags    = (o.tags||[]).join('|')
  return [
    padAnsi(`${o.round}/${o.rounds===0?'∞':o.rounds}`, COL.round, 'right'),
    padAnsi(o.index,                  COL.pick,  'right'),
    padAnsi(colorTxt,                 COL.color),
    padAnsi(nf(o.pMean,4),            COL.p,     'right'),
    padAnsi(nf(o.pLCB,4),             COL.lcb,   'right'),
    padAnsi(nf(o.multEst,3),          COL.mult,  'right'),
    padAnsi(evTxt,                    COL.EV,    'right'),
    padAnsi(edgeTxt,                  COL.edge,  'right'),
    padAnsi(`${o.betBase}→${o.betUsed}(${nf(o.betFactor,2)})`, COL.baseUsed),
    padAnsi(truncAnsi(landed, COL.landed), COL.landed),
    padAnsi(o.payout ?? '-',          COL.payout,'right'),
    padAnsi(netTxt,                   COL.net,   'right'),
    padAnsi(pnlTxt,                   COL.pnl,   'right'),
    padAnsi(truncAnsi(tags, COL.tags),COL.tags)
  ].join(SEP)
}
function createDashboard(rowsMax){
  const state = { header: makePrettyHeader(), buf: [], max: rowsMax, stats: {pnl:0, win:0, cnt:0} }
  return {
    push(row){
      const win = row.net>0?1:0
      state.stats.cnt++
      state.stats.win += win
      state.stats.pnl  = row.pnl
      const line = makePrettyRow(row)
      state.buf.push(line)
      if (state.buf.length > state.max) state.buf.shift()
      process.stdout.write('\x1b[2J\x1b[0;0H')
      const winrate = state.stats.cnt? (state.stats.win/state.stats.cnt*100).toFixed(1):'0.0'
      const bar = `PnL: ${row.pnl>=0?C.green(pfx(ni(row.pnl))):C.red(pfx(ni(row.pnl)))}  |  Winrate: ${winrate}%  |  Round ${row.round}/${row.rounds===0?'∞':row.rounds}`
      console.log(C.cyan(' SPIN LOG — dashboard ') + C.gray('(CTRL+C to quit)'))
      console.log(HR)
      console.log(bar)
      console.log(HR)
      console.log(state.header)
      console.log(HR)
      for (const l of state.buf) console.log(l)
      console.log(HR)
    }
  }
}
function createPrettyPrinter(repeatHeaderEvery=25){
  let n=0
  const header = makePrettyHeader()
  return {
    push(row){
      if (n % repeatHeaderEvery === 0){
        console.log(HR); console.log(header); console.log(HR)
      }
      console.log(makePrettyRow(row))
      n++
    }
  }
}
function printPlain(row){
  const tagStr = row.tags?.length ? ` [${row.tags.join('|')}]` : ''
  console.log(
    `[${row.acc}] r${row.round}/${row.rounds||'∞'} | bet=${row.betBase}→${row.betUsed}(${nf(row.betFactor,2)}) | ${row.color} | p=${nf(row.pMean,4)} | lcb=${nf(row.pLCB,4)} | m=${nf(row.multEst,3)} | EV=${nf(row.evLCB,4)} | edge=${nf(row.edgeMean,4)} | landed=${row.landedName} | payout=${row.payout ?? '-'} | net=${pfx(ni(row.net))} | pnl=${pfx(ni(row.pnl))} | status=${row.status}${tagStr}`
  )
}

// ============================== DETECTORS / SAFETY NETS =================
class Rolling {
  constructor(n){ this.n=n; this.buf=[]; }
  push(x){
    this.buf.push(x);
    if(this.buf.length>this.n) this.buf.shift();
  }
  counts4(){ const c=[0,0,0,0]; for(const v of this.buf){ if(v>=0&&v<4)c[v]++; } return c; }
  probs4(){ const c=this.counts4(); const s=this.buf.length||1; return c.map(v=>v/s); }
  streakLen(){
    if(!this.buf.length) return 0;
    const last=this.buf[this.buf.length-1]; let k=0;
    for(let i=this.buf.length-1;i>=0;i--){ if(this.buf[i]===last) k++; else break; }
    return k;
  }
}
class EWMA {
  constructor(alpha=0.06){ this.a=alpha; this.v=null; }
  push(x){ this.v = (this.v==null) ? x : (1-this.a)*this.v + this.a*x; return this.v }
  value(){ return this.v ?? 0 }
}
class PageHinkley {
  constructor(delta=PH_DELTA, lambda=PH_LAMBDA){ this.delta=delta; this.lambda=lambda; this.mean=0; this.mT=0; this.t=0; }
  push(x){
    this.t++; this.mean = this.mean + (x - this.mean)/this.t
    const y = x - this.mean - this.delta
    this.mT = Math.min(0, this.mT + y)
    if (-this.mT > this.lambda){ this.mT=0; return true } // change detected
    return false
  }
}
class CUSUM {
  constructor(k=CUSUM_K, h=CUSUM_H){ this.k=k; this.h=h; this.pos=0; this.neg=0 }
  push(x){
    this.pos = Math.max(0, this.pos + (x - this.k))
    this.neg = Math.max(0, this.neg + (-x - this.k))
    if (this.pos > this.h || this.neg > this.h){ this.pos=0; this.neg=0; return true }
    return false
  }
}
class Markov1 {
  constructor(){ this.C=Array.from({length:4},()=>[1,1,1,1]); this.last=null; }
  observe(i){ if(this.last!=null&&i>=0&&i<4) this.C[this.last][i]++; this.last=i; }
  P(){ return this.C.map(r=>{const s=r.reduce((a,b)=>a+b,0); return r.map(v=>v/s);}); }
  nextProbs(){ return this.last==null?[0.25,0.25,0.25,0.25]:this.P()[this.last]; }
  cycleScore(){ const P=this.P(); const self=P.map((r,i)=>r[i]); const avgSelf=self.reduce((a,b)=>a+b,0)/4; return Math.max(0,0.5-avgSelf); }
}
class EXP3 {
  constructor(gamma=EXP3_GAMMA,K=4){ this.g=gamma; this.K=K; this.w=Array(K).fill(1); }
  probs(){ const W=this.w.reduce((s,v)=>s+v,0); return this.w.map(w=>(1-this.g)*(w/W)+this.g/this.K); }
  pick(){ const p=this.probs(); const u=Math.random(); let c=0; for(let i=0;i<p.length;i++){ c+=p[i]; if(u<=c) return i; } return this.K-1; }
  reward(i,r){ const p=this.probs()[i]; const x=r/p; this.w[i]*=Math.exp((this.g*x)/this.K); }
}
class UCB1 {
  constructor(K=4){ this.K=K; this.n=Array(K).fill(0); this.r=Array(K).fill(0); this.t=0 }
  pick(){
    this.t++
    for(let i=0;i<this.K;i++) if(this.n[i]===0) return i
    const vals = this.n.map((n,i)=> (this.r[i]/n) + Math.sqrt(2*Math.log(this.t)/n))
    let b=0, bv=-Infinity
    for(let i=0;i<this.K;i++){ if(vals[i]>bv){ bv=vals[i]; b=i } }
    return b
  }
  reward(i,rew){ this.n[i]++; this.r[i]+=rew }
}
class RegimeDetector {
  constructor(){
    this.rolls = new Rolling(WIN_MAIN)
    this.short = new Rolling(WIN_SHORT)
    this.mkv   = new Markov1()
    this.exp3  = new EXP3()
    this.ucb   = new UCB1()
    this.ph    = new PageHinkley()
    this.cusum = new CUSUM()
    this.ewVar = new EWMA(0.08)
    this.ewMean= new EWMA(0.06)
  }
  observe(landedIdx){
    if(landedIdx==null) return
    this.rolls.push(landedIdx)
    this.short.push(landedIdx)
    this.mkv.observe(landedIdx)
    const pObs = this.short.probs4()
    const dev = KL(pObs, OFFICIAL_P)
    const m = this.ewMean.push(dev)
    const v = this.ewVar.push(Math.abs(dev - m))
    this.ph.push(dev)
    this.cusum.push(dev)
  }
  decideWeights(){
    const counts=this.rolls.counts4(), countsS=this.short.counts4()
    const n=this.rolls.buf.length, nS=this.short.buf.length
    const probsObs=this.rolls.probs4(), probsS=this.short.probs4()
    const {p:chiP}=chiSquare(nS?countsS:counts, OFFICIAL_P)
    const kl=KL(probsS, OFFICIAL_P)
    const streak=this.rolls.streakLen()
    const selfProb = (this.mkv.last!=null)? this.mkv.P()[this.mkv.last][this.mkv.last] : 0.25
    const cycleScore = this.mkv.cycleScore()

    const changePH = this.ph.push(kl) // re-probe (no harm)
    const changeCU = this.cusum.push(kl)

    let regime='REG-IID', biasColor=null, tags=[]
    if (streak>=STREAK_MIN || selfProb>=MKV_SELF_STRONG) {
      const c = this.rolls.buf.length? this.rolls.buf[this.rolls.buf.length-1] : 3
      regime = `REG-STREAK:${INDEX_TO_COLOR[c]}`; biasColor=c
    } else if (cycleScore>=CYCLE_SCORE_TAU) {
      regime='REG-CYCLE'
    } else if ( (nS>=WIN_SHORT && chiP<=CHI_P_THRESH && kl>=KL_TAU) || changePH || changeCU ) {
      let best=3, lift=-Infinity
      for(let i=0;i<4;i++){ const d=probsS[i]-OFFICIAL_P[i]; if(d>lift){ lift=d; best=i; } }
      regime=`REG-BIAS:${INDEX_TO_COLOR[best]}`; biasColor=best
    }
    if (changePH) tags.push('PH')
    if (changeCU) tags.push('CUSUM')

    const lcb=[0,1,2,3].map(i=>wilsonLCB(counts[i], Math.max(1,n), 2.33))

    let wEXP=0.15, wOBS=0.35, wMKV=0.25, wLCB=0.25
    if(n<WIN_SHORT){ wEXP=0.25; wOBS=0.45; wMKV=0.15; wLCB=0.15; }
    if(regime.startsWith('REG-BIAS')){ wOBS+=0.1; wMKV+=0.05; wLCB+=0.05; wEXP=Math.max(0.05,wEXP-0.2); }
    else if(regime.startsWith('REG-STREAK')){ wMKV+=0.20; wLCB+=0.05; wOBS=Math.max(0.05,wOBS-0.1); wEXP=Math.max(0.05,wEXP-0.15); }
    else if(regime==='REG-CYCLE'){ wMKV+=0.15; wOBS+=0.10; wLCB=Math.max(0.05,wLCB-0.1); wEXP=Math.max(0.05,wEXP-0.1); }

    const s=wEXP+wOBS+wMKV+wLCB; wEXP/=s; wOBS/=s; wMKV/=s; wLCB/=s;

    const pEXP=this.exp3.probs(), pOBS=probsObs, pMKV=this.mkv.nextProbs()
    let probs=[0,1,2,3].map(i => wEXP*pEXP[i] + wOBS*pOBS[i] + wMKV*pMKV[i] + wLCB*lcb[i])

    if (biasColor===1) probs[1] = Math.min(1, probs[1]*BOOST_BLUE_MULT) // blue boost

    const Z = probs.reduce((a,b)=>a+b,0)||1
    probs = probs.map(x=>x/Z)

    return { regime, biasColor, probs, lcb, pEXP, pOBS, pMKV, tags, chiP, kl, streak, cycleScore }
  }
}

// ============================== CORE RUNNER =============================
async function runForAccount({ idxAcc, cookie, baseBet, baseIndex, rounds, dispatcher, logEvery, uiMode, uiRows }) {
  console.log(`\n===== ACCOUNT #${idxAcc + 1} =====`)
  const ts = new DirichletTS(4)
  ts.setAlpha(priorFromMultipliers(ts.getMults(), 800))

  const detector = new RegimeDetector()

  let pnl = 0
  let prevBalance = null
  let cooldownLeft = 0
  const recentWins = []
  const recentNets = []
  let lastLandedIdx = null // <-- NEW: nhớ màu vừa ra để warmup bám theo

  const printer =
    uiMode === 'dashboard' ? createDashboard(uiRows) :
    uiMode === 'pretty'    ? createPrettyPrinter(25) :
                             null

  let r = 0
  while (true){
    if (rounds>0 && r>=rounds) break
    const thisRound = r+1

    // ===== pick arm
    let arm, reason=[], pLCB=null, pMean=null, multEst=null, evLCB=null, edgeMean=null, betFactor=EV_GATE_FACTOR, kellyEff=0
    if (Number.isFinite(baseIndex)) { arm = baseIndex; reason.push('FORCE_IDX') }
    else if (thisRound <= WARMUP_ROUNDS) {
      // --- SMART WARMUP: follow last landed if available; else take detector's best (fallback GREEN)
      if (lastLandedIdx!=null && lastLandedIdx>=0 && lastLandedIdx<4) {
        arm = lastLandedIdx; reason.push('WARMUP-FOLLOW')
      } else {
        const dec0 = detector.decideWeights()
        if (dec0 && Array.isArray(dec0.probs)) {
          let best=3, bv=-Infinity
          for (let i=0;i<4;i++){ if (dec0.probs[i]>bv){ bv=dec0.probs[i]; best=i } }
          arm = best; reason.push('WARMUP-SMART')
        } else {
          arm = 3; reason.push('WARMUP-GREEN') // highest base prob
        }
      }
    } else {
      const dec = detector.decideWeights()
      const { regime, biasColor, probs, lcb, tags } = dec
      let u=Math.random(), cdf=0; arm=3
      for(let i=0;i<4;i++){ cdf+=probs[i]; if(u<=cdf){ arm=i; break } }
      reason.push(regime, ...tags)
      if (typeof biasColor==='number') reason.push(`BIAS->${INDEX_TO_COLOR[biasColor]}`)

      pLCB = lcb[arm]
      pMean = ts.postMean()[arm]
      multEst = ts.getMults()[arm]
      evLCB = pLCB*multEst - 1
      edgeMean = pMean*multEst - 1

      let riskBoost = 1.0
      if (regime.startsWith('REG-STREAK') || regime.startsWith('REG-BIAS')) {
        if (arm===COLOR_TO_INDEX.BLUE || arm===COLOR_TO_INDEX.GOLD) riskBoost = RISK_BOOST_BLUE_GOLD
      }

      kellyEff = clamp(kellyFraction(Math.max(pLCB,0), multEst) * RISK_AVERSION * riskBoost, 0, KELLY_CAP)
      if (evLCB <= 0) betFactor = EV_GATE_FACTOR
      else betFactor = clamp(1 + 0.4*edgeMean + kellyEff, BET_MIN_FACTOR, BET_MAX_FACTOR)

      const rollWins = recentWins.reduce((s,v)=>s+v,0)
      const rollRate = recentWins.length ? rollWins / recentWins.length : 1
      if (cooldownLeft > 0 || (recentWins.length >= ROLL_N && rollRate < ROLL_MIN_WINRATE)) cooldownLeft = Math.max(cooldownLeft, COOLDOWN_ROUNDS)
      if (cooldownLeft > 0) { betFactor = Math.min(betFactor, COOLDOWN_BET_FACTOR); reason.push('COOLDOWN') }

      recentNets.push( (recentNets.length && recentNets[recentNets.length-1]>0)? 1 : -1 )
      if (recentNets.length>80) recentNets.shift()
      const sigma = Math.sqrt(Math.max(1e-6, variance(recentNets)))
      const varCap = 1 / (1 + VAR_CAP_SIGMA*sigma)
      betFactor = betFactor * clamp(varCap, 0.4, 1.0)
    }

    const color = INDEX_TO_COLOR[arm] || `IDX_${arm}`
    if (pMean == null) { pMean = ts.postMean()[arm]; multEst = ts.getMults()[arm]; edgeMean = pMean*multEst - 1; }
    if (pLCB == null)  { const a=ts.getAlpha(); const S=a.reduce((s,v)=>s+v,0); const ai=a[arm]; const v=(ai*(S-ai))/(S*S*(S+1)); const sd=Math.sqrt(Math.max(1e-12,v)); pLCB = Math.max(0, (ai/S) - 2.33*sd); evLCB = pLCB*multEst-1 }

    const bankroll = (typeof prevBalance==='number') ? prevBalance : Infinity
    const bankCap = Number.isFinite(bankroll) ? Math.floor(bankroll * MAX_BANK_FRAC) : Infinity
    const baseUsed = clamp(Math.floor(baseBet * betFactor), 1, bankCap)
    const betUsed = Math.max(1, baseUsed)

    // ===== HTTP
    const { ok, status, text } = await spinOnce({ cookie, betAmount: betUsed, armIndex: arm, dispatcher })
    const raw = safeJsonParse(text)
    const outcome = extractOutcome(raw)

    // ===== landed color: ưu tiên index, map "YELLOW" -> GOLD
    const landedIdx = (typeof outcome.landedIndex === 'number')
      ? outcome.landedIndex
      : (typeof outcome.color === 'string' ? COLOR_TO_INDEX[outcome.color.toUpperCase()] : null)

    const landedColorName =
      colorNameFromIndexSafe(landedIdx) || 'UNKNOWN'

    // Learn & update
    if (Number.isInteger(outcome.landedIndex)) ts.updateFromLanded(outcome.landedIndex)
    ts.decay(DECAY)
    if (typeof outcome.payout === 'number' && outcome.payout > 0 && landedIdx === arm) {
      ts.learnMultiplier(arm, outcome.payout / betUsed)
    }

    detector.observe(landedIdx)

    // ===== PnL strict: chỉ thắng khi cùng màu (so theo index)
    const pickedColorName = color
    const matched = (typeof landedIdx === 'number')
      ? (landedIdx === arm)
      : (landedColorName === pickedColorName)

    let payoutVal = 0
    if (matched) {
      if (typeof outcome.payout === 'number' && outcome.payout > 0) {
        payoutVal = outcome.payout
      } else {
        payoutVal = Math.round(betUsed * MULTIPLIERS[arm])
      }
    } else {
      payoutVal = 0
    }

    // Reward bandits theo kết quả đúng/sai
    if (typeof landedIdx==='number') {
      detector.exp3.reward(arm, matched ? 1 : 0)
      detector.ucb.reward(arm, matched ? 1 : 0)
    }

    // ===== Net/PnL: strict theo bet & match màu
    let net = payoutVal - betUsed
    pnl += net
    if (typeof outcome.balance === 'number') prevBalance = outcome.balance

    // nhớ màu vừa ra để warmup bám theo ở vòng kế
    if (typeof landedIdx === 'number') lastLandedIdx = landedIdx

    recentWins.push(net>0?1:0)
    if (recentWins.length > ROLL_N) recentWins.shift()
    if (cooldownLeft > 0) cooldownLeft--

    const tags = reason

    const rowObj = {
      acc: idxAcc+1, round: thisRound, rounds,
      betBase: baseBet, betUsed, betFactor,
      index: arm, color, pMean, pLCB, multEst, evLCB, edgeMean,
      landedName: landedColorName, payout: payoutVal, net, pnl, status, tags
    }

    if ((r % logEvery) === 0){
      if (uiMode === 'dashboard') printer.push(rowObj)
      else if (uiMode === 'pretty') printer.push(rowObj)
      else printPlain(rowObj)
    }

    appendLog({
      round: thisRound,
      acc: idxAcc+1,
      betBase: baseBet,
      betUsed,
      betFactor,
      index: arm,
      color,
      ok, status,
      landedIndex: landedIdx,
      payout: payoutVal,               // ghi payout đã chuẩn hóa
      balance: outcome.balance,
      pMean, pLCB,
      multEst,
      evLCB,
      edgeMean,
      kelly: kellyEff,
      net,
      pnl,
      reason: tags,
      alpha: ts.getAlpha(),
      mults: ts.getMults(),
      detector: { recentWins: mean(recentWins), cooldownLeft },
      raw: outcome.raw
    })

    if (typeof TAKE_PROFIT === 'number' && pnl >= TAKE_PROFIT) { console.log('🎯 Take-profit đạt, dừng.'); break }
    if (typeof STOP_LOSS === 'number' && pnl <= STOP_LOSS) { console.log('🛑 Stop-loss kích hoạt, dừng.'); break }

    await waitMs(randInt(MIN_DELAY, MAX_DELAY))
    r++
  }
}

// ============================== CLI / MAIN ==============================
async function promptBetIfNeeded() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = q => new Promise(res => rl.question(q, v => res(v)))
  let v = await ask(`Nhập số AP để bet (mặc định 1000): `)
  rl.close()
  v = v.trim()
  const n = Number(v || '1000')
  return (!Number.isFinite(n) || n <= 0) ? 1000 : n
}
function parseCli() {
  const get = (k, d = null) => {
    const arg = process.argv.find(a => a.startsWith(`--${k}=`))
    return arg ? arg.split('=')[1] : d
  }
  let rounds = get('rounds', DEFAULT_ROUNDS)
  rounds = Number(rounds)
  if (!Number.isFinite(rounds)) rounds = DEFAULT_ROUNDS
  const mult = get('mult', null)
  const logEvery = Number(get('log-every', 1)) || 1
  const uiMode  = (get('ui','dashboard') || 'dashboard').toLowerCase() // plain | pretty | dashboard
  const uiRows  = Number(get('ui-rows', 22)) || 22
  if (mult) {
    const arr = mult.split(',').map(Number)
    if (arr.length === 4 && arr.every(Number.isFinite)) MULTIPLIERS = arr
  }
  return { rounds, logEvery, uiMode, uiRows }
}
function parseProxiesSafe() { try { return parseProxies('proxy.txt') } catch { return [] } }

async function main() {
  ensureLogHeader()
  const accounts = parseAccounts('data.txt')
  if (!accounts.length) { console.error('❌ Không tìm thấy tài khoản trong data.txt'); process.exit(1) }
  const proxies = parseProxiesSafe()
  const { rounds, logEvery, uiMode, uiRows } = parseCli()

  const allHaveBet = accounts.every(a => Number.isFinite(a.bet) && a.bet > 0)
  const promptBet = allHaveBet ? null : await promptBetIfNeeded()

  for (let k=0; k<accounts.length; k++){
    const a = accounts[k]
    if (!a.cookie){ console.log(`[ACC #${k+1}] thiếu cookie, bỏ qua.`); continue }
    const baseBet = Number.isFinite(a.bet) && a.bet > 0 ? a.bet : (promptBet ?? 1000)
    const baseIndex = Number.isFinite(a.index) ? a.index : NaN
    const dispatcher = pickProxyAgent(proxies, k) || undefined
    await runForAccount({ idxAcc:k, cookie:a.cookie, baseBet, baseIndex, rounds, dispatcher, logEvery, uiMode, uiRows })
  }
  console.log('\n✔️ Hoàn tất.')
}
main().catch(e=>{ console.error(e); process.exit(1) })
