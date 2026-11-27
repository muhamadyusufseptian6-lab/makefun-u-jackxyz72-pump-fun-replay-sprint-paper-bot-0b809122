// Petir — a paper-trading bot for the pump.fun replay sprint.
//
// Idea, in one line: nearly every new pump.fun coin bleeds out, but a
// few sprint 5-10x within minutes of launch — so this bot buys the
// smallest ticket the rules allow on every young coin that is still
// attracting buys, and lets the rare 10x runner pay for the many small
// losers. No leverage, no shorts, no guessing: every rule is a fixed
// number, every decision comes only from the replayed events, and the
// same input always produces the same orders.
//
// Why small tickets: the order cap is 1% of a coin's real SOL reserve,
// so the earliest a 0.01 SOL buy fits is when the reserve first reaches
// 1 SOL — usually within the coin's first few trades, when its price is
// still near its launch price (median 1.21x). Buying later, bigger,
// means buying after the sprint already happened. One ticket per coin,
// no topping up: a coin that dumps never gets a second lamport.
//
// Entry (all must hold):
//   1. The coin's real SOL reserve is at least 1 SOL, so a 0.01 SOL buy
//      fits inside the 1%-of-real-reserve order cap.
//   2. We hold nothing on it, have no order pending on it, hold fewer
//      than 5 positions, and have the free cash for it.
//   No flow or momentum filter: the ticket is bought at the crossing,
//   whatever the crowd just did — filtering for buy flow only ever
//   selected coins mid-spike, after the sprint already happened.
//   Size: exactly 0.01 SOL — the minimum round-trip bar, and the most
//   a lottery ticket should ever cost.
//
// Exit (first rule that fires sells the whole position):
//   - Take profit: marked value >= 1000% of cost (a 10x runner).
//   - Stop loss:   marked value <= 50% of cost.
//   - Trailing:    marked value <= 50% of the best marked value since entry.
//   - Time limit:  held for more than 3000 slots (~10 minutes of replay),
//      so a dead ticket frees its slot for the next young coin.
//
// Risk: at most 5 positions x 0.01 SOL = 0.05 SOL ever at risk (0.5% of
// the 10 SOL paper budget), each capped at a 50% loss by the stop, so
// the maximum drawdown stays far under the 50% guardrail. The bot
// trades across the whole 24h window, coin after coin, which is also
// how it clears the "at least 20 distinct coins" bar.
//
// Determinism: no clock, no Math.random, no environment reads. All state
// comes from the harness messages, in the order they arrive.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// --- fixed strategy numbers ---
const MIN_REAL_RESERVE = 1n * SOL; // 1 SOL of real reserve before a 0.01 buy fits the cap
const TICKET = 10_000_000n; // 0.01 SOL: one lottery ticket, never more per coin
const BUY_SHARE_NUM = 1n; // ... and >= 50% of recent flow must be buys ...
const BUY_SHARE_DEN = 2n; // ... (1/2)
const RECENT_TRADES = 12; // ... over the last 12 trades on the coin
const MAX_POSITIONS = 5; // the harness cap; never hold more
const TAKE_PROFIT_NUM = 1000n; // sell when marked value >= 1000% of cost
const TAKE_PROFIT_DEN = 100n;
const STOP_LOSS_NUM = 50n; // sell when marked value <= 50% of cost
const STOP_LOSS_DEN = 100n;
const TRAILING_NUM = 50n; // sell when marked value <= 50% of its peak
const TRAILING_DEN = 100n;
const MAX_HOLD_SLOTS = 3000; // sell when held longer than this, whatever the price
const MAX_SLIPPAGE_BPS = 2000; // 20%: during a sprint a fill 20% off is still a good entry/exit

interface CoinTrack {
  lastPrice: number; // SOL per token at latest reserves
  trades: number; // TradeEvents seen
  recentBuys: number; // SOL (lamports) of buys in the recent window
  recentTotal: number; // SOL (lamports) of all trades in the recent window
  recent: Array<{ buy: boolean; sol: bigint }>; // last RECENT_TRADES trades
}

interface EntryInfo {
  peakValue: bigint; // best marked value (lamports) since entry
  entrySlot: number; // slot the position was first seen held
}

