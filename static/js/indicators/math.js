/* Indicator math primitives — pure functions over plain JS arrays.
 *
 * Every helper here takes parallel arrays (numeric) or an array of bars
 * ({time, open, high, low, close, volume}) and returns plain arrays of
 * numbers. NaN is used to represent "not enough data yet" so the caller
 * can produce continuous series without alignment headaches.
 */
(function () {
  "use strict";

  const M = {};

  /** Simple moving average. */
  M.sma = function sma(values, length) {
    const out = new Array(values.length).fill(NaN);
    if (length <= 0) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= length) sum -= values[i - length];
      if (i >= length - 1) out[i] = sum / length;
    }
    return out;
  };

  /** Exponential moving average — seeded with the first SMA(length). */
  M.ema = function ema(values, length) {
    const out = new Array(values.length).fill(NaN);
    if (length <= 0 || values.length < length) return out;
    const k = 2 / (length + 1);
    let seed = 0;
    for (let i = 0; i < length; i++) seed += values[i];
    out[length - 1] = seed / length;
    for (let i = length; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  };

  /** Wilder's smoothing — used by RSI, ADX, ATR. Like EMA with k = 1/length. */
  M.wilder = function wilder(values, length) {
    const out = new Array(values.length).fill(NaN);
    if (length <= 0 || values.length < length) return out;
    let seed = 0;
    for (let i = 0; i < length; i++) seed += values[i];
    out[length - 1] = seed / length;
    for (let i = length; i < values.length; i++) {
      out[i] = (out[i - 1] * (length - 1) + values[i]) / length;
    }
    return out;
  };

  /** Rolling population standard deviation. */
  M.stdev = function stdev(values, length) {
    const out = new Array(values.length).fill(NaN);
    if (length <= 0) return out;
    for (let i = length - 1; i < values.length; i++) {
      let sum = 0;
      for (let j = i - length + 1; j <= i; j++) sum += values[j];
      const mean = sum / length;
      let v = 0;
      for (let j = i - length + 1; j <= i; j++) {
        const d = values[j] - mean;
        v += d * d;
      }
      out[i] = Math.sqrt(v / length);
    }
    return out;
  };

  /** Rolling-window highest value. */
  M.highest = function highest(values, length) {
    const out = new Array(values.length).fill(NaN);
    for (let i = length - 1; i < values.length; i++) {
      let m = -Infinity;
      for (let j = i - length + 1; j <= i; j++) if (values[j] > m) m = values[j];
      out[i] = m;
    }
    return out;
  };

  /** Rolling-window lowest value. */
  M.lowest = function lowest(values, length) {
    const out = new Array(values.length).fill(NaN);
    for (let i = length - 1; i < values.length; i++) {
      let m = Infinity;
      for (let j = i - length + 1; j <= i; j++) if (values[j] < m) m = values[j];
      out[i] = m;
    }
    return out;
  };

  /** True range — needed by ATR, Keltner, Supertrend, ADX. */
  M.trueRange = function trueRange(bars) {
    const out = new Array(bars.length).fill(NaN);
    if (!bars.length) return out;
    out[0] = bars[0].high - bars[0].low;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const prev = bars[i - 1].close;
      out[i] = Math.max(
        b.high - b.low,
        Math.abs(b.high - prev),
        Math.abs(b.low  - prev),
      );
    }
    return out;
  };

  /** Average True Range — Wilder-smoothed True Range. */
  M.atr = function atr(bars, length) {
    return M.wilder(M.trueRange(bars), length);
  };

  /** Typical price ((H+L+C)/3) — used by VWAP, CCI, MFI. */
  M.typical = function typical(bars) {
    return bars.map(b => (b.high + b.low + b.close) / 3);
  };

  /** Pluck a single OHLCV field as a number array. */
  M.pluck = function pluck(bars, key) {
    return bars.map(b => +b[key]);
  };

  /** Linear regression slope/intercept over a window — returns line endpoints. */
  M.linreg = function linreg(values, length) {
    const out = new Array(values.length).fill(NaN);
    if (length < 2) return out;
    for (let i = length - 1; i < values.length; i++) {
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let j = 0; j < length; j++) {
        const x = j;
        const y = values[i - length + 1 + j];
        sx += x; sy += y; sxy += x * y; sxx += x * x;
      }
      const denom = (length * sxx - sx * sx) || 1;
      const slope = (length * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / length;
      out[i] = slope * (length - 1) + intercept;   // value at the *last* bar
    }
    return out;
  };

  window.IndicatorMath = M;
})();
