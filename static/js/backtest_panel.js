/* BacktestPanel — slide-in drawer hosted by a single Pane.
 *
 * Renders the strategy picker, parameter inputs, run button, stats and a
 * small equity-curve sparkline. When "Show markers on chart" is on, we use
 * Lightweight Charts v5's ``createSeriesMarkers`` primitive to overlay
 * buy/sell arrows on the pane's main candlestick series.
 *
 * Public API:
 *   const bp = new BacktestPanel(paneEl, { getBars, getSeries, state, onState });
 *   bp.open() / bp.close() / bp.toggle()
 *   bp.destroy()
 */
(function () {
  "use strict";

  const DEFAULT_STATE = {
    open: false,
    strategy: "ema_cross",
    params: {},                    // strategy-specific overrides
    capital: 100000,
    feeBps: 5,
    slipBps: 2,
    showMarkers: true,
  };

  class BacktestPanel {
    constructor(paneRoot, opts) {
      this.paneRoot   = paneRoot;
      this.getBars    = opts.getBars;
      this.getSeries  = opts.getSeries;
      this.onState    = opts.onState || (() => {});
      this.state = Object.assign({}, DEFAULT_STATE, opts.state || {});
      this._lastResult = null;
      this._markersPrim = null;

      this._buildDom();
      this._wire();
      this._renderStrategyForm();
      if (this.state.open) this.open();
    }

    /* ---------------------------------------------------------------- DOM */

    _buildDom() {
      const el = document.createElement("aside");
      el.className = "bt-drawer";
      el.innerHTML = `
        <header class="bt-drawer__head">
          <h3>Backtest</h3>
          <button type="button" class="bt-close" aria-label="close">&times;</button>
        </header>
        <div class="bt-drawer__body">
          <div class="bt-row">
            <label>Strategy</label>
            <select class="bt-strategy"></select>
          </div>
          <div class="bt-params"></div>
          <div class="bt-row bt-row--inline">
            <label>Capital</label>
            <input type="number" class="bt-capital" min="1" step="1000" />
            <label>Fee bps</label>
            <input type="number" class="bt-fee" min="0" max="500" step="1" />
            <label>Slip bps</label>
            <input type="number" class="bt-slip" min="0" max="500" step="1" />
          </div>
          <div class="bt-row">
            <button type="button" class="bt-run">Run backtest</button>
          </div>
          <section class="bt-results" hidden>
            <div class="bt-stats"></div>
            <canvas class="bt-equity" width="320" height="80"></canvas>
            <label class="bt-row bt-row--checkbox">
              <input type="checkbox" class="bt-markers" />
              <span>Show buy/sell markers on chart</span>
            </label>
          </section>
        </div>`;
      this.paneRoot.appendChild(el);
      this.el = el;
      // cached refs
      this.elClose    = el.querySelector(".bt-close");
      this.elStrategy = el.querySelector(".bt-strategy");
      this.elParams   = el.querySelector(".bt-params");
      this.elCapital  = el.querySelector(".bt-capital");
      this.elFee      = el.querySelector(".bt-fee");
      this.elSlip     = el.querySelector(".bt-slip");
      this.elRun      = el.querySelector(".bt-run");
      this.elResults  = el.querySelector(".bt-results");
      this.elStats    = el.querySelector(".bt-stats");
      this.elEquity   = el.querySelector(".bt-equity");
      this.elMarkers  = el.querySelector(".bt-markers");

      // Populate strategy dropdown
      for (const s of window.Strategies.list()) {
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = s.name;
        this.elStrategy.appendChild(o);
      }
      this.elStrategy.value = this.state.strategy;
      this.elCapital.value  = this.state.capital;
      this.elFee.value      = this.state.feeBps;
      this.elSlip.value     = this.state.slipBps;
      this.elMarkers.checked = !!this.state.showMarkers;
    }

    _wire() {
      this.elClose   .addEventListener("click",  () => this.close());
      this.elStrategy.addEventListener("change", () => {
        this.state.strategy = this.elStrategy.value;
        this.state.params = {};
        this._renderStrategyForm();
        this._save();
      });
      this.elCapital.addEventListener("change", () => { this.state.capital  = +this.elCapital.value || 0; this._save(); });
      this.elFee    .addEventListener("change", () => { this.state.feeBps   = +this.elFee.value     || 0; this._save(); });
      this.elSlip   .addEventListener("change", () => { this.state.slipBps  = +this.elSlip.value    || 0; this._save(); });
      this.elMarkers.addEventListener("change", () => {
        this.state.showMarkers = this.elMarkers.checked;
        this._applyMarkers();
        this._save();
      });
      this.elRun.addEventListener("click", () => this.run());
    }

    _renderStrategyForm() {
      const strat = window.Strategies.get(this.state.strategy);
      this.elParams.innerHTML = "";
      if (!strat) return;
      const merged = Object.assign({}, strat.defaults, this.state.params || {});
      for (const spec of strat.paramSpec) {
        const row = document.createElement("div");
        row.className = "bt-row";
        const id = `bt-p-${spec.key}`;
        const min = spec.min != null ? `min="${spec.min}"` : "";
        const max = spec.max != null ? `max="${spec.max}"` : "";
        const step = spec.type === "float" ? `step="0.1"` : `step="1"`;
        row.innerHTML = `<label for="${id}">${spec.key}</label>
          <input id="${id}" type="number" ${min} ${max} ${step} value="${merged[spec.key]}">`;
        const inp = row.querySelector("input");
        inp.addEventListener("change", () => {
          this.state.params = this.state.params || {};
          this.state.params[spec.key] = spec.type === "float" ? parseFloat(inp.value) : parseInt(inp.value, 10);
          this._save();
        });
        this.elParams.appendChild(row);
      }
    }

    _save() { this.onState(this.state); }

    /* --------------------------------------------------------------- run */

    run() {
      const bars = this.getBars();
      const strat = window.Strategies.get(this.state.strategy);
      if (!strat || !bars || bars.length < 2) {
        this.elStats.innerHTML = `<div class="bt-error">Not enough bars to backtest.</div>`;
        this.elResults.hidden = false;
        return;
      }
      // Pass merged params via a clone so we don't mutate the registry.
      const stratWithParams = Object.assign({}, strat, {
        params: Object.assign({}, strat.defaults, this.state.params || {}),
      });
      const result = window.Backtest.run(bars, stratWithParams, {
        capital: this.state.capital,
        feeBps:  this.state.feeBps,
        slipBps: this.state.slipBps,
      });
      this._lastResult = result;
      this._renderStats(result.stats);
      this._renderEquity(result.equity);
      this._applyMarkers();
      this.elResults.hidden = false;
    }

    _renderStats(s) {
      const fmt = (n) => Number.isFinite(n) ? n.toFixed(2) : "—";
      const cls = (n) => n >= 0 ? "ok" : "bad";
      this.elStats.innerHTML = `
        <div class="bt-stat"><span>Total return</span><b class="${cls(s.totalReturnPct)}">${fmt(s.totalReturnPct)}%</b></div>
        <div class="bt-stat"><span>Trades</span><b>${s.totalTrades}</b></div>
        <div class="bt-stat"><span>Win rate</span><b>${fmt(s.winRatePct)}%</b></div>
        <div class="bt-stat"><span>Avg win</span><b class="ok">${fmt(s.avgWinPct)}%</b></div>
        <div class="bt-stat"><span>Avg loss</span><b class="bad">${fmt(s.avgLossPct)}%</b></div>
        <div class="bt-stat"><span>Max DD</span><b class="bad">${fmt(s.maxDrawdownPct)}%</b></div>
        <div class="bt-stat"><span>Profit factor</span><b>${fmt(s.profitFactor)}</b></div>
        <div class="bt-stat"><span>Sharpe</span><b>${fmt(s.sharpe)}</b></div>
        <div class="bt-stat"><span>Expectancy</span><b class="${cls(s.expectancyPct)}">${fmt(s.expectancyPct)}%</b></div>`;
    }

    _renderEquity(equity) {
      const ctx = this.elEquity.getContext("2d");
      const w = this.elEquity.width, h = this.elEquity.height;
      ctx.clearRect(0, 0, w, h);
      if (!equity.length) return;
      let min = Infinity, max = -Infinity;
      for (const e of equity) { if (e.value < min) min = e.value; if (e.value > max) max = e.value; }
      const range = max - min || 1;
      ctx.strokeStyle = "#79E3FF";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < equity.length; i++) {
        const x = (i / (equity.length - 1)) * (w - 2) + 1;
        const y = h - 1 - ((equity[i].value - min) / range) * (h - 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Baseline: starting capital
      const start = equity[0].value;
      const yBase = h - 1 - ((start - min) / range) * (h - 2);
      ctx.strokeStyle = "#aab1c044";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(1, yBase); ctx.lineTo(w - 1, yBase);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    _applyMarkers() {
      const series = this.getSeries();
      if (!series) return;
      const markers = (this.state.showMarkers && this._lastResult)
        ? window.Backtest.tradesToMarkers(this._lastResult.trades) : [];
      // LWC v5 markers primitive
      try {
        if (this._markersPrim) {
          this._markersPrim.setMarkers(markers);
        } else if (window.LightweightCharts && window.LightweightCharts.createSeriesMarkers) {
          this._markersPrim = window.LightweightCharts.createSeriesMarkers(series, markers);
        } else if (typeof series.setMarkers === "function") {
          // Defensive fallback if we ever load an older bundle.
          series.setMarkers(markers);
        }
      } catch (err) {
        console.warn("[backtest] failed to apply markers", err);
      }
    }

    /* -------------------------------------------------------- open/close */

    open()   { this.state.open = true;  this.el.classList.add("is-open");  this._save(); }
    close()  {
      this.state.open = false;
      this.el.classList.remove("is-open");
      // Clear any markers when the panel closes.
      if (this._markersPrim) {
        try { this._markersPrim.setMarkers([]); } catch (_) {}
      }
      this._save();
    }
    toggle() { this.state.open ? this.close() : this.open(); }

    destroy() {
      if (this._markersPrim) {
        try { this._markersPrim.detach && this._markersPrim.detach(); } catch (_) {}
        try { this._markersPrim.setMarkers([]); } catch (_) {}
        this._markersPrim = null;
      }
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  window.BacktestPanel = BacktestPanel;
  window.BacktestPanel.DEFAULT_STATE = DEFAULT_STATE;
})();
