// spin2.js — ESM (project có "type":"module")
// npm i undici

import fs from 'fs'
import { fetch, ProxyAgent } from 'undici'

// ================== Endpoint ==================
const BASE_URL = 'https://app.appleville.xyz'
const ENDPOINT = `${BASE_URL}/api/trpc/cave.wheelSpin.spin?batch=1`

// Màu ↔ index
const INDEX_TO_COLOR = ['RED', 'BLUE', 'GOLD', 'GREEN']
const COLOR_TO_INDEX = { RED: 0, BLUE: 1, GOLD: 2, YELLOW: 2, GREEN: 3 }

// Multiplier ước lượng [RED, BLUE, GOLD, GREEN] (sửa nếu UI khác)
const MULT = [150, 5, 20, 1.15]

// ================== Auto tuning (không cần tham số) ==================
// Bet
const BASE_BET   = 1000
const MIN_BET    = 100
const MAX_BET    = 5000
const KELLY_FRAC = 0.25

// Học & ra quyết định
const W1 = 40        // cửa sổ ngắn
const W2 = 220       // cửa sổ trung
const Z_UCB = 2.1    // upper bound hơi bảo thủ
// Prior Dirichlet nhẹ: thiên GREEN nhưng không khoá các màu khác
const PRIOR = [0.2, 0.8, 0.2, 2.2]

// Anti-green mode
const ANTI_WIN = 0.8696    // ngưỡng p* để GREEN hoà vốn (1/1.15≈0.8696)
const ANTI_TRIG = -0.02    // nếu EV(GREEN) < -2% (cửa sổ ngắn) → kích hoạt anti-green
const ANTI_HOLD = 25       // giữ anti-green ít nhất 25 lượt sau khi kích hoạt

// Nhịp & backoff
const DELAY_FAST    = [180, 420]
const DELAY_BACKOFF = [2200, 4200]

// Stop/Take (tuỳ chọn – để null nếu không dùng)
const STOP_LOSS   = null
const TAKE_PROFIT = null

// Log
const LOG_EVERY = 1 // log từng lệnh

// ================== Tiện ích ==================
const sleep = (ms)=> new Promise(r=> setTimeout(r, ms))
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a
const clamp = (x, lo, hi)=> Math.max(lo, Math.min(hi, x))

