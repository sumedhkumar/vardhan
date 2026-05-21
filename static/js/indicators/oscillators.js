/* Oscillator indicators — drawn in their own sub-pane below the price pane.
 *
 * ind_manager.js allocates each oscillator a unique paneIndex (>= 1) and is
 * responsible for sizing the panes via ``chart.panes()[i].setHeight()``.
 *
 * Each module here registers itself into ``window.IndicatorRegistry``.
 */
(function () {
  "use strict";

  const M = window.IndicatorMath;
  const REG = window.IndicatorRegistry = window.IndicatorRegistry || {};

  function attachLine(chart, paneIndex, opts) {
    return chart.addSeries(LightweightCharts.LineSeries, Object.assign({
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    }, opts || {}), paneIndex);
  }

  function attachHist(chart, paneIndex, opts) {
    return chart.addSeries(LightweightCharts.HistogramSeries, Object.assign({
      priceLineVisible: false,
      lastValueVisible: false,
    }, opts || {}), paneIndex);
  }

  function alignLine(values, bars) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) out.push({ time: bars[i].time, value: values[i] });
    }
    return out;
  }

  function alignHist(values, bars, colorFn) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) {
        out.push({ time: bars[i].time, value: values[i], color: colorFn ? colorFn(values[i], i) : undefined });
      }
    }
    return out;
  }

  function updateLastLine(handle, values, bars) {
    if (!values.length) return;
    const i = values.length - 1;
    if (Number.isFinite(values[i])) handle.update({ time: bars[i].time, value: values[i] });
  }

  // ------------------------------------------------------------------ RSI

  REG.rsi = {
    id: "rsi", name: "RSI", kind: "oscillator",
    defaults:  { length: 14 },
    paramSpec: [{ key: "length", type: "int", default: 14, min: 2, max: 200 }],
    compute(bars, p) {
      const closes = M.pluck(bars, "close");
      const gains = new Array(closes.length).fill(0);
      const losses = new Array(closes.length).fill(0);
      for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains[i] = d; else losses[i] = -d;
      }
      const avgG = M.wilder(gains, p.length);
      const avgL = M.wilder(losses, p.length);
      const out = avgG.map((g, i) => {
        const l = avgL[i];
        if (!Number.isFinite(g) || !Number.isFinite(l)) return NaN;
        if (l === 0) return 100;
        return 100 - 100 / (1 + g / l);
      });
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#79E3FF", title: `RSI(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      // Reference levels (30 / 70).
      const lo = attachLine(chart, paneIndex, { color: "#ea394355", title: "30", lineStyle: 2, lineWidth: 1 });
      const hi = attachLine(chart, paneIndex, { color: "#16c78455", title: "70", lineStyle: 2, lineWidth: 1 });
      const span = this._bars.length
        ? [{ time: this._bars[0].time, value: 30 }, { time: this._bars[this._bars.length - 1].time, value: 30 }]
        : [];
      const span2 = span.map(p => ({ ...p, value: 70 }));
      lo.setData(span); hi.setData(span2);
      return [h, lo, hi];
    },
    updateLast(handles, bars, p) {
      const c = REG.rsi.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- MACD

  REG.macd = {
    id: "macd", name: "MACD", kind: "oscillator",
    defaults:  { fast: 12, slow: 26, signal: 9 },
    paramSpec: [
      { key: "fast",   type: "int", default: 12, min: 2, max: 200 },
      { key: "slow",   type: "int", default: 26, min: 2, max: 400 },
      { key: "signal", type: "int", default: 9,  min: 2, max: 200 },
    ],
    compute(bars, p) {
      const closes = M.pluck(bars, "close");
      const fast = M.ema(closes, p.fast);
      const slow = M.ema(closes, p.slow);
      const macd = fast.map((f, i) => f - slow[i]);
      const signal = M.ema(macd, p.signal);
      const hist = macd.map((m, i) => m - signal[i]);
      return { macd, signal, hist };
    },
    render(chart, paneIndex, c) {
      const macdH = attachLine(chart, paneIndex, { color: "#79E3FF", title: "MACD" });
      const sigH  = attachLine(chart, paneIndex, { color: "#FF6B9A", title: "signal" });
      const histH = attachHist(chart, paneIndex, { title: "hist" });
      macdH.setData(alignLine(c.macd,   this._bars));
      sigH .setData(alignLine(c.signal, this._bars));
      histH.setData(alignHist(c.hist,   this._bars, (v) => v >= 0 ? "#16c78499" : "#ea394399"));
      return [macdH, sigH, histH];
    },
    updateLast(handles, bars, p) {
      const c = REG.macd.compute(bars, p);
      updateLastLine(handles[0], c.macd, bars);
      updateLastLine(handles[1], c.signal, bars);
      const i = c.hist.length - 1;
      if (Number.isFinite(c.hist[i])) {
        handles[2].update({
          time: bars[i].time, value: c.hist[i],
          color: c.hist[i] >= 0 ? "#16c78499" : "#ea394399",
        });
      }
    },
  };

  // ------------------------------------------------------------ Stochastic

  REG.stoch = {
    id: "stoch", name: "Stochastic", kind: "oscillator",
    defaults:  { k: 14, d: 3, smooth: 3 },
    paramSpec: [
      { key: "k",      type: "int", default: 14, min: 2, max: 200 },
      { key: "d",      type: "int", default: 3,  min: 1, max: 100 },
      { key: "smooth", type: "int", default: 3,  min: 1, max: 100 },
    ],
    compute(bars, p) {
      const highs = M.pluck(bars, "high");
      const lows  = M.pluck(bars, "low");
      const closes = M.pluck(bars, "close");
      const hh = M.highest(highs, p.k);
      const ll = M.lowest(lows,  p.k);
      const rawK = closes.map((c, i) => {
        const r = hh[i] - ll[i];
        return r ? ((c - ll[i]) / r) * 100 : NaN;
      });
      const kLine = M.sma(rawK, p.smooth);
      const dLine = M.sma(kLine, p.d);
      return { k: kLine, d: dLine };
    },
    render(chart, paneIndex, c) {
      const k = attachLine(chart, paneIndex, { color: "#79E3FF", title: "%K" });
      const d = attachLine(chart, paneIndex, { color: "#FFB86B", title: "%D" });
      k.setData(alignLine(c.k, this._bars));
      d.setData(alignLine(c.d, this._bars));
      return [k, d];
    },
    updateLast(handles, bars, p) {
      const c = REG.stoch.compute(bars, p);
      updateLastLine(handles[0], c.k, bars);
      updateLastLine(handles[1], c.d, bars);
    },
  };

  // ------------------------------------------------------------------ ADX

  REG.adx = {
    id: "adx", name: "ADX (+DI / -DI)", kind: "oscillator",
    defaults:  { length: 14 },
    paramSpec: [{ key: "length", type: "int", default: 14, min: 2, max: 200 }],
    compute(bars, p) {
      const n = bars.length;
      const tr  = M.trueRange(bars);
      const plusDM  = new Array(n).fill(0);
      const minusDM = new Array(n).fill(0);
      for (let i = 1; i < n; i++) {
        const up = bars[i].high - bars[i - 1].high;
        const dn = bars[i - 1].low - bars[i].low;
        plusDM[i]  = up > dn && up > 0 ? up : 0;
        minusDM[i] = dn > up && dn > 0 ? dn : 0;
      }
      const trS  = M.wilder(tr, p.length);
      const pDMS = M.wilder(plusDM, p.length);
      const mDMS = M.wilder(minusDM, p.length);
      const plusDI  = pDMS.map((v, i) => trS[i] ? 100 * v / trS[i] : NaN);
      const minusDI = mDMS.map((v, i) => trS[i] ? 100 * v / trS[i] : NaN);
      const dx = plusDI.map((p, i) => {
        const m = minusDI[i];
        const sum = p + m;
        return sum ? 100 * Math.abs(p - m) / sum : NaN;
      });
      const adx = M.wilder(dx, p.length);
      return { adx, plusDI, minusDI };
    },
    render(chart, paneIndex, c) {
      const adxH = attachLine(chart, paneIndex, { color: "#FFE066", title: "ADX",  lineWidth: 2 });
      const pdH  = attachLine(chart, paneIndex, { color: "#16c784", title: "+DI",  lineWidth: 1 });
      const mdH  = attachLine(chart, paneIndex, { color: "#ea3943", title: "-DI",  lineWidth: 1 });
      adxH.setData(alignLine(c.adx,     this._bars));
      pdH .setData(alignLine(c.plusDI,  this._bars));
      mdH .setData(alignLine(c.minusDI, this._bars));
      return [adxH, pdH, mdH];
    },
    updateLast(handles, bars, p) {
      const c = REG.adx.compute(bars, p);
      updateLastLine(handles[0], c.adx,     bars);
      updateLastLine(handles[1], c.plusDI,  bars);
      updateLastLine(handles[2], c.minusDI, bars);
    },
  };

  // ------------------------------------------------------------------ ATR

  REG.atr = {
    id: "atr", name: "ATR", kind: "oscillator",
    defaults:  { length: 14 },
    paramSpec: [{ key: "length", type: "int", default: 14, min: 2, max: 200 }],
    compute(bars, p) { return { line: M.atr(bars, p.length) }; },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#FFB86B", title: `ATR(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.atr.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- OBV

  REG.obv = {
    id: "obv", name: "OBV (On-Balance Volume)", kind: "oscillator",
    defaults:  {},
    paramSpec: [],
    compute(bars) {
      const out = new Array(bars.length).fill(0);
      for (let i = 1; i < bars.length; i++) {
        const v = bars[i].volume || 0;
        const dir = bars[i].close > bars[i - 1].close ? 1 : bars[i].close < bars[i - 1].close ? -1 : 0;
        out[i] = out[i - 1] + dir * v;
      }
      return { line: out };
    },
    render(chart, paneIndex, c) {
      const h = attachLine(chart, paneIndex, { color: "#79E3FF", title: "OBV" });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars) {
      const c = REG.obv.compute(bars);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- CCI

  REG.cci = {
    id: "cci", name: "CCI", kind: "oscillator",
    defaults:  { length: 20 },
    paramSpec: [{ key: "length", type: "int", default: 20, min: 2, max: 200 }],
    compute(bars, p) {
      const tp = M.typical(bars);
      const tpSMA = M.sma(tp, p.length);
      const out = new Array(bars.length).fill(NaN);
      for (let i = p.length - 1; i < bars.length; i++) {
        let mad = 0;
        for (let j = i - p.length + 1; j <= i; j++) mad += Math.abs(tp[j] - tpSMA[i]);
        mad /= p.length;
        out[i] = mad ? (tp[i] - tpSMA[i]) / (0.015 * mad) : NaN;
      }
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#c79bff", title: `CCI(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.cci.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // -------------------------------------------------------- Williams %R

  REG.willr = {
    id: "willr", name: "Williams %R", kind: "oscillator",
    defaults:  { length: 14 },
    paramSpec: [{ key: "length", type: "int", default: 14, min: 2, max: 200 }],
    compute(bars, p) {
      const hh = M.highest(M.pluck(bars, "high"), p.length);
      const ll = M.lowest(M.pluck(bars, "low"),  p.length);
      const closes = M.pluck(bars, "close");
      const out = closes.map((c, i) => {
        const r = hh[i] - ll[i];
        return r ? -100 * (hh[i] - c) / r : NaN;
      });
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#FFB86B", title: `%R(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.willr.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- ROC

  REG.roc = {
    id: "roc", name: "Rate of Change", kind: "oscillator",
    defaults:  { length: 12 },
    paramSpec: [{ key: "length", type: "int", default: 12, min: 1, max: 200 }],
    compute(bars, p) {
      const closes = M.pluck(bars, "close");
      const out = new Array(closes.length).fill(NaN);
      for (let i = p.length; i < closes.length; i++) {
        const prev = closes[i - p.length];
        out[i] = prev ? ((closes[i] - prev) / prev) * 100 : NaN;
      }
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#5af0c0", title: `ROC(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.roc.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- MFI

  REG.mfi = {
    id: "mfi", name: "Money Flow Index", kind: "oscillator",
    defaults:  { length: 14 },
    paramSpec: [{ key: "length", type: "int", default: 14, min: 2, max: 200 }],
    compute(bars, p) {
      const tp = M.typical(bars);
      const out = new Array(bars.length).fill(NaN);
      for (let i = p.length; i < bars.length; i++) {
        let pos = 0, neg = 0;
        for (let j = i - p.length + 1; j <= i; j++) {
          const flow = tp[j] * (bars[j].volume || 0);
          if (tp[j] > tp[j - 1])      pos += flow;
          else if (tp[j] < tp[j - 1]) neg += flow;
        }
        out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      }
      return { line: out };
    },
    render(chart, paneIndex, c, p) {
      const h = attachLine(chart, paneIndex, { color: "#FFE066", title: `MFI(${p.length})` });
      h.setData(alignLine(c.line, this._bars));
      return [h];
    },
    updateLast(handles, bars, p) {
      const c = REG.mfi.compute(bars, p);
      updateLastLine(handles[0], c.line, bars);
    },
  };

  // ----------------------------------------------------------------- Volume

  REG.volume = {
    id: "volume", name: "Volume", kind: "oscillator",
    defaults:  {},
    paramSpec: [],
    compute(bars) {
      const out = bars.map((b, i) => ({
        time: b.time,
        value: b.volume || 0,
        color: i === 0 || b.close >= bars[i - 1].close ? "#16c78477" : "#ea394377",
      }));
      return { hist: out };
    },
    render(chart, paneIndex, c) {
      const h = attachHist(chart, paneIndex, { title: "Volume" });
      h.setData(c.hist);
      return [h];
    },
    updateLast(handles, bars) {
      const c = REG.volume.compute(bars);
      const last = c.hist[c.hist.length - 1];
      if (last) handles[0].update(last);
    },
  };
})();
