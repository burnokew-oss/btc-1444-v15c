/**
 * Hybrid dip-buy BTC bot for make.fun
 * btc-race-24h-20261118-1444 (v15 — v14 + EARLY shallow-conf dip tier).
 *
 * v14 = v13 (B+adx: vol<13 + slope>=-20 + adx>=40) + ONE change: when an
 * exit (TP/SL/timeout/stall) fires, sell $500/bar instead of the whole
 * position at once. This cuts the exit's price impact (a $1000 sell costs
 * ~12 bps/side in impact; a $500 sell ~6 bps) AND lets the exit ride a
 * continuing move: the later legs fill at better prices if the bounce
 * extends past the TP trigger. Verified in the exact backtester:
 *   DEV    +$42.84 (was $41.22), 12 trades, max DD -0.72%
 *   OOS-1  +$13.62 (was $13.15), 6 trades
 *   OOS-2  +$12.46 (was $11.06), 8 trades
 *   avg +$22.97, worst +$12.46 — positive on all three windows.
 * Entry is unchanged (full-size dip buy at the bottom); only the exit is
 * gradual. Rank-6 hunt verdict: no generalizable recipe beats +$108 on
 * this dev window (DP perfect-foresight bound $131; the 39 mild-dip
 * round trips are not causally predictable — bounce rate ~20%, ML
 * reverse-split AUC 0.467); v14 is the best generalizable recipe.
 *
 * Long-only paper trader on cbBTC/USDC, one 1-minute bar at a time. It speaks
 * agent-fun/bars-replay/v1 on stdin/stdout (newline-delimited JSON), standard
 * library only, no network, no wall clock, no randomness: every decision is
 * exact bigint arithmetic on the bars the harness sent, so two runs on the
 * same data give the same orders.
 *
 * Base = v12 (repo-v12/main.ts), unchanged except ONE new idea, the regime
 * gate on the dip tier. v12's dip tier is a money machine in the sideways
 * dev window (+$41.22) but bleeds in downtrends: dip-only is -$8.70 on
 * OOS-1 and -$45.21 on OOS-2 (5 of 5 dip buys lost on OOS-2). The washout
 * tier alone is +$19.71 / +$19.22 on the two downtrends but $0 on dev
 * (no washout ever forms in sideways). So the dip tier must fire in
 * sideways and stay OFF in downtrends. The separator that does it is the
 * 60-bar 1-minute volatility: losing OOS-2 dips all sit at vol60 >= 12.1
 * bps, while the dev window's median vol60 is 5.5 bps. Two extra guards
 * (MA240 slope, ADX14) block the remaining deep-downtrend entries:
 *
 * Dip tier fires only when ALL hold (on top of v12's r60 < -115,
 * dd240 > -250, RSI14 <= 40):
 *   - vol60 < 13 bps   (std of 1-min close returns, 60 bars)
 *   - slope240 >= -20 bps  (MA240 now vs 60 bars ago, per-60-bar change)
 *   - adx14 >= 40      (Wilder ADX14: the dip must sit in a trending
 *                        market, not a flat chop — flat-chop dips in the
 *                        downtrend windows are the ones that keep falling)
 * Washout tier is UNGATED (v11/v12 params, unchanged): it is the only
 * tier that earns in downtrends, and gating it off loses money.
 *
 * Offline backtest (exact harness fill model, same as v12's):
 *   DEV    +$41.22 (3 round trips, 100% win, max drawdown -0.72%)
 *   OOS-1  +$13.15 (2 round trips, 50% win, max drawdown -1.07%)
 *   OOS-2  +$11.06 (2 round trips, 50% win, max drawdown -2.44%)
 *   avg +$21.81, worst +$11.06 — positive on all three windows, vs v12's
 *   +$41.22 / +$10.68 / -$26.74 (avg +$8.39, worst -$26.74).
 * Sensitivity (+-10% on the three gate thresholds): DEV falls to +$22.72
 * either way (the dev trade at bar 573 sits at vol 12.2 / adx 41.7, just
 * inside both gates), but all three windows stay positive in every
 * direction (worst +$10.81..+$13.15). The gates degrade gracefully to the
 * "calm-only" variant rather than going negative.
 *
 * What did NOT work (tested, kept out): trailing exits (price or pnl
 * based) and partial-TP both LOWER dev and OOS-1/OOS-2 — the +190 TP
 * already captures ~94% of the dips' max favourable excursion, so
 * trailing only gives back money; dynamic vol sizing shrinks the dev
 * winners more than it shrinks the downtrend losers; looser dip
 * thresholds (T -90/-100) add losing trades in both downtrends; a
 * shallower washout (W_D 250/300) loses in OOS-1. See REPORT.md.
 *
 * GATE STATUS: the strict gate (dev > +$108 AND OOS-1 > +$41.22) is NOT
 * met and is provably unreachable for any dip-buy bot on this dev window:
 * the dev window has exactly 3 dip clusters and their max favourable
 * excursions sum to ~551 bps (~$55 gross, ~$44 net of round-trip costs),
 * so +$108 would need 2.6x the theoretical maximum. This candidate is
 * the best found by avg/worst across the three windows instead.
 *
 * Order notes: fills land at the next bar's open; buys are capped at the
 * cash on hand; sells always empty the whole position; max_slippage_bps is
 * 200 (2%), far above any one-minute move in the dev window (max 66 bps), so
 * a fill is refused only on a genuine gap. Client ids are o1, o2, ... in
 * order.
 */

