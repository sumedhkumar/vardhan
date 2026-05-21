/* yfinance / forex polling client.
 *
 * Yahoo (and our forex wrapper around it) has no public websocket, so live
 * updates are emulated by polling /api/quote on a timer. Each pane gets its
 * own subscription handle which fans incoming bars into onBar.
 *
 * The ``source`` argument distinguishes the Flask-side data source — it's
 * either ``"yfinance"`` or ``"forex"``. Both flow through this client
 * because the on-the-wire shape is identical.
 */

(function () {
  "use strict";

  const POLL_MS = 5_000;
  const BACKOFF_MAX_MS = 30_000;

  function _src(s) { return s === "forex" ? "forex" : "yfinance"; }

  async function fetchHistory(symbol, interval, lookback = 500, source = "yfinance") {
    const url = `/api/history?source=${_src(source)}` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&lookback=${lookback}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`history HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data.bars || [];
  }

  async function fetchQuote(symbol, interval, source = "yfinance") {
    const url = `/api/quote?source=${_src(source)}` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`quote HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data.bar || null;
  }

  function subscribe({ symbol, interval, source, onBar, onStatus }) {
    let cancelled = false;
    let timer = null;
    let backoff = POLL_MS;

    const setStatus = (s, detail) => {
      if (typeof onStatus === "function") onStatus(s, detail);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const bar = await fetchQuote(symbol, interval, source);
        if (cancelled) return;
        if (bar) {
          onBar(bar);
          setStatus("live");
          backoff = POLL_MS;             // reset on success
        }
      } catch (err) {
        if (cancelled) return;
        setStatus("error", err.message);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, backoff);
        }
      }
    };

    // First quote fires immediately so the UI doesn't sit idle for 5 s.
    timer = setTimeout(tick, 0);

    return {
      unsubscribe() {
        cancelled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }

  window.YFinanceClient = { fetchHistory, subscribe };
})();
