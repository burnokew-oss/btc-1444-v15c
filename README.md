# v15 — Hybrid Dip-Buy BTC Bot

Entry for the Make Fun bounty `btc-race-24h-20261118-1444` (account @burnok).

## Idea

v15 keeps the whole v14 strategy untouched and adds one new, early
dip-buying tier on top of it. v14 only starts trading after 240 bars of
warmup and its regime gates block the last few bars of a dip, so it earns
nothing on this race window: it misses the early dip cluster (bars 60–140)
entirely. The new tier buys the dip early instead.

The early tier fires when the 60-minute return is below −115 bps, the
14-bar RSI is at most 40, and the close has turned up above the close two
bars ago — edge-triggered, so it only buys on the first bar the full
condition holds. It buys full size and exits in full on take-profit
+100 bps, stop-loss −300 bps, or a 600-bar timeout. The v14 tiers
(regime-gated dip buys plus the ungated washout tier, with the gradual
$500-per-bar exit) are still checked first whenever the bot is flat.

## Backtest (exact harness fill model)

- NEW window (this race): +$14.22, 5 trades, max drawdown −1.20%
- OLD window (v14's dev): +$42.84, 12 trades, max drawdown −0.72%
- OOS-1: −$15.44 (3 trades); OOS-2: −$15.42 (6 trades)

Honest caveat: the new tier is positive on the NEW and OLD windows but
negative on the two steep-downtrend out-of-sample windows, so the final
window's regime decides the outcome. The current BTC market grinds down
slowly, like the NEW window, rather than plunging like OOS-1/OOS-2
(−491/−400 bps). Sensitivity on the new tier is flat: varying the dip
threshold, RSI, TP, and SL by ±10% keeps NEW between +$10.55 and +$15.68.

## Implementation

`main.ts` — long-only paper trader on cbBTC/USDC, one 1-minute bar at a
time, speaking `agent-fun/bars-replay/v1` over stdin/stdout
(newline-delimited JSON). Standard library only, no network, no wall
clock, no randomness; every decision is exact bigint arithmetic on the
bars the harness sent, so two runs on the same data give the same orders.

## License

MIT

## Verified grade-local

`grade-local` (dev window, process driver, commit b125213): net PnL
+$14.22 (14,224,840 quote units), 5 trades, win rate 66.7%, max drawdown
1.20%, compliant.

Repo: https://github.com/burnokew-oss/btc-1444-v15c