const readLines = p => fs.existsSync(p)
  ? fs.readFileSync(p,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
  : []

const loadAccounts = ()=> readLines('data.txt').map((line,i)=>({ i, cookie: line.split('\t')[0] }))
const loadProxies  = ()=> readLines('proxy.txt')
const pickProxy = (list,i)=> list.length? new ProxyAgent(list[i%list.length]): null

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
const bodyFor = (idx, bet)=> JSON.stringify({'0':{json:{selectedIndex:idx, betAmount:bet}}})

function parseJSON(text){
  try { return JSON.parse(text) } catch {
    const arr = text.split('\n').filter(Boolean)
    if (arr.length===1){ try{ return JSON.parse(arr[0]) } catch { return text } }
    return arr.map(l=>{ try{ return JSON.parse(l) } catch { return {raw:l} } })
  }
}
function extractOutcome(raw){
  const hunt = (x)=>{
    if(!x||typeof x!=='object') return null
    if('winningIndex'in x||'winningColor'in x||'isWin'in x||'winAmount'in x) return x
    if(Array.isArray(x)){ for(const it of x){ const f=hunt(it); if(f) return f } return null }
    for(const k of Object.keys(x)){ const f=hunt(x[k]); if(f) return f }
    return null
  }
  const n = hunt(raw) || (Array.isArray(raw)? raw.at(-1) : raw)
  const landedIndex = typeof n?.winningIndex==='number' ? n.winningIndex
                    : (typeof n?.resultIndex==='number'? n.resultIndex : undefined)
  const color = typeof n?.winningColor==='string' ? n.winningColor.toUpperCase()
               : (typeof landedIndex==='number'? INDEX_TO_COLOR[landedIndex] : undefined)
  const payout = typeof n?.winAmount==='number' ? n.winAmount
               : (typeof n?.payout==='number' ? n.payout : undefined)
  const balance = typeof n?.newBalance==='number' ? n.newBalance
                : (typeof n?.balance==='number' ? n.balance : undefined)
  return { landedIndex, color, payout, balance, raw:n||raw }
}
async function spin({cookie, idx, bet, dispatcher}){
  const res = await fetch(ENDPOINT, {
    method:'POST',
    headers: headersFor(cookie),
    body: bodyFor(idx,bet),
    dispatcher
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, parsed: parseJSON(text) }
}

// ================== Bộ học (hai cửa sổ + Dirichlet) ==================
class DualWindow {
  constructor(k=4, n1=W1, n2=W2, prior=PRIOR){
    this.k=k
    this.n1=n1; this.q1=[]; this.c1=Array(k).fill(0)
    this.n2=n2; this.q2=[]; this.c2=Array(k).fill(0)
    this.prior = prior.slice()
  }
  push(idx){
    if(typeof idx!=='number') return
    // w1
    this.q1.push(idx); this.c1[idx]++
    if(this.q1.length>this.n1){ const old=this.q1.shift(); this.c1[old]-- }
    // w2
    this.q2.push(idx); this.c2[idx]++
    if(this.q2.length>this.n2){ const old=this.q2.shift(); this.c2[old]-- }
  }
  total(){ return this.q2.length }
  pMeanW1(a){ // Dirichlet mean (cửa sổ ngắn)
    const N=this.q1.length; const S=this.prior.reduce((s,x)=>s+x,0)
    return (this.c1[a]+this.prior[a])/(N+S||1)
  }
  pMeanW2(a){ // Dirichlet mean (cửa sổ trung)
    const N=this.q2.length; const S=this.prior.reduce((s,x)=>s+x,0)
    return (this.c2[a]+this.prior[a])/(N+S||1)
  }
  pUpperW2(a, z=Z_UCB){
    const N=this.q2.length; const S=this.prior.reduce((s,x)=>s+x,0)
    if(N===0) return 0
    const x = this.c2[a] + this.prior[a]
    const nEff = N + S
    const ph = x / nEff
    const m  = ph + z*z/(2*nEff)
    const s2 = (ph*(1-ph) + z*z/(4*nEff)) / nEff
    const d  = z*Math.sqrt(s2)
    const den= 1 + z*z/nEff
    return clamp((m + d)/den, 0, 1)
  }
  // Thompson Sampling (trên cửa sổ trung)
  sampleTS(){
    const N=this.q2.length; const S=this.prior.reduce((s,x)=>s+x,0)
    const out = Array(this.k).fill(0).map((_,a)=>{
      const alpha = this.c2[a] + this.prior[a]
      const beta  = (N - this.c2[a]) + (S - this.prior[a])
      // sample beta(alpha,beta) (approx qua gaussian cho tốc độ)
      const mu = alpha/(alpha+beta)
      const var_ = (alpha*beta)/((alpha+beta)**2*(alpha+beta+1))
      // tránh âm/dương do xấp xỉ
      const eps = Math.sqrt(Math.max(var_, 1e-9)) * (Math.random()*2-1)
      return clamp(mu + eps, 0, 1)
    })
    return out
  }
}

// ================== Quyết định & Bet size ==================
function kellyFraction(p, m){
  const num = p*m - 1
  const den = m - 1
  if(den<=0) return 0
  return clamp(num/den, 0, 1)
}

function chooseArm(est, antiOn){
  // Tính EV từ 3 “não”:
  // 1) EV-mean-ngắn
  const ev1 = [0,1,2,3].map(a => est.pMeanW1(a)*MULT[a] - 1)
  // 2) EV-upper-trung
  const ev2 = [0,1,2,3].map(a => est.pUpperW2(a)*MULT[a] - 1)
  // 3) Thompson sampling (trung)
  const ts = est.sampleTS()
  const ev3 = ts.map((p,a)=> p*MULT[a] - 1)

  // Nếu anti-green: giảm trọng số GREEN, ưu tiên màu có EV dương rõ rệt
  const w1= antiOn? 0.35: 0.5
  const w2= antiOn? 0.5 : 0.35
  const w3= antiOn? 0.15: 0.15

  const agg = [0,1,2,3].map(a => w1*ev1[a] + w2*ev2[a] + w3*ev3[a])

  // baseline EV GREEN (từ cửa sổ ngắn)
  const evG = ev1[3]

  // ép gating nhẹ: chỉ chọn màu khác nếu vượt EV(GREEN)+margin
  const MARGIN = antiOn ? 0.005 : 0.012
  let best = 3, bestScore = evG
  for(let a=0;a<4;a++){
    const candidate = agg[a]
    if(a!==3){
      if (!(candidate > 0 && candidate >= evG + MARGIN)) continue
    }
    if(candidate > bestScore){ bestScore=candidate; best=a }
  }
  return { arm: best, evG, evArm: bestScore }
}

function sizeBet(est, arm, evArm){
  const pM = est.pMeanW2(arm)
  const ev = pM*MULT[arm] - 1
  // Kelly 1/4 + auto-ramp theo EV
  const k  = kellyFraction(pM, MULT[arm])
  let bet = Math.max(MIN_BET, Math.round(BASE_BET * Math.max(0.05, Math.min(KELLY_FRAC, k))))
  if (ev > 0){
    const factor = clamp(1 + 10*ev, 1, MAX_BET/BASE_BET) // ramp dịu
    bet = Math.round(clamp(bet * factor, MIN_BET, MAX_BET))
  } else {
    // EV âm: co về minbet nhưng vẫn cược để giữ “liên tục”
    bet = Math.max(MIN_BET, Math.round(bet * 0.45))
  }
  return bet
}

function nextDelay(status){
  const s = String(status||'')
  if (s.startsWith('429') || s.startsWith('5')) return randInt(...DELAY_BACKOFF)
  return randInt(...DELAY_FAST)
}

// ================== Vòng chạy chính ==================
async function runAccount({ idxAcc, cookie, dispatcher }){
  console.log(`\n===== ACCOUNT #${idxAcc+1} (smart-switch v2) =====`)
  const est = new DualWindow(4, W1, W2, PRIOR)

  let t=0, pnl=0, antiTTL=0
  let lastStatus = 200

  while(true){
    t++

    // Chế độ anti-green: nếu EV(GREEN) cửa sổ ngắn < -2% → bật/duy trì
    const evG_short = est.pMeanW1(3)*MULT[3] - 1
    if (evG_short < ANTI_TRIG) antiTTL = Math.max(antiTTL, ANTI_HOLD)
    const antiOn = antiTTL > 0
    if (antiTTL > 0) antiTTL--

    // Quyết định arm
    const { arm, evG, evArm } = chooseArm(est, antiOn)
    const color = INDEX_TO_COLOR[arm]

    // Bet size
    const bet = sizeBet(est, arm, evArm)

    // Gọi API
    let res
    try{
      res = await spin({ cookie, idx: arm, bet, dispatcher })
    }catch(e){
      console.log(`[${idxAcc+1}] neterr: ${e?.message||e}`)
      await sleep(nextDelay('net'))
      continue
    }
    lastStatus = res.status

    // Parse
    const out = extractOutcome(res.parsed)
    const landed = (typeof out.landedIndex==='number') ? out.landedIndex : null
    const landedName = out.color || (landed!==null ? INDEX_TO_COLOR[landed] : 'unknown')
    const payout = (typeof out.payout==='number')
      ? out.payout
      : ((landed===arm) ? Math.round(bet*MULT[arm]) : 0)
    const net = payout - bet
    pnl += net

    if (landed!==null) est.push(landed)

    // Log từng lệnh
    if (t%LOG_EVERY===0){
      const pA = est.pMeanW2(arm), evA = pA*MULT[arm]-1
      const ag = antiOn ? ' | anti' : ''
      console.log(`[${idxAcc+1}] t=${t} bet=${bet} on ${color} → landed=${landedName} | net=${net>=0?'+':''}${net} | PnL=${pnl>=0?'+':''}${pnl} | EV(G)~${(evG*100).toFixed(1)}% EV(${color})~${(evA*100).toFixed(1)}%${ag}`)
    }

    // Stop/Take (tuỳ chọn)
    if (TAKE_PROFIT!=null && pnl>=TAKE_PROFIT){ console.log('🎯 Take-profit đạt'); break }
    if (STOP_LOSS!=null   && pnl<=STOP_LOSS){ console.log('🛑 Stop-loss kích hoạt'); break }

    await sleep(nextDelay(lastStatus))
  }
}

// ================== Main ==================
async function main(){
  const accs = loadAccounts()
  if(!accs.length){
    console.error('❌ data.txt trống hoặc thiếu.')
    process.exit(1)
  }
  const proxies = loadProxies()

  for(let i=0;i<accs.length;i++){
    const cookie = accs[i].cookie
    const dispatcher = pickProxy(proxies, i) || undefined
    await runAccount({ idxAcc:i, cookie, dispatcher })
  }
}
main().catch(e=>{ console.error(e); process.exit(1) })
