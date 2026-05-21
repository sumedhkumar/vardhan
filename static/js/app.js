/* App bootstrap — grid layout, persistence, pane lifecycle. */

(function () {
  "use strict";

  // Persistence schema version. Bump when the shape of pane state changes
  // in a way older saved blobs can't be safely consumed.
  const SCHEMA_VERSION = 2;
  const COUNT_KEY      = "tvpro:pane_count";
  const SCHEMA_KEY     = "tvpro:schema_version";
  const PANE_KEY       = (i) => `tvpro:pane_${i}`;
  const VALID_COUNTS   = [1, 2, 4, 6, 8];

  // First-run defaults: 2 crypto, 1 Indian equity, 1 Indian index, 1 forex,
  // and a couple of additional Indian large-caps to fill 8-pane layouts.
  const DEFAULT_LAYOUT = [
    { source: "hyperliquid", symbol: "BTC",          interval: "5m"  },
    { source: "hyperliquid", symbol: "ETH",          interval: "5m"  },
    { source: "yfinance",    symbol: "RELIANCE.NS",  interval: "15m" },
    { source: "yfinance",    symbol: "^NSEI",        interval: "15m" },
    { source: "forex",       symbol: "EURUSD=X",     interval: "15m" },
    { source: "hyperliquid", symbol: "SOL",          interval: "15m" },
    { source: "yfinance",    symbol: "TCS.NS",       interval: "1h"  },
    { source: "yfinance",    symbol: "INFY.NS",      interval: "1h"  },
  ];

  const grid    = document.getElementById("grid");
  const segRoot = document.getElementById("pane-count");
  const connEl  = document.getElementById("hl-conn-status");
  const connLbl = connEl.querySelector(".conn-pill__label");

  /** @type {import('./pane.js').Pane[]} */
  const panes = [];

  /* ------------------------------------------------------------ persistence */

  function loadCount() {
    const raw = parseInt(localStorage.getItem(COUNT_KEY) || "", 10);
    return VALID_COUNTS.includes(raw) ? raw : 4;
  }
  function saveCount(n) { localStorage.setItem(COUNT_KEY, String(n)); }

  function ensureSchema() {
    // If the saved schema version is older than the current one, blow away
    // every pane_* blob so the bootstrapper falls back to DEFAULT_LAYOUT.
    // This keeps the migration story trivial ("we'll redo your defaults").
    const stored = parseInt(localStorage.getItem(SCHEMA_KEY) || "0", 10);
    if (stored !== SCHEMA_VERSION) {
      for (let i = 0; i < 16; i++) localStorage.removeItem(PANE_KEY(i));
      localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
    }
  }

  function loadPaneState(i) {
    try {
      const raw = localStorage.getItem(PANE_KEY(i));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const { source, symbol, interval } = parsed;
      if (!source || !symbol || !interval) return null;
      // indicators + backtest are optional — the Pane fills sensible defaults.
      return parsed;
    } catch (_) {
      return null;
    }
  }
  function savePaneState(i, state) {
    localStorage.setItem(PANE_KEY(i), JSON.stringify(state));
  }

  /* --------------------------------------------------------- pane lifecycle */

  function createPane(i) {
    const persisted = loadPaneState(i);
    const state = persisted || DEFAULT_LAYOUT[i % DEFAULT_LAYOUT.length];
    const pane = new window.Pane(grid, {
      state,
      onStateChange: (s) => savePaneState(i, s),
    });
    panes.push(pane);
    // Persist the initial state so reload-from-default survives a refresh.
    savePaneState(i, pane.state);
  }

  function setPaneCount(n) {
    if (!VALID_COUNTS.includes(n)) n = 4;
    grid.dataset.count = String(n);

    // shrink — destroy from the end
    while (panes.length > n) {
      const p = panes.pop();
      p.destroy();
    }
    // grow — append new panes
    while (panes.length < n) {
      createPane(panes.length);
    }

    saveCount(n);
    syncSegmented(n);

    // After a layout change, the grid cells get new dimensions; re-measure.
    requestAnimationFrame(() => panes.forEach((p) => p.resize()));
  }

  function syncSegmented(n) {
    for (const btn of segRoot.querySelectorAll(".seg__btn")) {
      const c = parseInt(btn.dataset.count, 10);
      btn.setAttribute("aria-checked", c === n ? "true" : "false");
    }
  }

  /* ---------------------------------------------------- toolbar interactions */

  segRoot.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".seg__btn");
    if (!btn) return;
    const c = parseInt(btn.dataset.count, 10);
    if (VALID_COUNTS.includes(c)) setPaneCount(c);
  });

  /* --------------------------------------------------- connection indicator */

  function setConnPill(state) {
    connEl.dataset.status = state;
    const map = {
      idle:       "Hyperliquid: idle",
      connecting: "Hyperliquid: connecting…",
      open:       "Hyperliquid: live",
      closed:     "Hyperliquid: reconnecting…",
    };
    connLbl.textContent = map[state] || `Hyperliquid: ${state}`;
  }
  if (window.HyperliquidClient && window.HyperliquidClient.onConnectionStatus) {
    window.HyperliquidClient.onConnectionStatus(setConnPill);
  }

  /* ------------------------------------------------------ resize observation */

  // One ResizeObserver feeds all pane.resize() calls — cheaper than per-pane.
  const ro = new ResizeObserver(() => {
    for (const p of panes) p.resize();
  });
  ro.observe(grid);
  window.addEventListener("resize", () => panes.forEach((p) => p.resize()));

  /* --------------------------------------------------------------- bootstrap */

  // Lightweight Charts may load asynchronously when the local vendor file
  // is missing and the CDN fallback kicks in. Wait until the global is
  // present before constructing any panes.
  function whenLwcReady(cb) {
    if (window.LightweightCharts && window.LightweightCharts.createChart) {
      cb();
      return;
    }
    let waited = 0;
    const t = setInterval(() => {
      waited += 50;
      if (window.LightweightCharts && window.LightweightCharts.createChart) {
        clearInterval(t);
        cb();
      } else if (waited > 15_000) {
        clearInterval(t);
        console.error("Lightweight Charts failed to load (local + CDN).");
      }
    }, 50);
  }

  ensureSchema();
  whenLwcReady(() => setPaneCount(loadCount()));
})();
