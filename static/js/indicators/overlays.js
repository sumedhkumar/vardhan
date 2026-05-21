/* Overlay indicators — drawn on the main price pane (paneIndex 0).
 *
 * Each indicator registers itself into ``window.IndicatorRegistry`` with the
 * shape:
 *
 *   {
 *     id, name, kind: "overlay" | "oscillator",
 *     defaults:  { ...params },
 *     paramSpec: [{ key, type, default, min?, max? }],
 *     compute(bars, params) -> {seriesData by output key},
 *     render(chart, paneIndex, computed, params) -> seriesHandles[],
 *     updateLast(handles, bars, params) -> void
 *   }
 *
 * The render output's structure depends on the indicator and is interpreted
 * exclusively by ind_manager.js — we never expose it back up.
 *
 * ``LightweightCharts`` v5 series API used here:
 *     chart.addSeries(LightweightCharts.LineSeries, opts, paneIndex)
 *     chart.addSeries(LightweightCharts.AreaSeries, opts, paneIndex)
 *     chart.removeSeries(handle)
 */
(function () {
  "use strict";

  const M = window.IndicatorMath;
  const REG = window.IndicatorRegistry = window.IndicatorRegistry || {};

  // -------------------------------------------------------------- shared utils

  function attachLine(chart, paneIndex, opts) {
    return chart.addSeries(LightweightCharts.LineSeries, Object.assign({
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, opts || {}), paneIndex);
  }

  function alignLine(values, bars) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isFinite(v)) out.push({ time: bars[i].time, value: v });
    }
    return out;
  }

  function lastFinite(values) {
    for (let i = values.length - 1; i >= 0; i--) {
      if (Number.isFinite(values[i])) return values[i];
    }
    return NaN;
  }

  function updateLastLine(handle, values, bars) {
    if (!values.length) return;
    const i = values.length - 1;
    const v = values[i];
    if (Number.isFinite(v)) handle.update({ time: bars[i].time, value: v });
  }

  // ------------------------------------------------------------------ SMA

  REG.sma = {
    id: "sma", name: "Simple Moving Average", kind: "overlay",
    defaults:  { length: 20, color: "#FFB86B" },
    paramSpec: [
      { key: "length", type: "int",   default: 20, min: 2, max: 500 },
      { key: "color",  type: "color", default: "#FFB86B" },
    ],
    compute(bars, p) { return { line: M.sma(M.pluck(bars, "close"), p.length) }; },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: p.color, title: `SMA(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = M.sma(M.pluck(bars, "close"), p.length);
      updateLastLine(handles[0], c, bars);
    },
  };

  // ------------------------------------------------------------------ EMA

  REG.ema = {
    id: "ema", name: "Exponential Moving Average", kind: "overlay",
    defaults:  { length: 21, color: "#79E3FF" },
    paramSpec: [
      { key: "length", type: "int",   default: 21, min: 2, max: 500 },
      { key: "color",  type: "color", default: "#79E3FF" },
    ],
    compute(bars, p) { return { line: M.ema(M.pluck(bars, "close"), p.length) }; },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: p.color, title: `EMA(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = M.ema(M.pluck(bars, "close"), p.length);
      updateLastLine(handles[0], c, bars);
    },
  };

  // -------------------------------------------------------- Bollinger Bands

  REG.bb = {
    id: "bb", name: "Bollinger Bands", kind: "overlay",
    defaults:  { length: 20, mult: 2 },
    paramSpec: [
      { key: "length", type: "int",   default: 20, min: 2, max: 500 },
      { key: "mult",   type: "float", default: 2,  min: 0.1, max: 10 },
    ],
    compute(bars, p) {
      const closes = M.pluck(bars, "close");
      const basis  = M.sma(closes, p.length);
      const sd     = M.stdev(closes, p.length);
      const upper  = basis.map((b, i) => b + p.mult * sd[i]);
      const lower  = basis.map((b, i) => b - p.mult * sd[i]);
      return { upper, basis, lower };
    },
    render(chart, paneIndex, c) {
      const u = attachLine(chart, paneIndex, { color: "#5af0c0", title: "BB upper" });
      const m = attachLine(chart, paneIndex, { color: "#aab1c0", title: "BB basis", lineStyle: 2 });
      const l = attachLine(chart, paneIndex, { color: "#5af0c0", title: "BB lower" });
      u.setData(alignLine(c.upper, this._bars));
      m.setData(alignLine(c.basis, this._bars));
      l.setData(alignLine(c.lower, this._bars));
      return [u, m, l];
    },
    updateLast(handles, bars, p) {
      const c = REG.bb.compute(bars, p);
      updateLastLine(handles[0], c.upper, bars);
      updateLastLine(handles[1], c.basis, bars);
      updateLastLine(handles[2], c.lower, bars);
    },
  };

  // ------------------------------------------------------------------ VWAP

  REG.vwap = {
    id: "vwap", name: "VWAP (session)", kind: "overlay",
    defaults:  { color: "#FFE066" },
    paramSpec: [{ key: "color", type: "color", default: "#FFE066" }],
    compute(bars) {
      // Reset cumulative sums whenever the UTC date changes.
      const out = new Array(bars.length).fill(NaN);
      let day = -1, sumPV = 0, sumV = 0;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const d = Math.floor(b.time / 86400);
        if (d !== day) { day = d; sumPV = 0; sumV = 0; }
        const tp = (b.high + b.low + b.close) / 3;
        const v = b.volume || 0;
        sumPV += tp * v;
        sumV  += v;
        out[i] = sumV ? sumPV / sumV : tp;
      }
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: p.color, title: "VWAP" });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.vwap.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // -------------------------------------------------------- Donchian Channels

  REG.donchian = {
    id: "donchian", name: "Donchian Channels", kind: "overlay",
    defaults:  { length: 20 },
    paramSpec: [{ key: "length", type: "int", default: 20, min: 2, max: 500 }],
    compute(bars, p) {
      const upper = M.highest(M.pluck(bars, "high"), p.length);
      const lower = M.lowest(M.pluck(bars, "low"),  p.length);
      const basis = upper.map((u, i) => (u + lower[i]) / 2);
      return { upper, basis, lower };
    },
    render(chart, paneIndex, c) {
      const u = attachLine(chart, paneIndex, { color: "#9aa6f0", title: "Donchian upper" });
      const m = attachLine(chart, paneIndex, { color: "#777e95", title: "Donchian mid", lineStyle: 2 });
      const l = attachLine(chart, paneIndex, { color: "#9aa6f0", title: "Donchian lower" });
      u.setData(alignLine(c.upper, this._bars));
      m.setData(alignLine(c.basis, this._bars));
      l.setData(alignLine(c.lower, this._bars));
      return [u, m, l];
    },
    updateLast(handles, bars, p) {
      const c = REG.donchian.compute(bars, p);
      updateLastLine(handles[0], c.upper, bars);
      updateLastLine(handles[1], c.basis, bars);
      updateLastLine(handles[2], c.lower, bars);
    },
  };

  // -------------------------------------------------------- Keltner Channels

  REG.keltner = {
    id: "keltner", name: "Keltner Channels", kind: "overlay",
    defaults:  { length: 20, mult: 2, atrLen: 10 },
    paramSpec: [
      { key: "length", type: "int",   default: 20, min: 2, max: 500 },
      { key: "mult",   type: "float", default: 2,  min: 0.1, max: 10 },
      { key: "atrLen", type: "int",   default: 10, min: 2, max: 500 },
    ],
    compute(bars, p) {
      const basis = M.ema(M.pluck(bars, "close"), p.length);
      const at    = M.atr(bars, p.atrLen);
      const upper = basis.map((b, i) => b + p.mult * at[i]);
      const lower = basis.map((b, i) => b - p.mult * at[i]);
      return { upper, basis, lower };
    },
    render(chart, paneIndex, c) {
      const u = attachLine(chart, paneIndex, { color: "#f0a96a", title: "Keltner upper" });
      const m = attachLine(chart, paneIndex, { color: "#a89070", title: "Keltner basis", lineStyle: 2 });
      const l = attachLine(chart, paneIndex, { color: "#f0a96a", title: "Keltner lower" });
      u.setData(alignLine(c.upper, this._bars));
      m.setData(alignLine(c.basis, this._bars));
      l.setData(alignLine(c.lower, this._bars));
      return [u, m, l];
    },
    updateLast(handles, bars, p) {
      const c = REG.keltner.compute(bars, p);
      updateLastLine(handles[0], c.upper, bars);
      updateLastLine(handles[1], c.basis, bars);
      updateLastLine(handles[2], c.lower, bars);
    },
  };

  // ----------------------------------------------------------- Ichimoku Cloud

  REG.ichimoku = {
    id: "ichimoku", name: "Ichimoku Cloud", kind: "overlay",
    defaults:  { conv: 9, base: 26, spanB: 52, displace: 26 },
    paramSpec: [
      { key: "conv",     type: "int", default: 9,  min: 1, max: 200 },
      { key: "base",     type: "int", default: 26, min: 1, max: 400 },
      { key: "spanB",    type: "int", default: 52, min: 1, max: 800 },
      { key: "displace", type: "int", default: 26, min: 0, max: 200 },
    ],
    compute(bars, p) {
      const highs = M.pluck(bars, "high");
      const lows  = M.pluck(bars, "low");
      const cHi = M.highest(highs, p.conv);
      const cLo = M.lowest(lows, p.conv);
      const bHi = M.highest(highs, p.base);
      const bLo = M.lowest(lows, p.base);
      const sBHi = M.highest(highs, p.spanB);
      const sBLo = M.lowest(lows, p.spanB);
      const conv = cHi.map((h, i) => (h + cLo[i]) / 2);
      const base = bHi.map((h, i) => (h + bLo[i]) / 2);
      const spanARaw = conv.map((v, i) => (v + base[i]) / 2);
      const spanBRaw = sBHi.map((h, i) => (h + sBLo[i]) / 2);
      // Spans are displaced forward by p.displace bars; we shift indices.
      const spanA = new Array(bars.length).fill(NaN);
      const spanB = new Array(bars.length).fill(NaN);
      for (let i = 0; i < bars.length; i++) {
        const j = i - p.displace;
        if (j >= 0) {
          spanA[i] = spanARaw[j];
          spanB[i] = spanBRaw[j];
        }
      }
      return { conv, base, spanA, spanB };
    },
    render(chart, paneIndex, c) {
      const cn = attachLine(chart, paneIndex, { color: "#3ecbff", title: "Tenkan" });
      const bs = attachLine(chart, paneIndex, { color: "#ff6b9a", title: "Kijun" });
      const sa = attachLine(chart, paneIndex, { color: "#16c784", title: "Span A" });
      const sb = attachLine(chart, paneIndex, { color: "#ea3943", title: "Span B" });
      cn.setData(alignLine(c.conv,  this._bars));
      bs.setData(alignLine(c.base,  this._bars));
      sa.setData(alignLine(c.spanA, this._bars));
      sb.setData(alignLine(c.spanB, this._bars));
      return [cn, bs, sa, sb];
    },
    updateLast(handles, bars, p) {
      const c = REG.ichimoku.compute(bars, p);
      updateLastLine(handles[0], c.conv,  bars);
      updateLastLine(handles[1], c.base,  bars);
      updateLastLine(handles[2], c.spanA, bars);
      updateLastLine(handles[3], c.spanB, bars);
    },
  };

  // ------------------------------------------------------------- Supertrend

  REG.supertrend = {
    id: "supertrend", name: "Supertrend", kind: "overlay",
    defaults:  { length: 10, mult: 3 },
    paramSpec: [
      { key: "length", type: "int",   default: 10, min: 2, max: 200 },
      { key: "mult",   type: "float", default: 3,  min: 0.1, max: 20 },
    ],
    compute(bars, p) {
      const at = M.atr(bars, p.length);
      const out = new Array(bars.length).fill(NaN);
      const dir = new Array(bars.length).fill(0);   // +1 long, -1 short
      let prevUpper = NaN, prevLower = NaN, prevTrend = 1, prevST = NaN;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const hl2 = (b.high + b.low) / 2;
        const a = at[i];
        if (!Number.isFinite(a)) continue;
        let upper = hl2 + p.mult * a;
        let lower = hl2 - p.mult * a;
        if (Number.isFinite(prevUpper)) {
          if (upper > prevUpper && bars[i - 1].close <= prevUpper) upper = prevUpper;
          if (lower < prevLower && bars[i - 1].close >= prevLower) lower = prevLower;
        }
        let trend = prevTrend;
        if (b.close > prevUpper) trend = 1;
        else if (b.close < prevLower) trend = -1;
        const st = trend === 1 ? lower : upper;
        out[i] = st;
        dir[i] = trend;
        prevUpper = upper; prevLower = lower; prevTrend = trend; prevST = st;
      }
      return { line: out, dir };
    },
    render(chart, paneIndex, c) {
      // Single line that "switches" colour by direction. Lightweight Charts
      // can't do per-segment colour on one line series, so we attach two
      // line series (long / short) and emit NaN gaps where the trend isn't
      // active. This keeps things visually faithful.
      const longH  = attachLine(chart, paneIndex, { color: "#16c784", title: "Supertrend↑", lineWidth: 2 });
      const shortH = attachLine(chart, paneIndex, { color: "#ea3943", title: "Supertrend↓", lineWidth: 2 });
      const longD  = [], shortD = [];
      for (let i = 0; i < this._bars.length; i++) {
        const v = c.line[i], d = c.dir[i];
        if (!Number.isFinite(v)) continue;
        if (d === 1)      longD.push({ time: this._bars[i].time, value: v });
        else if (d === -1) shortD.push({ time: this._bars[i].time, value: v });
      }
      longH.setData(longD);
      shortH.setData(shortD);
      return [longH, shortH];
    },
    updateLast(handles, bars, p) {
      // Cheaper to recompute and replace the tail than maintain state.
      const c = REG.supertrend.compute(bars, p);
      const i = bars.length - 1;
      const v = c.line[i], d = c.dir[i];
      if (!Number.isFinite(v)) return;
      const point = { time: bars[i].time, value: v };
      if (d === 1) handles[0].update(point);
      else         handles[1].update(point);
    },
  };

  // -------------------------------------------------------- Linear Regression

  REG.linreg = {
    id: "linreg", name: "Linear Regression", kind: "overlay",
    defaults:  { length: 50, color: "#c79bff" },
    paramSpec: [
      { key: "length", type: "int",   default: 50, min: 2, max: 500 },
      { key: "color",  type: "color", default: "#c79bff" },
    ],
    compute(bars, p) {
      return { line: M.linreg(M.pluck(bars, "close"), p.length) };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: p.color, title: `LinReg(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.linreg.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // -------------------------------------------------------- Pivot Points (daily)

  REG.pivot = {
    id: "pivot", name: "Pivot Points (daily)", kind: "overlay",
    defaults:  {},
    paramSpec: [],
    compute(bars) {
      // Compute previous day's H/L/C, then plot R3..S3 as horizontal lines
      // for the current day. We project today's pivots onto every bar
      // belonging to today's UTC date.
      const out = {
        p: new Array(bars.length).fill(NaN),
        r1: new Array(bars.length).fill(NaN), s1: new Array(bars.length).fill(NaN),
        r2: new Array(bars.length).fill(NaN), s2: new Array(bars.length).fill(NaN),
      };
      // Bucket bars by UTC date.
      const days = new Map();
      for (let i = 0; i < bars.length; i++) {
        const d = Math.floor(bars[i].time / 86400);
        if (!days.has(d)) days.set(d, []);
        days.get(d).push(i);
      }
      const keys = [...days.keys()].sort((a, b) => a - b);
      for (let k = 1; k < keys.length; k++) {
        const prev = keys[k - 1], curr = keys[k];
        const idxs = days.get(prev);
        let h = -Infinity, l = Infinity, c = NaN;
        for (const i of idxs) {
          if (bars[i].high > h) h = bars[i].high;
          if (bars[i].low  < l) l = bars[i].low;
          c = bars[i].close;
        }
        const p  = (h + l + c) / 3;
        const r1 = 2 * p - l, s1 = 2 * p - h;
        const r2 = p + (h - l), s2 = p - (h - l);
        for (const i of days.get(curr)) {
          out.p[i]  = p;
          out.r1[i] = r1; out.s1[i] = s1;
          out.r2[i] = r2; out.s2[i] = s2;
        }
      }
      return out;
    },
    render(chart, paneIndex, c) {
      const styles = {
        p:  { color: "#bfc8d6", title: "Pivot",     lineStyle: 0 },
        r1: { color: "#16c784", title: "R1",        lineStyle: 1 },
        s1: { color: "#ea3943", title: "S1",        lineStyle: 1 },
        r2: { color: "#16c784", title: "R2",        lineStyle: 2 },
        s2: { color: "#ea3943", title: "S2",        lineStyle: 2 },
      };
      const handles = [];
      for (const k of ["p", "r1", "s1", "r2", "s2"]) {
        const h = attachLine(chart, paneIndex, styles[k]);
        h.setData(alignLine(c[k], this._bars));
        handles.push(h);
      }
      return handles;
    },
    updateLast(handles, bars) {
      const c = REG.pivot.compute(bars);
      const keys = ["p", "r1", "s1", "r2", "s2"];
      for (let i = 0; i < keys.length; i++) updateLastLine(handles[i], c[keys[i]], bars);
    },
  };

  // ----------------------------------------------------- Fibonacci Retracement

  REG.fib = {
    id: "fib", name: "Fibonacci Retracement", kind: "overlay",
    defaults:  { lookback: 200 },
    paramSpec: [{ key: "lookback", type: "int", default: 200, min: 20, max: 5000 }],
    compute(bars, p) {
      const n = bars.length, k = Math.min(p.lookback, n);
      if (n < 2) return { lines: {} };
      let hi = -Infinity, lo = Infinity;
      for (let i = n - k; i < n; i++) {
        if (bars[i].high > hi) hi = bars[i].high;
        if (bars[i].low  < lo) lo = bars[i].low;
      }
      const span = hi - lo;
      const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const lines = {};
      for (const r of ratios) lines[r] = hi - r * span;
      return { lines, hi, lo };
    },
    render(chart, paneIndex, c) {
      const out = [];
      const colorMap = { 0: "#16c784", 1: "#ea3943" };
      for (const r of Object.keys(c.lines)) {
        const v = c.lines[r];
        const h = attachLine(chart, paneIndex, {
          color: colorMap[r] || "#aab1c0",
          title: `Fib ${(r * 100).toFixed(1)}%`,
          lineStyle: r === "0" || r === "1" ? 0 : 2,
          lineWidth: 1,
        });
        h.setData(this._bars.length ? [
          { time: this._bars[0].time, value: v },
          { time: this._bars[this._bars.length - 1].time, value: v },
        ] : []);
        out.push(h);
      }
      return out;
    },
    updateLast(handles, bars, p) {
      // Recompute and re-emit the two endpoints of every level.
      const c = REG.fib.compute(bars, p);
      const ratios = Object.keys(c.lines);
      for (let i = 0; i < ratios.length; i++) {
        const v = c.lines[ratios[i]];
        if (bars.length) {
          handles[i].setData([
            { time: bars[0].time, value: v },
            { time: bars[bars.length - 1].time, value: v },
          ]);
        }
      }
    },
  };

  // ------------------------------------------------------------ Heikin-Ashi
  //
  // Heikin-Ashi is a *candle replacement*, not a true overlay. It's
  // implemented as a regular indicator that adds its own candlestick series
  // and (optionally) hides the main one. ind_manager.js handles the special
  // "hide main candles when heikin enabled" flag.

  REG.heikin = {
    id: "heikin", name: "Heikin-Ashi candles", kind: "overlay", replacesCandles: true,
    defaults:  {},
    paramSpec: [],
    compute(bars) {
      const ha = [];
      let prev = null;
      for (const b of bars) {
        const close = (b.open + b.high + b.low + b.close) / 4;
        const open  = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
        const high  = Math.max(b.high, open, close);
        const low   = Math.min(b.low,  open, close);
        const haBar = { time: b.time, open, high, low, close };
        ha.push(haBar);
        prev = haBar;
      }
      return { candles: ha };
    },
    render(chart, paneIndex, c) {
      const h = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: "#16c784", downColor: "#ea3943",
        borderUpColor: "#16c784", borderDownColor: "#ea3943",
        wickUpColor: "#16c784", wickDownColor: "#ea3943",
      }, paneIndex);
      h.setData(c.candles);
      return [h];
    },
    updateLast(handles, bars) {
      const c = REG.heikin.compute(bars);
      const last = c.candles[c.candles.length - 1];
      if (last) handles[0].update(last);
    },
  };
})();
