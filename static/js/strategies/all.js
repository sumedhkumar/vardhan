/* Six predefined long-only strategies.
 *
 * Every strategy registers into ``window.StrategyRegistry`` with:
 *   {
 *     id, name,
 *     defaults:  { ...params },
 *     paramSpec: [{ key, type, default, min?, max? }],
 *     signals(bars, params) -> [{time, side: "long" | "exit"}]
 *   }
 *
 * The backtest engine consumes ``signals`` to walk the equity curve. We only
 * emit "long" (open long) and "exit" (close any open position) — short
 * selling is intentionally omitted in v1.
 */
(function () {
  "use strict";

  const M = window.IndicatorMath;
  const REG = window.StrategyRegistry = window.StrategyRegistry || {};

  // Helper: detect a "cross above" between two same-length arrays at index i.
  function crossesAbove(a, b, i) {
    if (i < 1) return false;
    return Number.isFinite(a[i]) && Number.isFinite(b[i]) &&
           Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1]) &&
           a[i - 1] <= b[i - 1] && a[i] > b[i];
  }
  function crossesBelow(a, b, i) {
    if (i < 1) return false;
    return Number.isFinite(a[i]) && Number.isFinite(b[i]) &&
           Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1]) &&
           a[i - 1] >= b[i - 1] && a[i] < b[i];
  }

  // ----------------------------------------------------------- EMA Crossover

  REG.ema_cross = {
    id: "ema_cross", name: "EMA Crossover",
    defaults:  { fast: 9, slow: 21 },
    paramSpec: [
      { key: "fast", type: "int", default: 9,  min: 2, max: 200 },
      { key: "slow", type: "int", default: 21, min: 2, max: 400 },
    ],
    signals(bars, p) {
      const closes = M.pluck(bars, "close");
      const fast = M.ema(closes, p.fast);
      const slow = M.ema(closes, p.slow);
      const out = [];
      for (let i = 1; i < bars.length; i++) {
        if (crossesAbove(fast, slow, i)) out.push({ time: bars[i].time, side: "long" });
        else if (crossesBelow(fast, slow, i)) out.push({ time: bars[i].time, side: "exit" });
      }
      return out;
    },
  };

  // ------------------------------------------------------ RSI Mean Reversion

  REG.rsi_mr = {
    id: "rsi_mr", name: "RSI Mean Reversion",
    defaults:  { length: 14, oversold: 30, exitLevel: 50 },
    paramSpec: [
      { key: "length",    type: "int", default: 14, min: 2, max: 200 },
      { key: "oversold",  type: "int", default: 30, min: 5, max: 50 },
      { key: "exitLevel", type: "int", default: 50, min: 30, max: 90 },
    ],
    signals(bars, p) {
      const rsi = window.IndicatorRegistry.rsi.compute(bars, { length: p.length }).line;
      const out = [];
      let inPos = false;
      for (let i = 1; i < bars.length; i++) {
        const r = rsi[i], pr = rsi[i - 1];
        if (!Number.isFinite(r) || !Number.isFinite(pr)) continue;
        if (!inPos && pr <= p.oversold && r > p.oversold) {
          out.push({ time: bars[i].time, side: "long" }); inPos = true;
        } else if (inPos && r >= p.exitLevel) {
          out.push({ time: bars[i].time, side: "exit" }); inPos = false;
        }
      }
      return out;
    },
  };

  // ------------------------------------------------------------ MACD Cross

  REG.macd_cross = {
    id: "macd_cross", name: "MACD Cross",
    defaults:  { fast: 12, slow: 26, signal: 9 },
    paramSpec: [
      { key: "fast",   type: "int", default: 12, min: 2, max: 200 },
      { key: "slow",   type: "int", default: 26, min: 2, max: 400 },
      { key: "signal", type: "int", default: 9,  min: 2, max: 200 },
    ],
    signals(bars, p) {
      const c = window.IndicatorRegistry.macd.compute(bars, p);
      const out = [];
      for (let i = 1; i < bars.length; i++) {
        if (crossesAbove(c.macd, c.signal, i)) out.push({ time: bars[i].time, side: "long" });
        else if (crossesBelow(c.macd, c.signal, i)) out.push({ time: bars[i].time, side: "exit" });
      }
      return out;
    },
  };

  // ----------------------------------------------------- Bollinger Breakout

  REG.bb_breakout = {
    id: "bb_breakout", name: "Bollinger Breakout",
    defaults:  { length: 20, mult: 2 },
    paramSpec: [
      { key: "length", type: "int",   default: 20, min: 2, max: 500 },
      { key: "mult",   type: "float", default: 2,  min: 0.1, max: 10 },
    ],
    signals(bars, p) {
      const c = window.IndicatorRegistry.bb.compute(bars, p);
      const out = [];
      let inPos = false;
      for (let i = 0; i < bars.length; i++) {
        if (!Number.isFinite(c.upper[i])) continue;
        if (!inPos && bars[i].close > c.upper[i]) {
          out.push({ time: bars[i].time, side: "long" }); inPos = true;
        } else if (inPos && bars[i].close < c.basis[i]) {
          out.push({ time: bars[i].time, side: "exit" }); inPos = false;
        }
      }
      return out;
    },
  };

  // -------------------------------------------------------- Supertrend Flip

  REG.supertrend_flip = {
    id: "supertrend_flip", name: "Supertrend Flip",
    defaults:  { length: 10, mult: 3 },
    paramSpec: [
      { key: "length", type: "int",   default: 10, min: 2, max: 200 },
      { key: "mult",   type: "float", default: 3,  min: 0.1, max: 20 },
    ],
    signals(bars, p) {
      const c = window.IndicatorRegistry.supertrend.compute(bars, p);
      const out = [];
      for (let i = 1; i < bars.length; i++) {
        if (c.dir[i - 1] === -1 && c.dir[i] === 1) out.push({ time: bars[i].time, side: "long" });
        else if (c.dir[i - 1] === 1 && c.dir[i] === -1) out.push({ time: bars[i].time, side: "exit" });
      }
      return out;
    },
  };

  // ------------------------------------------------------- Donchian Breakout

  REG.donchian_break = {
    id: "donchian_break", name: "Donchian Breakout",
    defaults:  { entryLen: 20, exitLen: 10 },
    paramSpec: [
      { key: "entryLen", type: "int", default: 20, min: 2, max: 500 },
      { key: "exitLen",  type: "int", default: 10, min: 2, max: 500 },
    ],
    signals(bars, p) {
      const highs = M.pluck(bars, "high");
      const lows  = M.pluck(bars, "low");
      // Use the *previous* bar's window so we don't include today in the
      // breakout reference (classic turtle-style rule).
      const hi = M.highest(highs, p.entryLen);
      const lo = M.lowest(lows,   p.exitLen);
      const out = [];
      let inPos = false;
      for (let i = 1; i < bars.length; i++) {
        const refHi = hi[i - 1], refLo = lo[i - 1];
        if (!Number.isFinite(refHi) || !Number.isFinite(refLo)) continue;
        if (!inPos && bars[i].close > refHi) {
          out.push({ time: bars[i].time, side: "long" }); inPos = true;
        } else if (inPos && bars[i].close < refLo) {
          out.push({ time: bars[i].time, side: "exit" }); inPos = false;
        }
      }
      return out;
    },
  };

  // ------------------------------------------------------------------ index

  const ORDER = ["ema_cross", "rsi_mr", "macd_cross", "bb_breakout", "supertrend_flip", "donchian_break"];
  window.Strategies = {
    list() { return ORDER.map(id => REG[id]).filter(Boolean); },
    get(id) { return REG[id] || null; },
  };
})();
