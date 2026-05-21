/* Pane component — one chart + ticker + controls + indicators + backtest.
 *
 * Owns:
 *   - a Lightweight Charts v5 instance with a candlestick series
 *   - a header (source / symbol-autocomplete / timeframe / indicators /
 *     backtest / refresh + ticker bar)
 *   - one active subscription (Hyperliquid WS, yfinance polling, or forex
 *     polling — the last two share the YFinance client under the hood)
 *   - an IndicatorManager + IndicatorPopover
 *   - a BacktestPanel
 *
 * Public API:
 *   const pane = new Pane(root, { state, onStateChange })
 *   pane.setState(partial)
 *   pane.resize()
 *   pane.destroy()
 */
(function () {
  "use strict";

  const FLASH_MS = 250;

  // Default state used when a pane is created without persisted state.
  const DEFAULT_STATE = {
    source: "hyperliquid",
    symbol: "BTC",
    interval: "5m",
    // The IndicatorManager keys state by indicator id, so two instances of
    // the same indicator (e.g. two EMAs with different lengths) can't be
    // active at once. Defaults pick distinct ids: SMA + EMA + Volume.
    indicators: [
      { id: "sma",    params: { length: 20, color: "#FFB86B" } },
      { id: "ema",    params: { length: 50, color: "#79E3FF" } },
      { id: "volume", params: {} },
    ],
    backtest: Object.assign({}, (window.BacktestPanel && window.BacktestPanel.DEFAULT_STATE) || {
      open: false, strategy: "ema_cross", params: {}, capital: 100000,
      feeBps: 5, slipBps: 2, showMarkers: true,
    }),
  };

  function fmtPrice(p) {
    if (p == null || !isFinite(p)) return "—";
    if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (p >= 1)    return p.toFixed(4);
    return p.toFixed(6);
  }

  function fmtChange(curr, base) {
    if (base == null || !isFinite(base) || base === 0) return "";
    const pct = ((curr - base) / base) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
  }

  function clientFor(source) {
    if (source === "hyperliquid") return window.HyperliquidClient;
    // yfinance + forex both flow through the polling YFinance client; the
    // `source=forex` param is what tells the Flask backend to use the
    // ForexSource wrapper.
    return window.YFinanceClient;
  }

  class Pane {
    constructor(root, { state, onStateChange } = {}) {
      this.root = root;
      // Deep-merge persisted state on top of defaults so older state shapes
      // (without indicators/backtest) get filled in.
      const initial = state || {};
      this.state = Object.assign({}, DEFAULT_STATE, initial, {
        indicators: initial.indicators || DEFAULT_STATE.indicators.slice(),
        backtest:   Object.assign({}, DEFAULT_STATE.backtest, initial.backtest || {}),
      });
      this.onStateChange = onStateChange || (() => {});

      this._sub = null;
      this._bars = [];
      this._lastClose = null;
      this._lastBarTime = null;
      this._sessionOpen = null;
      this._flashTimer = null;
      this._loadToken = 0;

      this._buildDom();
      this._buildChart();
      this._buildAddons();
      this._wireControls();
      this._reload();
    }

    /* -------------------------------------------------------------- DOM */

    _buildDom() {
      const tpl = document.getElementById("pane-template");
      const node = tpl.content.firstElementChild.cloneNode(true);
      this.root.appendChild(node);
      this.el = node;

      this.elSource   = node.querySelector(".pane__source");
      this.elSymbol   = node.querySelector(".pane__symbol");
      this.elInterval = node.querySelector(".pane__interval");
      this.elIndBtn   = node.querySelector(".pane__indicators");
      this.elBtBtn    = node.querySelector(".pane__backtest");
      this.elRefresh  = node.querySelector(".pane__refresh");

      this.elTicker   = node.querySelector(".pane__ticker");
      this.elTickerSym    = node.querySelector(".pane__ticker-symbol");
      this.elTickerPrice  = node.querySelector(".pane__ticker-price");
      this.elTickerChange = node.querySelector(".pane__ticker-change");
      this.elStatus   = node.querySelector(".pane__status");
      this.elChart    = node.querySelector(".pane__chart");

      this.elSource.value   = this.state.source;
      this.elSymbol.value   = this.state.symbol;
      this.elInterval.value = this.state.interval;
      this._renderTickerSymbol();
    }

    _renderTickerSymbol() {
      const label = `${this.state.source.toUpperCase()} · ${this.state.symbol} · ${this.state.interval}`;
      this.elTickerSym.textContent = label;
    }

    /* ------------------------------------------------------------- chart */

    _buildChart() {
      const lc = window.LightweightCharts;
      this.chart = lc.createChart(this.elChart, {
        layout: {
          background: { color: "#131722" },
          textColor: "#d1d4dc",
          fontFamily: "-apple-system, BlinkMacSystemFont, Trebuchet MS, Roboto, Ubuntu, sans-serif",
          panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45" },
        },
        grid: {
          vertLines: { color: "#363a4520" },
          horzLines: { color: "#363a4520" },
        },
        rightPriceScale: { borderColor: "#2a2e39" },
        timeScale: {
          borderColor: "#2a2e39",
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: { mode: lc.CrosshairMode.Normal },
        autoSize: false,
      });
      this.series = this.chart.addSeries(lc.CandlestickSeries, {
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderUpColor: "#26a69a",
        borderDownColor: "#ef5350",
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      });

      requestAnimationFrame(() => this.resize());
    }

    /* ------------------------------------------------------------ addons */

    _buildAddons() {
      this.indicators = new window.IndicatorManager(this.chart, this.series);

      this.indPopover = new window.IndicatorPopover(this.el, {
        manager: this.indicators,
        onChange: () => {
          this.state.indicators = this.indicators.getEnabledList();
          this.onStateChange(this.state);
        },
      });

      this.backtest = new window.BacktestPanel(this.el, {
        getBars: () => this._bars,
        getSeries: () => this.series,
        state: this.state.backtest,
        onState: (s) => {
          this.state.backtest = s;
          this.onStateChange(this.state);
        },
      });

      // Autocomplete attaches to the symbol input. We strip it of any
      // leftover datalist association so the dropdown takes over.
      this.elSymbol.removeAttribute("list");
      this.autocomplete = new window.SymbolAutocomplete(this.elSymbol, {
        getSource: () => this.elSource.value,
        onPick: (row) => {
          // Force the change-handler path so state persists + reload fires.
          this.elSymbol.value = row.symbol;
          this._commitFromControls();
        },
      });
    }

    resize() {
      if (!this.chart) return;
      const rect = this.elChart.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w > 0 && h > 0) this.chart.resize(w, h);
    }

    /* --------------------------------------------------------- controls */

    _wireControls() {
      this.elSource.addEventListener("change", () => {
        this._commitFromControls();
      });
      this.elInterval.addEventListener("change", () => this._commitFromControls());
      this.elSymbol.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.elSymbol.blur(); }
      });
      this.elSymbol.addEventListener("change", () => this._commitFromControls());
      // No blur handler — autocomplete owns blur and triggers onPick instead.

      this.elRefresh.addEventListener("click", () => this._reload());
      this.elIndBtn .addEventListener("click", () => this.indPopover.toggle());
      this.elBtBtn  .addEventListener("click", () => this.backtest.toggle());
    }

    _commitFromControls() {
      const next = {
        source:   this.elSource.value,
        symbol:   (this.elSymbol.value || "").trim().toUpperCase(),
        interval: this.elInterval.value,
      };
      if (!next.symbol) return;
      if (next.source === this.state.source &&
          next.symbol === this.state.symbol &&
          next.interval === this.state.interval) return;
      this.state.source   = next.source;
      this.state.symbol   = next.symbol;
      this.state.interval = next.interval;
      this.elSymbol.value = next.symbol;
      this._renderTickerSymbol();
      this.onStateChange(this.state);
      this._reload();
    }

    setState(partial) {
      Object.assign(this.state, partial || {});
      this.elSource.value   = this.state.source;
      this.elSymbol.value   = this.state.symbol;
      this.elInterval.value = this.state.interval;
      this._renderTickerSymbol();
      this._reload();
    }

    /* ---------------------------------------------------- data lifecycle */

    _setStatus(state) { this.elStatus.dataset.state = state; }

    _teardownSub() {
      if (this._sub) {
        try { this._sub.unsubscribe(); } catch (_) {}
        this._sub = null;
      }
    }

    async _reload() {
      this._teardownSub();
      this._setStatus("loading");
      this.series.setData([]);
      this._bars = [];
      this._lastClose = null;
      this._lastBarTime = null;
      this._sessionOpen = null;
      this._setTickerDirection("flat");
      this.elTickerPrice.textContent = "—";
      this.elTickerChange.textContent = "";
      this._renderTickerSymbol();

      const token = ++this._loadToken;
      const { source, symbol, interval } = this.state;

      const client = clientFor(source);
      if (!client) { this._setStatus("error"); return; }

      // 1) seed history
      let bars = [];
      try {
        bars = await client.fetchHistory(symbol, interval, 500, source);
      } catch (err) {
        if (token !== this._loadToken) return;
        console.error("history error", err);
        this._setStatus("error");
        return;
      }
      if (token !== this._loadToken) return;

      this._bars = bars.slice();

      if (bars.length) {
        this.series.setData(bars);
        const last = bars[bars.length - 1];
        this._lastClose = last.close;
        this._lastBarTime = last.time;
        this._sessionOpen = bars[0].close;
        this._renderTicker(last.close);
        this.chart.timeScale().fitContent();
      } else {
        this._setStatus("error");
      }

      // 2) push bars to indicators (re-renders all enabled overlays + oscillators)
      this.indicators.setBars(this._bars);
      // Apply persisted indicator selection on first load.
      if (!this._indBootstrapped) {
        this._indBootstrapped = true;
        this.indicators.setEnabledList(this.state.indicators || []);
      }

      // 3) live subscription
      this._sub = client.subscribe({
        symbol, interval,
        source,                                   // hint for the YFinance client
        onBar: (bar) => {
          if (token !== this._loadToken) return;
          this._onBar(bar);
        },
        onStatus: (s) => {
          if (token !== this._loadToken) return;
          if (s === "live")    this._setStatus("live");
          if (s === "loading") this._setStatus("loading");
          if (s === "error")   this._setStatus("error");
        },
      });
    }

    _onBar(bar) {
      // Order guard: lightweight-charts' update() throws on out-of-order time.
      if (this._lastBarTime != null && bar.time < this._lastBarTime) return;
      try {
        this.series.update(bar);
      } catch (err) {
        console.warn("series.update rejected bar", err, bar);
        return;
      }
      // Sync our own bars array.
      if (this._bars.length && this._bars[this._bars.length - 1].time === bar.time) {
        this._bars[this._bars.length - 1] = bar;
      } else {
        this._bars.push(bar);
      }
      this._lastBarTime = bar.time;

      // Push incremental update into every active indicator.
      this.indicators.onBar(this._bars);

      this._renderTicker(bar.close);
    }

    /* ----------------------------------------------------------- ticker */

    _renderTicker(price) {
      this.elTickerPrice.textContent  = fmtPrice(price);
      this.elTickerChange.textContent = fmtChange(price, this._sessionOpen);

      let dir = "flat";
      if (this._lastClose != null) {
        if (price > this._lastClose) dir = "up";
        else if (price < this._lastClose) dir = "down";
      }
      this._lastClose = price;
      this._flash(dir);
    }

    _flash(direction) {
      if (direction === "flat") return;
      this._setTickerDirection(direction);
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => {
        this._setTickerDirection("flat");
        this._flashTimer = null;
      }, FLASH_MS);
    }

    _setTickerDirection(d) { this.elTicker.dataset.direction = d; }

    /* ---------------------------------------------------------- destroy */

    destroy() {
      this._teardownSub();
      if (this._flashTimer) { clearTimeout(this._flashTimer); this._flashTimer = null; }
      try { this.indicators && this.indicators.destroy(); } catch (_) {}
      try { this.indPopover && this.indPopover.destroy(); } catch (_) {}
      try { this.backtest   && this.backtest.destroy();   } catch (_) {}
      try { this.autocomplete && this.autocomplete.destroy(); } catch (_) {}
      try { this.chart && this.chart.remove(); } catch (_) {}
      this.chart = null;
      this.series = null;
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  window.Pane = Pane;
  window.Pane.DEFAULT_STATE = DEFAULT_STATE;
})();
