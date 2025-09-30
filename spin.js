// spin.js v2.7 (STRICT) — Win IFF pickColor == landedColor; PnL = payoutOr0 - bet; infinite run; colored logs
// by CQ

import fs from 'fs'
import readline from 'readline'
import { fetch, ProxyAgent } from 'undici'

// ==================== CONFIG ====================
const BASE_URL = 'https://app.appleville.xyz'
const ENDPOINT = `${BASE_URL}/api/trpc/cave.wheelSpin.spin?batch=1`

const INDEX_TO_COLOR = ['RED', 'BLUE', 'GOLD', 'GREEN']
const COLOR_TO_INDEX = { RED: 0, BLUE: 1, GOLD: 2, YELLOW: 2, GREEN: 3 }

// Payout fixed đúng theo ảnh
const MULTIPLIERS = [150, 5, 20, 1.15]

// Prior theo odds đúng theo ảnh
const PRIOR_ODDS = [0.005, 0.15, 0.04, 0.805] // [RED, BLUE, GOLD, GREEN]
const PRIOR_STRENGTH = 2000 // Số "mẫu ảo"

// Học phân phối (soft) để thích nghi nhẹ
const WARMUP_ROUNDS  = 24
const DECAY          = 0.99995

// Exploration
const EPS_START = 0.03
const EPS_END   = 0.01
function epsAtRound(r){ return Math.max(EPS_END, EPS_START * Math.exp(-r/400)) }

// Sizing tương đối
const KELLY_CAP       = 0.15
const BET_MIN_FACTOR  = 0.30
const BET_MAX_FACTOR  = 1.10
const RISK_AVERSION   = 0.75

// Sizing tuyệt đối — tránh “bet to là thua”
const ABS_SCOUT = 1000    // mức thăm dò cố định khi EV<=0/cooldown
const ABS_MAX   = 6000    // trần tuyệt đối cho 1 lệnh

// Cooldown & gate
const EV_GATE_FACTOR      = 0.20
const ROLL_N              = 40
const ROLL_MIN_WINRATE    = 0.28
const COOLDOWN_ROUNDS     = 20
const COOLDOWN_BET_FACTOR = 0.25

// HTTP
const MIN_DELAY = 900
const MAX_DELAY = 2200
const RETRIES   = 3
const BACKOFF_BASE = 600

// Log
const LOG_FILE = 'spin-log.csv'
// =================================================

const waitMs = (ms) => new Promise(r => setTimeout(r, ms))
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a

// ===== CSV / number fmt =====
function csv(v){ if (v==null) return ''; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s }
const nf = (n,d=4)=> (typeof n==='number' && isFinite(n)) ? Number(n).toFixed(d) : ''
const ni = (n)=> (typeof n==='number' && isFinite(n)) ? Math.round(n) : ''
const pfx = (n)=> (n>=0?`+${n}`:`${n}`)

// ===== IO =====
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

// ===== Parse response (robust JSONL) =====
function parseJsonlCandidates(text){
  const lines = String(text).split('\n').filter(Boolean)
  const objs = []
  for (const line of lines){
    try { objs.push(JSON.parse(line)) } catch {}
  }
  if (!objs.length){
    try { objs.push(JSON.parse(text)) } catch {}
  }
  return objs
}
function huntCandidates(x, acc=[]){
  if (!x || typeof x !== 'object') return acc
  const has = ('winningIndex' in x) || ('resultIndex' in x) || ('winAmount' in x) ||
              ('payout' in x) || ('isWin' in x) || ('winningColor' in x)
  if (has) acc.push(x)
  if (Array.isArray(x)){
    for (const it of x) huntCandidates(it, acc)
  } else {
    for (const k of Object.keys(x)) huntCandidates(x[k], acc)
  }
  return acc
}
function scoreOutcomeNode(n){
  let sc = 0
  if ('winningIndex' in n) sc += 3
  if ('resultIndex'  in n) sc += 2
  if ('winningColor' in n) sc += 2
  if ('isWin'        in n) sc += 1
  if ('winAmount'    in n) sc += 2
  if ('payout'       in n) sc += 2
  return sc
}
function extractOutcomeStrict(text){
  const roots = parseJsonlCandidates(text)
  const all = []
  for (const r of roots) huntCandidates(r, all)
  if (!all.length) return { landedIndex: undefined, color: undefined, raw: roots[roots.length-1] ?? text }

  let best = null, bestScore = -1
  for (const c of all){
    const s = scoreOutcomeNode(c)
    if (s >= bestScore){ bestScore = s; best = c }
  }

  const landedIndex =
    (typeof best?.winningIndex === 'number' ? best.winningIndex : undefined) ??
    (typeof best?.resultIndex  === 'number' ? best.resultIndex  : undefined)
  const color = (typeof best?.winningColor === 'string' ? best.winningColor.toUpperCase() : undefined)

  return { landedIndex, color, raw: best }
}