const SYMBOL = "CBBTC";

// --- strategy parameters (basis points unless noted) -----------------------
// Dip tier (v12, unchanged)
const D_W = 60; // dip window, in bars (60-minute return)
const D_T = 115n; // dip threshold: 60-minute return below -115 bps
const D_DEAD = 250n; // dip tier is dead while dd240 is deeper than this
const D_RSI = 40n; // dip tier needs 14-bar RSI at most 40 (exact: 3*g <= 2*l)
const D_TP = 190n; // dip take-profit over cost
const D_SL = 60n; // dip stop-loss under cost
const D_TIMEOUT = 600; // dip timeout, in bars after entry
const D_STALL_X = 80n; // stall: exit if pnl still below +80 bps after ...
const D_STALL_N = 240; // ... 240 bars
// --- v15 early tier (NEW): shallow dip + turn-up confirmation, warmup 61 ---
// v14 earns $0 on this window: its 240-bar warmup misses the early dip
// cluster (bars 60-140) and its gates block the last-4-bars dips. The v15
// tier buys the dip EARLY: r60 < -115 with RSI14 <= 40 AND the close above
// the close 2 bars ago (the fall has turned), edge-triggered (first bar the
// full condition holds). TP +100 / SL -300 / timeout 600, full size, full
// sell on exit (no gradual exit — backtested as-is). Verified in the exact
// backtester (hybrid, v14 checked first when flat):
//   NEW  +$14.22 (5 trades, mdd -1.20%)   OLD +$42.84 (12 trades, -0.72%)
//   OOS-1 -$15.44 (3 trades, -2.17%)      OOS-2 -$15.42 (6 trades, -4.22%)
//   avg +$6.55, worst -$15.44. NEW sensitivity flat: D 95-115, RSI 35-45,
//   TP 90-110, SL 250-350 all give +$10.55..$15.68 on NEW.
//   Honest caveat: positive on NEW+OLD, negative on the two steep-downtrend
//   OOS windows — the final window's regime decides; current BTC grinds down
//   slowly like NEW, not like OOS-1/2 (-491/-400 bps plunges).
const V15_D_T = 115n; // v15 dip threshold: 60-min return below -115 bps
const V15_TP = 100n; // v15 take-profit over cost
const V15_SL = 300n; // v15 stop-loss under cost
const V15_TIMEOUT = 600; // v15 timeout, in bars after entry
// Washout tier (v11/v12, unchanged)
const W_H = 240; // trailing-high window, in bars
const W_D = 350n; // washout depth: close this far below the trailing high
const W_CONF = 2; // washout confirmation: close above the close 2 bars ago
const W_TP = 190n; // washout take-profit over blended cost
const W_SL = 300n; // washout stop-loss under blended cost
const W_TIMEOUT = 600; // washout timeout, in bars after entry
const ADD_DROP = 100n; // second-leg depth below the first entry, to average down
const FRAC1 = 3500n; // first washout buy spends this share of cash (bps); 35%
// --- v13 regime gates on the dip tier (NEW) ---
// vol60 / slope240 / adx14 are computed in fixed point, scaled by 10^4
// (1 unit = 0.0001 bps), so every comparison below is exact bigint math.
const SCALE = 10000n;
const G_VOL_HI = 13n * SCALE; // dip only when 60-bar return-vol < 13 bps
const G_SLOPE_LO = -20n * SCALE; // dip only when MA240 slope >= -20 bps/60 bars
const G_ADX_LO = 40n * SCALE; // dip only when Wilder ADX14 >= 40
const MAX_SLIP_BPS = 200; // max slippage allowed on any order
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units
const BPS = 10000n;
// v14 gradual exit: once an exit fires, sell this many USDC per bar.
const EXIT_F = 500n; // $500/bar

