# Appleville-Bot

A smart **Wheel Spin** bot for Appleville.  
It **learns real-time probabilities** from API outcomes and **bets intelligently** using expected value (EV) with statistical safety margins.  
**No hacking / RNG tampering** — this bot only optimizes decisions from publicly returned data.

> Suggested repo: `https://github.com/nongdancryptos/Appleville-Bot.git`  
> Files in the repo root:
>
> - `spin.js` — the single-file intelligent bot (ESM).
> - `data.txt` — cookies list, one account per line.
> - `proxy.txt` *(optional)* — proxies list, one per line.
> - `README.md` — this document.

---

## 1) Requirements

- **Node.js 18+** (20+/22+ recommended).
- Stable internet connection.
- Appleville account with a **valid session cookie**.

> Check version:
> ```bash
> node -v
> ```

---

## 2) Installation

```bash
# Clone the repo
git clone https://github.com/nongdancryptos/Appleville-Bot.git
cd Appleville-Bot

# Install dependency (only one)
npm i undici
```

> The repo uses ESM (`"type":"module"` in `package.json`), so the main file is `spin-pro.js` (no `require`).

---

## 3) Configuration

### 3.1 `data.txt` (required)

- Each **line** is the **full cookie** string of an Appleville session (includes `__Host-authjs...`, `session-token=...`, etc.).  
- No header, no trailing spaces.
- Example (shortened — **do not** copy as-is):
  ```
  __Host-authjs.csrf-token=...; __Secure-authjs.callback-url=https%3A%2F%2F0.0.0.0%3A3000; session-token=eyJhbGciOi...
  ```

> Quick way to get the cookie: Log in to Appleville → open F12 **Network** → pick any request to `app.appleville.xyz` → **Headers** → **Request Headers** → **cookie** → copy the whole value.

### 3.2 `proxy.txt` (optional)

- One proxy per line:
  ```
  http://user:pass@host:port
  http://host:port
  ```
- If missing, the bot will connect directly.

---

## 4) Run

```bash
node spin.js
```

- The bot iterates **sequentially** over all accounts in `data.txt`.
- It **logs every spin**, e.g.

```
===== ACCOUNT #1 (pro) =====
[1] t=1 bet=1000 on GREEN → landed=GREEN | net=+150 | PnL=+150 | EV(G)~+1.25% EV(GREEN)~+1.25%
[1] t=2 bet=1100 on BLUE  → landed=BLUE  | net=+4400 | PnL=+4550 | EV(G)~-3.10% EV(BLUE)~+4.20% | anti
...
```

### Speed & Backoff

- Normal pace: **~160–420 ms** per spin.  
- On **429/5xx** (rate-limit/server busy), the bot **backs off** briefly, then resumes.

---

## 5) How it works (short)

- **Real-time learning**
  - Two rolling windows: **short (W1)** and **medium (W2)** plus **EMA** for responsiveness and stability.
  - Estimates per-color probabilities → computes **EV = p × payout − 1**.

- **Smart decision making**
  - **Ensemble** of four “brains”:
    - **EV-mean**, **EV-upper** (Wilson CI), **Thompson Sampling**, **1st‑order Markov** (next given previous).
  - **Safety gate**: only leaves **GREEN** if **EV_lcb(color)** > **EV(GREEN)** + margin (prevents chasing RED/GOLD with thin data).
  - **Anti-green**: if EV(GREEN) stays negative for a while, favor **BLUE** when it shows an edge.

- **Risk management**
  - **Quarter‑Kelly** betting with capped size and **auto‑ramp** by EV.
  - **Volatility targeting** (downsize on high variance).
  - **Firewall** after loss streak; **tilt‑guard** for short‑term drawdown (cooldown + reduced bet).

> **Important**: With the official odds (RED 0.5%, GOLD 4%, BLUE 15%, GREEN 80.5% and payouts [150x, 20x, 5x, 1.15x]), **all choices are negative EV**; the least negative is **GREEN (~‑7.4%)**. The bot only **increases stake** when observed data shows a **statistically meaningful positive edge** (Wilson LCB exceeds the break‑even probability). Otherwise it reverts to **minbet** to lower expected loss.

---

## 6) Layout

```
Appleville-Bot/
├─ spin-pro.js        # main runner (ESM)
├─ data.txt           # cookies, one per account
├─ proxy.txt          # optional proxies
└─ README.md          # this file
```

---

## 7) FAQ

**Q1. Does the bot hack the system or RNG?**  
No. It only consumes valid API responses and makes decisions from observed outcomes.

**Q2. Why can it still lose?**  
Because the game is house‑edge negative by design. The bot reduces expected loss and enforces discipline; it cannot guarantee profit if the true odds match the official table.

**Q3. Can I run multiple accounts in parallel?**  
This script runs accounts sequentially from `data.txt`. You can start multiple OS processes/VMs with different proxies if you need true parallelism.
---
## Donate:
<!-- Code display (SVG) -->
<p align="center">
  <img src="https://raw.githubusercontent.com/nongdancryptos/nongdancryptos/refs/heads/main/QR-Code/readme.svg" alt="Donation Wallets (SVG code card)" />
</p>
---

## 8) License

For educational/testing purposes only. Use at your own risk. No liability for direct or indirect damages.

---

## 9) Feedback

Open an issue or PR on your GitHub repo: `nongdancryptos/Appleville-Bot`.