// ===== Math utils =====
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

// ===== Prior từ odds =====
function priorFromOdds(odds, S0=PRIOR_STRENGTH){
  return odds.map(p => Math.max(1, p * S0))
}

// ===== Dirichlet TS (không học multiplier) =====
class DirichletTS {
  constructor(K, initAlpha=1){
    this.K = K
    this.alpha = Array(K).fill(initAlpha)
  }
  setAlpha(a){ if (Array.isArray(a) && a.length===this.K) this.alpha = a.slice() }
  decay(f=DECAY){ for (let i=0;i<this.K;i++) this.alpha[i] = Math.max(1, this.alpha[i]*f) }
  updateFromLanded(idx){ if (Number.isInteger(idx) && idx>=0 && idx<this.K) this.alpha[idx] += 1 }
  postMean(){ const S = this.alpha.reduce((s,v)=>s+v,0); return this.alpha.map(a=>a/S) }
  getAlpha(){ return this.alpha.slice() }

  static pLCB(alpha, i, z=2.33){
    const S = alpha.reduce((s,v)=>s+v,0)
    const ai = alpha[i]
    const mean = ai / S
    const v = (ai * (S - ai)) / (S*S*(S+1))
    const sd = Math.sqrt(Math.max(1e-12, v))
    return { mean, var:v, sd, lcb: Math.max(0, mean - z*sd) }
  }

  chooseArmLCB(epsilon = 0.01, mults = MULTIPLIERS){
    if (Math.random() < epsilon) return { arm: randInt(0,this.K-1), ev: null, lcb: null, mean: null, v:null }
    const a = this.alpha
    let best = 0, bestScore = -Infinity, bestLCB=0, bestMean=0, bestVar=0
    for (let k=0;k<this.K;k++){
      const {mean, var:v, lcb} = DirichletTS.pLCB(a, k, 2.33)
      const ev = lcb * mults[k] - 1
      if (ev > bestScore){ bestScore = ev; best = k; bestLCB=lcb; bestMean=mean; bestVar=v }
    }
    return { arm: best, ev: bestScore, lcb: bestLCB, mean: bestMean, v: bestVar }
  }
}

// Kelly
function kellyFraction(p, mult){
  const b = Math.max(1e-9, mult - 1), q = 1 - p
  return Math.max(0, (b*p - q)/b)
}
function clamp(x,lo,hi){ return Math.min(hi, Math.max(lo,x)) }

// ===== HTTP =====
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

// ===== CSV header =====
function ensureLogHeader(){
  if (!fs.existsSync(LOG_FILE)){
    fs.writeFileSync(LOG_FILE,
      [
        'ts','round','acc','bet_base','bet_used','bet_factor','index','color',
        'ok','status','landedIndex','payout_used',
        'p_mean','p_lcb','mult_est','EV_LCB','edge_mean',
        'kelly','net','pnl','reason','alpha','raw'
      ].join(',')+'\n'
    )
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
    csv(row.payoutUsed ?? ''),
    csv(nf(row.pMean,6)),
    csv(nf(row.pLCB,6)),
    csv(nf(row.multEst,6)),
    csv(nf(row.evLCB,6)),
    csv(nf(row.edgeMean,6)),
    csv(nf(row.kelly,6)),
    csv(row.net),
    csv(row.pnl),
    csv(row.reason),
    csv(JSON.stringify(row.alpha)),
    csv(JSON.stringify(row.raw))
  ].join(',')+'\n'
  fs.appendFileSync(LOG_FILE, line)
}

