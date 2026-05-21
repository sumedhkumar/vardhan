/* IndicatorManager — owns every indicator series attached to one Pane's chart.
 *
 * Responsibilities:
 *   * Allocate/release oscillator sub-panes (paneIndex >= 1 in LWC v5).
 *   * Drive each indicator's compute + render lifecycle on history reload.
 *   * Push incremental updates on each new bar.
 *   * Persist enabled-indicator state (the Pane handles localStorage).
 *
 * Public API:
 *   const im = new IndicatorManager(chart, mainSeries);
 *   im.setBars(bars)           // history reload — rebuilds everything
 *   im.onBar(bars)             // live tick — incremental update
 *   im.enable(id, params?)
 *   im.disable(id)
 *   im.isEnabled(id)
 *   im.params(id)              // current params for an enabled indicator
 *   im.getEnabledList()        // for persistence: [{id, params}]
 *   im.setEnabledList(list)    // bulk apply (used on pane bootstrap)
 *   im.destroy()
 */
(function () {
  "use strict";

  const MAX_OSC_PANES = 3;       // LWC v5 supports up to 4 panes; keep main + 3 oscillators

  class IndicatorManager {
    constructor(chart, mainSeries) {
      this.chart = chart;
      this.mainSeries = mainSeries;
      this._bars = [];
      this._state = {};          // id -> { params, handles, paneIndex, kind }
      this._oscPanes = [];       // ordered list of paneIndex used by oscillators
    }

    /* ------------------------------------------------------------- bars I/O */

    setBars(bars) {
      this._bars = bars || [];
      // Rebuild every active indicator from scratch — cheaper than tracking
      // diffs across symbol/interval changes.
      const enabled = this.getEnabledList();
      for (const id of Object.keys(this._state)) this._teardown(id);
      this._oscPanes = [];
      for (const e of enabled) this.enable(e.id, e.params, /*persisted=*/true);
    }

    onBar() {
      // Caller passes the up-to-date bars array (already with the live tick
      // applied). We just call updateLast on every active indicator.
      for (const id of Object.keys(this._state)) {
        const s = this._state[id];
        const ind = window.Indicators.get(id);
        if (!ind) continue;
        // Bind _bars onto the indicator's `this` for its render-time helpers.
        ind._bars = this._bars;
        try { ind.updateLast(s.handles, this._bars, s.params); }
        catch (err) { console.warn(`[indicator:${id}] updateLast failed`, err); }
      }
    }

    /* ----------------------------------------------------------- enable/disable */

    enable(id, params, persisted) {
      const ind = window.Indicators.get(id);
      if (!ind) return;
      if (this._state[id]) return;     // already on

      const merged = Object.assign({}, ind.defaults || {}, params || {});

      let paneIndex = 0;
      if (ind.kind === "oscillator") {
        paneIndex = this._allocateOscPane();
        if (paneIndex < 0) {
          console.warn(`[indicator:${id}] oscillator pane cap (${MAX_OSC_PANES}) hit; refusing to enable`);
          return;
        }
      }

      // Render the indicator into the chart.
      ind._bars = this._bars;
      let handles = [];
      try {
        const computed = ind.compute(this._bars, merged);
        handles = ind.render(this.chart, paneIndex, computed, merged) || [];
      } catch (err) {
        console.error(`[indicator:${id}] render failed`, err);
        if (paneIndex > 0) this._releaseOscPane(paneIndex);
        return;
      }

      this._state[id] = { params: merged, handles, paneIndex, kind: ind.kind };

      // Hide the main candle series when an indicator declares it replaces
      // candles (currently only Heikin-Ashi).
      if (ind.replacesCandles && this.mainSeries) {
        try { this.mainSeries.applyOptions({ visible: false }); } catch (_) {}
      }

      this._resizeOscPanes();
    }

    disable(id) {
      this._teardown(id);
      this._resizeOscPanes();
    }

    _teardown(id) {
      const s = this._state[id];
      if (!s) return;
      const ind = window.Indicators.get(id);
      for (const h of s.handles) {
        try { this.chart.removeSeries(h); } catch (_) {}
      }
      if (ind && ind.replacesCandles && this.mainSeries) {
        try { this.mainSeries.applyOptions({ visible: true }); } catch (_) {}
      }
      if (s.paneIndex > 0) this._releaseOscPane(s.paneIndex);
      delete this._state[id];
    }

    isEnabled(id) { return !!this._state[id]; }
    params(id)    { return this._state[id] ? Object.assign({}, this._state[id].params) : null; }

    getEnabledList() {
      return Object.keys(this._state).map(id => ({
        id, params: Object.assign({}, this._state[id].params),
      }));
    }

    setEnabledList(list) {
      for (const id of Object.keys(this._state)) this._teardown(id);
      this._oscPanes = [];
      for (const e of list || []) this.enable(e.id, e.params || {}, true);
    }

    /* -------------------------------------------------------- oscillator panes */

    _allocateOscPane() {
      // Find the first paneIndex >= 1 not currently in use, capped.
      for (let i = 1; i <= MAX_OSC_PANES; i++) {
        if (!this._oscPanes.includes(i)) {
          this._oscPanes.push(i);
          return i;
        }
      }
      return -1;
    }

    _releaseOscPane(idx) {
      const k = this._oscPanes.indexOf(idx);
      if (k >= 0) this._oscPanes.splice(k, 1);
    }

    _resizeOscPanes() {
      // Distribute height: main pane gets the bulk, oscillators share the rest.
      // LWC v5: chart.panes() returns an array of pane APIs. setStretchFactor
      // is the official way to balance heights — we give main 4x weight.
      try {
        const panes = this.chart.panes ? this.chart.panes() : [];
        if (!panes.length) return;
        for (let i = 0; i < panes.length; i++) {
          if (typeof panes[i].setStretchFactor === "function") {
            panes[i].setStretchFactor(i === 0 ? 4 : 1);
          }
        }
      } catch (_) { /* graceful */ }
    }

    /* --------------------------------------------------------------- destroy */

    destroy() {
      for (const id of Object.keys(this._state)) this._teardown(id);
      this._bars = [];
    }
  }

  window.IndicatorManager = IndicatorManager;
})();