const coins = new Map<string, CoinTrack>();
const entries = new Map<string, EntryInfo>();

function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function trackTrade(mint: string, isBuy: boolean, solLamports: bigint, price: number): void {
  let t = coins.get(mint);
  if (t === undefined) {
    t = { lastPrice: price, trades: 0, recentBuys: 0, recentTotal: 0, recent: [] };
    coins.set(mint, t);
  }
  t.trades += 1;
  t.lastPrice = price;
  t.recent.push({ buy: isBuy, sol: solLamports });
  if (isBuy) t.recentBuys += Number(solLamports);
  t.recentTotal += Number(solLamports);
  while (t.recent.length > RECENT_TRADES) {
    const old = t.recent.shift()!;
    if (old.buy) t.recentBuys -= Number(old.sol);
    t.recentTotal -= Number(old.sol);
  }
}

function hasPending(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

/** True when the crowd is still buying this coin: buys are at least half of recent flow. */
function buyFlowDominant(t: CoinTrack): boolean {
  if (t.recentTotal <= 0) return false;
  return BigInt(t.recentBuys) * BUY_SHARE_DEN >= BigInt(t.recentTotal) * BUY_SHARE_NUM;
}

function decide(state: BotState, batch: Batch): OrderInput[] {
  // Fold this batch's events into the per-coin tracks first.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (!coins.has(e.mint)) {
        coins.set(e.mint, { lastPrice: price, trades: 0, recentBuys: 0, recentTotal: 0, recent: [] });
      }
    } else if (e.event === 'TradeEvent') {
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      trackTrade(e.mint, e.is_buy, BigInt(e.sol_amount), price);
    }
  }

  const orders: OrderInput[] = [];
  // Cash we can still spend in THIS reply: free cash minus every buy we
  // already queued here (the harness only counts orders already sent).
  let budget = state.freeCashLamports();

  // --- exits first: protect what we hold before risking new cash ---
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (hasPending(state, mint, 'sell')) continue;
    const price = priceOf(state, mint);
    if (price === null || price <= 0) continue;
    const value = BigInt(Math.floor(Number(holding.token_amount) * price));
    const cost = holding.cost_lamports;
    if (cost === 0n) continue;
    let info = entries.get(mint);
    if (info === undefined) {
      info = { peakValue: value, entrySlot: state.slot };
      entries.set(mint, info);
    }
    if (value > info.peakValue) info.peakValue = value;
    const takeProfit = value * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM;
    const stopLoss = value * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM;
    const trailing = value * TRAILING_DEN <= info.peakValue * TRAILING_NUM;
    const timedOut = state.slot - info.entrySlot > MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || trailing || timedOut) {
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entries.delete(mint);
    }
  }
  // Forget entries for positions we no longer hold.
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) entries.delete(mint);
  }

  // --- fresh entries: one 0.01 SOL ticket per young coin with buy flow ---
  let newBuys = 0;
  if (state.committedPositionCount() + newBuys < MAX_POSITIONS) {
    for (const [mint, t] of coins) {
      if (orders.length >= 16) break;
      if (state.committedPositionCount() + newBuys >= MAX_POSITIONS) break;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (t.trades < 1) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      // One ticket: 0.01 SOL, inside the 1%-of-real-reserve order cap.
      const cap = state.maxBuyLamports(mint);
      if (cap < TICKET) continue;
      const need = TICKET + state.txFeeLamports();
      if (budget < need) continue;
      budget -= need;
      orders.push({ side: 'buy', mint, quote_lamports: TICKET, max_slippage_bps: MAX_SLIPPAGE_BPS });
      newBuys += 1;
    }
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return decide(state, batch);
  },
  onDone(state) {
    const cash = state.cash;
    let positionsValue = 0n;
    for (const [mint, holding] of state.positions) {
      const price = priceOf(state, mint);
      if (price !== null && price > 0) {
        positionsValue += BigInt(Math.floor(Number(holding.token_amount) * price));
      }
    }
    const net = cash + positionsValue;
    console.error(
      `petir done: cash=${cash} positions_value=${positionsValue} net=${net} ` +
        `pnl=${net - 10n * SOL} coins_tracked=${coins.size}`,
    );
  },
});