// ======================= UI LAYER =======================
// ANSI colors + backgrounds
const C = {
  none: s=>s,
  bold:  s=>`\x1b[1m${s}\x1b[0m`,
  red:   s=>`\x1b[31m${s}\x1b[0m`,
  green: s=>`\x1b[32m${s}\x1b[0m`,
  yellow:s=>`\x1b[33m${s}\x1b[0m`,
  blue:  s=>`\x1b[34m${s}\x1b[0m`,
  bgRed:    s=>`\x1b[41m\x1b[97m${s}\x1b[0m`,
  bgBlue:   s=>`\x1b[44m\x1b[97m${s}\x1b[0m`,
  bgYellow: s=>`\x1b[43m\x1b[30m${s}\x1b[0m`,
  bgGreen:  s=>`\x1b[42m\x1b[30m${s}\x1b[0m`,
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
  if (align === 'center') { const l = Math.floor(pad/2), r = pad - l; return ' '.repeat(l) + s + ' '.repeat(r) }
  return s + ' '.repeat(pad)
}

// Column widths
const COL = {
  round: 8,  pick: 6,  color: 7,  p: 7,  lcb: 7,
  mult: 6,   EV: 7,    edge: 7,   baseUsed: 18,
  landed: 8, payout: 10, net: 10,  pnl: 12, tags: 24
}
function colorChip(name, bg=false){
  const up = String(name||'').toUpperCase()
  if (!bg){
    if (up==='RED')   return C.red(up)
    if (up==='BLUE')  return C.blue(up)
    if (up==='GOLD')  return C.yellow(up)
    if (up==='GREEN') return C.green(up)
    return up
  }
  if (up==='RED')   return C.bgRed(up)
  if (up==='BLUE')  return C.bgBlue(up)
  if (up==='GOLD')  return C.bgYellow(up)
  if (up==='GREEN') return C.bgGreen(up)
  return up
}
function makeHeader(sep=' │ '){
  return [
    ['r',COL.round,'right'], ['pick',COL.pick], ['color',COL.color],
    ['p',COL.p,'right'], ['lcb',COL.lcb,'right'], ['mult',COL.mult,'right'],
    ['EV',COL.EV,'right'], ['edge',COL.edge,'right'],
    ['base->used',COL.baseUsed], ['landed',COL.landed],
    ['payoutUsed',COL.payout,'right'], ['net',COL.net,'right'], ['pnl',COL.pnl,'right'],
    ['tags',COL.tags]
  ].map(([t,w,a])=> padAnsi(t,w,a)).join(' │ ')
}
function makeRow(o, sep=' │ '){
  const evTxt   = (o.evLCB<=0 ? C.red(nf(o.evLCB,4)) : C.green(nf(o.evLCB,4)))
  const edgeTxt = (o.edgeMean<=0 ? C.red(nf(o.edgeMean,4)) : C.green(nf(o.edgeMean,4)))
  const netTxt  = (o.net>=0 ? C.green(pfx(ni(o.net))) : C.red(pfx(ni(o.net))))
  const pnlTxt  = (o.pnl>=0 ? C.green(pfx(ni(o.pnl))) : C.red(pfx(ni(o.pnl))))
  const pickTxt   = colorChip(o.color, true)
  const landedTxt = colorChip(o.landedName, true)
  const tags = (o.tags||[]).join('|')

  const cells = [
    padAnsi(`${o.round}`, COL.round, 'right'),
    padAnsi(o.index,                  COL.pick,  'right'),
    padAnsi(pickTxt,                  COL.color),
    padAnsi(nf(o.pMean,4),            COL.p,     'right'),
    padAnsi(nf(o.pLCB,4),             COL.lcb,   'right'),
    padAnsi(nf(o.multEst,3),          COL.mult,  'right'),
    padAnsi(evTxt,                    COL.EV,    'right'),
    padAnsi(edgeTxt,                  COL.edge,  'right'),
    padAnsi(`${o.betBase}->${o.betUsed}(${nf(o.betFactor,2)})`, COL.baseUsed),
    padAnsi(truncAnsi(landedTxt, COL.landed), COL.landed),
    padAnsi(nf(o.payoutUsed,2),       COL.payout,'right'),
    padAnsi(netTxt,                   COL.net,   'right'),
    padAnsi(pnlTxt,                   COL.pnl,   'right'),
    padAnsi(truncAnsi(tags, COL.tags),COL.tags)
  ]
  return cells.join(sep)
}
const HR = (h)=> '─'.repeat(h.length)
function createPrettyPrinter(repeatHeaderEvery=25){
  let n=0
  const header = makeHeader(' │ ')
  const line = HR(header)
  return {
    push(row){
      if (n % repeatHeaderEvery === 0){ console.log(line); console.log(header); console.log(line) }
      console.log(makeRow(row, ' │ '))
      n++
    }
  }
}

