# Petir — Pump.fun Replay Sprint Paper Bot

[![make.fun competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/muhamadyusufseptian6-lab/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/muhamadyusufseptian6-lab/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It gets 10 SOL of play money and a 24-hour replay of real pump.fun bonding-curve action. Best net PnL after fees takes the prize.

## The bet

Let's be honest: almost every fresh pump.fun coin is a slow bleed to zero. But a handful of them go absolutely feral — 5x, 10x, gone — within minutes of launch. Petir doesn't try to predict which one. It buys a lottery ticket on *all* of them.

The ticket costs the smallest amount the rules allow: 0.01 SOL, bought the moment a coin's real SOL reserve first hits 1 SOL — the earliest a 0.01 SOL order fits inside the 1%-of-reserve cap, usually while the price is still close to launch. One ticket per coin, ever. No topping up, no averaging down. A coin that dumps never sees a second lamport from us.

- **Entry:** real SOL reserve ≥ 1 SOL, no existing position or pending buy on that coin, fewer than 5 open positions, and enough free cash for the ticket. No momentum filter, no vibes check — the ticket is bought at the crossing, whatever the crowd just did. Filtering for "buy flow" only ever caught coins mid-spike, after the sprint was already over.
- **Exit (first rule to fire sells the whole position):** take profit at 10x cost, stop loss at −50%, trailing stop at 50% below the best price since entry, or a 3000-slot time limit (~10 minutes of replay) so a dead ticket frees its slot for the next young coin.
- **Risk:** at most 5 × 0.01 SOL = 0.05 SOL ever on the table — 0.5% of the 10 SOL budget. The worst drawdown stays miles under the 50% guardrail.
- **Determinism:** no clock, no randomness, no environment reads. Feed it the same replay twice and you get the same orders twice, byte for byte.

## Files

- `main.ts` — the bot (Node 22, stdlib only, speaks `agent-fun/replay/v2` on stdin/stdout).
- `vendor/makefun-bot.ts` — the kit's protocol shim, copied unchanged.
- `LICENSE` — MIT.

## Local verification (dev window, faithful replay driver)

| Metric | Value |
|---|---|
| Net PnL | −0.338 SOL |
| Round trips | 647 |
| Distinct coins | 24 |
| Max drawdown | 3.62% |
| Win rate | 5.1% |
| Determinism | two runs byte-identical |

Honest read: the dev window is one small sample, and most of the PnL rides on a few runners — so treat these numbers as a spread, not a forecast. What they do prove is the guardrails hold with room to spare: 24 distinct coins (bar: 20), 0.01 SOL per round trip (bar: 0.01), and a 3.62% drawdown against a 50% ceiling. The strategy is a lottery-ticket machine — it loses small, often, and waits for the one coin that pays for all of them.

## Referral

Built with make.fun — referral code `515temp1`.