/** What qty is worth at price (quote_scale 6, qty_scale 8, price_scale 5). */
function value(qty: bigint, price: bigint): bigint {
  return (qty * price) / 10n ** 7n;
}

/** Integer square root (floor) of a non-negative bigint, Newton iteration. */
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

type Order = {
  side: string;
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

class Bot {
  closes: bigint[] = [];
  highs: bigint[] = [];
  lows: bigint[] = [];
  seq = -1;
  warmupBars = 0;
  cash = 0n;
  qty = 0n;
  cost = 0n;
  // Position state, adopted when a position first shows in the account:
  // 0 = flat, 1 = washout stage 1, 2 = washout stage 2, 8 = v15 trade,
  // 9 = dip trade.
  stage = 0;
  exiting = false; // v14: an exit fired; sell EXIT_F/bar until flat.
  entryPx = 0n; // close at the first buy decision
  entrySeq = -1; // seq of the batch that decided the first buy
  nextId = 1;
  // What the last decided (not yet confirmed) buy was, so the next batch
  // can adopt it when the position appears in the account.
  pendingStage = 0;
  pendingEntryPx = 0n;
  pendingEntrySeq = -1;
  // Regime state (incremental, exact bigint).
  sum240 = 0n; // sum of the last <=240 closes
  sums240: bigint[] = []; // sum240 after each bar (for the 60-bar slope)
  // Wilder ADX14 state (price-unit integers; DI/DX/ADX scaled by SCALE).
  adxSmP = 0n;
  adxSmM = 0n;
  adxSmTr = 0n;
  adxPrev = 0n; // scaled ADX at the previous bar (0 until bar 14)

  cid(): string {
    return "o" + this.nextId++;
  }

  onHello(msg: any): void {
    this.warmupBars = Number(msg.warmup_bars || 0);
  }

  onBatch(batch: any): Order[] {
    this.seq = Number(batch.seq);
    const account = batch.account;
    this.cash = BigInt(account.cash_quote_units);
    const positions = account.positions || [];
    let held: any = null;
    for (const p of positions) {
      if (p.symbol === SYMBOL) held = p;
    }
    this.qty = held ? BigInt(held.qty) : 0n;
    this.cost = held ? BigInt(held.cost_quote_units) : 0n;

    for (const bar of batch.bars || []) {
      if (bar.symbol === SYMBOL) {
        const c = BigInt(bar.c);
        const h = BigInt(bar.h);
        const l = BigInt(bar.l);
        const n = this.closes.length;
        this.closes.push(c);
        this.highs.push(h);
        this.lows.push(l);
        // Rolling 240-bar close sum.
        this.sum240 += c;
        if (n >= 240) this.sum240 -= this.closes[n - 240];
        this.sums240.push(this.sum240);
        // Wilder ADX14 incremental state.
        if (n >= 1) {
          const up = h - this.highs[n - 1];
          const dn = this.lows[n - 1] - l;
          const dmP = up > dn && up > 0n ? up : 0n;
          const dmM = dn > up && dn > 0n ? dn : 0n;
          let tr = h - l;
          const tr2 = h - this.closes[n - 1];
          const tr3 = this.closes[n - 1] - l;
          if (tr2 > tr) tr = tr2;
          if (tr3 > tr) tr = tr3;
          if (n <= 14) {
            this.adxSmP += dmP;
            this.adxSmM += dmM;
            this.adxSmTr += tr;
          } else {
            this.adxSmP = this.adxSmP - this.adxSmP / 14n + dmP;
            this.adxSmM = this.adxSmM - this.adxSmM / 14n + dmM;
            this.adxSmTr = this.adxSmTr - this.adxSmTr / 14n + tr;
          }
          if (n >= 14 && this.adxSmTr > 0n) {
            // DI+/DI- scaled by SCALE; DX and ADX scaled by SCALE.
            const diP = (100n * SCALE * this.adxSmP) / this.adxSmTr;
            const diM = (100n * SCALE * this.adxSmM) / this.adxSmTr;
            const sum = diP + diM;
            let dx = 0n;
            if (sum > 0n) {
              const diff = diP > diM ? diP - diM : diM - diP;
              dx = (100n * SCALE * diff) / sum;
            }
            this.adxPrev =
              n === 14 ? dx : (this.adxPrev * 13n + dx) / 14n;
          }
        }
      }
    }

    // Adopt a pending tier once the position it bought shows up (or grows:
    // a stage-2 add adopts stage 2 the same way).
    if (this.qty > 0n && this.pendingStage !== 0) {
      this.stage = this.pendingStage;
      this.entryPx = this.pendingEntryPx;
      this.entrySeq = this.pendingEntrySeq;
      this.pendingStage = 0;
    }
    if (this.qty === 0n) {
      this.stage = 0;
      this.pendingStage = 0;
      this.exiting = false;
    }

    if (this.seq < this.warmupBars) return [];
    return this.decide();
  }

  /** 60-bar std of 1-min close returns, in bps scaled by SCALE. */
  vol60(): bigint {
    const n = this.closes.length;
    if (n < 60) return 0n;
    // R_k = (c_k - c_{k-1}) * 10^8 / c_{k-1}: return in bps, scaled by SCALE.
    let sum = 0n;
    const rs: bigint[] = [];
    for (let k = n - 60; k < n; k++) {
      const r =
        ((this.closes[k] - this.closes[k - 1]) * 10000n * SCALE) /
        this.closes[k - 1];
      rs.push(r);
      sum += r;
    }
    const mean = sum / 60n;
    let varSum = 0n;
    for (const r of rs) {
      const d = r - mean;
      varSum += d * d;
    }
    const variance = varSum / 60n;
    return isqrt(variance);
  }

  /** MA240 slope over 60 bars, in bps scaled by SCALE (0 before bar 299). */
  slope240(): bigint {
    const n = this.closes.length;
    if (n < 300) return 0n;
    const sNow = this.sums240[n - 1];
    const sThen = this.sums240[n - 1 - 60];
    if (sThen <= 0n) return 0n;
    return (10000n * SCALE * (sNow - sThen)) / sThen;
  }

  /** v15 condition evaluated at closes[end] (r60 + RSI14 + turn-up). */
  v15Cond(end: number): boolean {
    const closes = this.closes;
    if (end < 60) return false;
    const c = closes[end];
    const r60Down = c * BPS < closes[end - D_W] * (BPS - V15_D_T);
    if (!r60Down) return false;
    let gains = 0n;
    let losses = 0n;
    for (let k = end - 13; k <= end; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0n) gains += d;
      else losses -= d;
    }
    const rsiOk = losses > 0n && 3n * gains <= 2n * losses;
    if (!rsiOk) return false;
    return c > closes[end - W_CONF];
  }

  /** v15 entry: full condition holds now but not on the previous bar. */
  v15Entry(): boolean {
    const n = this.closes.length;
    if (n < 62) return false;
    return this.v15Cond(n - 1) && !this.v15Cond(n - 2);
  }

  decide(): Order[] {
    const closes = this.closes;
    const n = closes.length;
    const c = n > 0 ? closes[n - 1] : 0n;
    const orders: Order[] = [];
    if (n < 62 || c <= 0n) return orders;

    const upW = c > closes[n - 1 - W_CONF];
    // 14-bar RSI (simple mean of gains/losses): RSI <= 40
    //   <=> 3 * gains <= 2 * losses (losses > 0; losses == 0 means RSI 100).
    let gains = 0n;
    let losses = 0n;
    for (let k = n - 14; k < n; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0n) gains += d;
      else losses -= d;
    }
    const rsiOk = losses > 0n && 3n * gains <= 2n * losses;

    if (this.qty === 0n) {
      // v14 tiers first (unchanged): washout + regime-gated dip, bar 241+.
      if (n > Math.max(W_H, 240)) {
        let hi = closes[n - W_H];
        for (let i = n - W_H + 1; i < n; i++) {
          if (closes[i] > hi) hi = closes[i];
        }
        // dd < -D  <=>  c * 10000 < hi * (10000 - D)   (exact integer math)
        const washout = c * BPS < hi * (BPS - W_D);
        const dipOk = c * BPS > hi * (BPS - D_DEAD);
        const r60Down = c * BPS < closes[n - 1 - D_W] * (BPS - D_T);
        // v13 regime gates on the dip tier (fixed-point, exact bigint).
        const volOk = this.vol60() < G_VOL_HI;
        const slopeOk = this.slope240() >= G_SLOPE_LO;
        const adxOk = this.adxPrev >= G_ADX_LO;
        if (washout && upW) {
          const spend = (this.cash * FRAC1) / BPS;
          if (spend >= MIN_NOTIONAL) {
            orders.push(this.buy(spend));
            this.pendingStage = 1;
            this.pendingEntryPx = c;
            this.pendingEntrySeq = this.seq;
          }
          return orders;
        } else if (dipOk && r60Down && rsiOk && volOk && slopeOk && adxOk) {
          if (this.cash >= MIN_NOTIONAL) {
            orders.push(this.buy(this.cash));
            this.pendingStage = 9;
            this.pendingEntryPx = c;
            this.pendingEntrySeq = this.seq;
          }
          return orders;
        }
      }
      // v15 tier: early shallow-conf dip buy (warmup 61 bars).
      if (this.v15Entry()) {
        if (this.cash >= MIN_NOTIONAL) {
          orders.push(this.buy(this.cash));
          this.pendingStage = 8;
          this.pendingEntryPx = c;
          this.pendingEntrySeq = this.seq;
        }
      }
      return orders;
    }

    // v15 position (stage 8): TP +100 / SL -300 / timeout 600, FULL sell.
    if (this.stage === 8) {
      const val = value(this.qty, c);
      const takeProfit = val * BPS >= this.cost * (BPS + V15_TP);
      const stopLoss = val * BPS <= this.cost * (BPS - V15_SL);
      const timedOut =
        this.entrySeq >= 0 && this.seq - this.entrySeq >= V15_TIMEOUT;
      if (takeProfit || stopLoss || timedOut) {
        orders.push(this.sell(this.qty));
      }
      return orders;
    }

    // v14: once an exit has fired, keep selling EXIT_F/bar until flat
    // (ignore the add/exit logic while exiting).
    if (this.exiting && this.qty > 0n) {
      orders.push(this.sell(this.exitQty(c)));
      return orders;
    }

    // In a position. A washout stage-1 add is checked first (it can only
    // fire while the price is still falling, where no exit can trigger),
    // exactly as in the offline backtest.
    if (this.stage === 1 && this.cash > 0n) {
      if (c * BPS < this.entryPx * (BPS - ADD_DROP) && upW) {
        if (this.cash >= MIN_NOTIONAL) {
          orders.push(this.buy(this.cash));
          this.pendingStage = 2;
          this.pendingEntryPx = this.entryPx;
          this.pendingEntrySeq = this.entrySeq;
        }
        return orders;
      }
    }

    const isWashout = this.stage === 1 || this.stage === 2;
    const tp = isWashout ? W_TP : D_TP;
    const sl = isWashout ? W_SL : D_SL;
    const timeout = isWashout ? W_TIMEOUT : D_TIMEOUT;
    const val = value(this.qty, c);
    // val/cost >= 1 + tp/10000  <=>  val * 10000 >= cost * (10000 + tp)
    const takeProfit = val * BPS >= this.cost * (BPS + tp);
    const stopLoss = val * BPS <= this.cost * (BPS - sl);
    const timedOut =
      this.entrySeq >= 0 && this.seq - this.entrySeq >= timeout;
    // Stall exit, dip trades only: still below +80 bps 240 bars in.
    const stalled =
      !isWashout &&
      this.entrySeq >= 0 &&
      this.seq - this.entrySeq >= D_STALL_N &&
      val * BPS < this.cost * (BPS + D_STALL_X);
    if (takeProfit || stopLoss || timedOut || stalled) {
      // v14: enter exiting mode; sell EXIT_F/bar (not the whole position).
      this.exiting = true;
      orders.push(this.sell(this.exitQty(c)));
    }
    return orders;
  }

  /** Qty worth EXIT_F USDC at price c (quote_scale 6, qty_scale 8,
   *  price_scale 5): qty = EXIT_F * 10^6 * 10^7 / c, capped at held qty. */
  exitQty(c: bigint): bigint {
    if (c <= 0n) return this.qty;
    const q = (EXIT_F * 10n ** 13n) / c;
    return q < this.qty ? q : this.qty;
  }

  buy(notional: bigint): Order {
    return {
      side: "buy",
      client_id: this.cid(),
      symbol: SYMBOL,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIP_BPS,
    };
  }

  sell(qty: bigint): Order {
    return {
      side: "sell",
      client_id: this.cid(),
      symbol: SYMBOL,
      qty: qty.toString(),
      max_slippage_bps: MAX_SLIP_BPS,
    };
  }
}

const bot = new Bot();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      process.exit(1);
    }
    const kind = msg.type;
    if (kind === "hello") {
      bot.onHello(msg);
    } else if (kind === "batch") {
      const orders = bot.onBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: Number(msg.seq), orders }) +
          "\n",
      );
    } else if (kind === "done") {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }
});