// ==================== RUN 1 ACCOUNT (INFINITE) ====================
async function runForAccount({ idxAcc, cookie, baseBet, baseIndex, roundsLimit, dispatcher, logEvery, uiMode }) {
  console.log(`\n===== ACCOUNT #${idxAcc + 1} =====`)
  const ts = new DirichletTS(4)
  ts.setAlpha(priorFromOdds(PRIOR_ODDS, PRIOR_STRENGTH))

  let pnl = 0
  let cooldownLeft = 0
  const recentWins = []

  const printer = createPrettyPrinter(25) // luôn pretty có màu; dùng terminal hỗ trợ ANSI

  for (let r=1; ; r++){ // chạy vô hạn; dừng nếu roundsLimit được set
    if (Number.isFinite(roundsLimit) && r > roundsLimit) break

    // pick
    let arm, evLCB=null, pLCB=null, pMean=null, reason=[]
    if (Number.isFinite(baseIndex)) { arm = baseIndex; reason.push('FORCE_IDX') }
    else if (r <= WARMUP_ROUNDS)     { arm = (r-1) % 4; reason.push('WARMUP') }
    else {
      const pick = ts.chooseArmLCB(epsAtRound(r), MULTIPLIERS)
      arm = pick.arm; evLCB = pick.ev; pLCB = pick.lcb; pMean = pick.mean
    }
    const color = INDEX_TO_COLOR[arm] || `IDX_${arm}`
    if (pMean == null) pMean = ts.postMean()[arm]
    if (pLCB == null) pLCB = DirichletTS.pLCB(ts.getAlpha(), arm, 2.33).lcb
    const multEst  = MULTIPLIERS[arm]
    const edgeMean = pMean * multEst - 1
    if (evLCB == null) evLCB = pLCB * multEst - 1 // safety gate

    const kelly = clamp(kellyFraction(pMean, multEst) * RISK_AVERSION, 0, KELLY_CAP)

    // ---- SIZING ----
    let betFactor = EV_GATE_FACTOR
    let betUsed
    const rollWins = recentWins.reduce((s,v)=>s+v,0)
    const rollRate = recentWins.length ? rollWins / recentWins.length : 1
    const inCooldown = (cooldownLeft > 0) || (recentWins.length >= ROLL_N && rollRate < ROLL_MIN_WINRATE)
    if (inCooldown) cooldownLeft = Math.max(cooldownLeft, COOLDOWN_ROUNDS)
    if (inCooldown) reason.push('COOLDOWN')

    if (r <= WARMUP_ROUNDS || evLCB <= 0) {
      reason.push('EV<=0')
      betUsed = ABS_SCOUT
      betFactor = betUsed / baseBet
    } else {
      const tier =
        evLCB > 0.15 ? 1.00 :
        evLCB > 0.05 ? 0.60 :
                       0.35
      const rawFactor = 1 + 0.4*edgeMean + kelly
      betFactor = clamp(rawFactor * tier, BET_MIN_FACTOR, BET_MAX_FACTOR)
      if (inCooldown) betFactor = Math.min(betFactor, COOLDOWN_BET_FACTOR)
      betUsed = Math.max(1, Math.floor(baseBet * betFactor))
      if (typeof ABS_MAX === 'number') betUsed = Math.min(betUsed, ABS_MAX)
      betUsed = Math.max(betUsed, Math.min(ABS_SCOUT, baseBet))
    }

    // spin
    const { ok, status, text } = await spinOnce({ cookie, betAmount: betUsed, armIndex: arm, dispatcher })

    // outcome: chỉ lấy landedIndex/màu
    const outcome = extractOutcomeStrict(text)
    const landedIndex = outcome.landedIndex
    const landedName  = outcome.color || (Number.isInteger(landedIndex) ? (INDEX_TO_COLOR[landedIndex] ?? landedIndex) : 'unknown')

    // STRICT: win IFF arm == landedIndex
    const winnerMatch = Number.isInteger(landedIndex) && landedIndex === arm
    const payoutUsed  = winnerMatch ? Number((betUsed * multEst).toFixed(2)) : 0
    const net         = payoutUsed - betUsed
    pnl += net

    // update model
    if (Number.isInteger(landedIndex)) ts.updateFromLanded(landedIndex)
    ts.decay(DECAY)

    // rolling window
    recentWins.push(winnerMatch ? 1 : 0)
    if (recentWins.length > ROLL_N) recentWins.shift()
    if (cooldownLeft > 0) cooldownLeft--

    // row
    const rowObj = {
      acc: idxAcc+1, round: r,
      betBase: baseBet, betUsed, betFactor,
      index: arm, color,
      pMean, pLCB, multEst, evLCB, edgeMean,
      landedName, payoutUsed, net, pnl, status, tags: reason
    }

    if ((r % logEvery) === 0) {
      if (uiMode === 'pretty') printer.push(rowObj)
      else { // clean/plain nếu muốn, vẫn in pretty làm mặc định
        printer.push(rowObj)
      }
    }

    // CSV
    appendLog({
      round: r,
      acc: idxAcc+1,
      betBase: baseBet,
      betUsed,
      betFactor,
      index: arm,
      color,
      ok, status,
      landedIndex,
      payoutUsed,
      pMean, pLCB,
      multEst,
      evLCB,
      edgeMean,
      kelly: clamp(kellyFraction(pMean, multEst) * RISK_AVERSION, 0, KELLY_CAP),
      net,
      pnl,
      reason: reason.join('|'),
      alpha: ts.getAlpha(),
      raw: outcome.raw
    })

    await waitMs(randInt(MIN_DELAY, MAX_DELAY))
    if (Number.isFinite(roundsLimit) && r >= roundsLimit) break
  }
}

// ==================== CLI / Main ====================
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
  const roundsCli = Number(get('rounds', NaN)) // NaN -> infinite
  const logEvery = Number(get('log-every', 1)) || 1
  const uiMode  = (get('ui','pretty') || 'pretty').toLowerCase() // pretty|clean (pretty mặc định)
  return { roundsCli, logEvery, uiMode }
}
function parseProxiesSafe() { try { return parseProxies('proxy.txt') } catch { return [] } }

async function main() {
  ensureLogHeader()
  const accounts = parseAccounts('data.txt')
  if (!accounts.length) { console.error('❌ Không tìm thấy tài khoản trong data.txt'); process.exit(1) }
  const proxies = parseProxiesSafe()
  const { roundsCli, logEvery, uiMode } = parseCli()

  const allHaveBet = accounts.every(a => Number.isFinite(a.bet) && a.bet > 0)
  const promptBet = allHaveBet ? null : await promptBetIfNeeded()

  for (let k=0; k<accounts.length; k++){
    const a = accounts[k]
    if (!a.cookie){ console.log(`[ACC #${k+1}] thiếu cookie, bỏ qua.`); continue }
    const baseBet   = Number.isFinite(a.bet) && a.bet > 0 ? a.bet : (promptBet ?? 1000)
    const baseIndex = Number.isFinite(a.index) ? a.index : NaN
    const dispatcher = pickProxyAgent(proxies, k) || undefined
    await runForAccount({ idxAcc:k, cookie:a.cookie, baseBet, baseIndex, roundsLimit: roundsCli, dispatcher, logEvery, uiMode })
  }
  console.log('\n✔️ Hoàn tất.')
}
main().catch(e=>{ console.error(e); process.exit(1) })
