/* Hyperliquid websocket client (shared connection, multiplexed subs).
 *
 * One WebSocket to wss://api.hyperliquid.xyz/ws is shared across every
 * pane. Multiple panes asking for the same (symbol, interval) reuse a
 * single upstream subscription via a refcounted Map.
 *
 * Public API:
 *   HyperliquidClient.fetchHistory(symbol, interval, lookback) -> Promise<Bar[]>
 *   HyperliquidClient.subscribe({symbol, interval, onBar, onStatus}) -> {unsubscribe()}
 *   HyperliquidClient.onConnectionStatus(cb)  // for the toolbar pill
 */

(function () {
  "use strict";

  const WS_URL = "wss://api.hyperliquid.xyz/ws";
  const RECONNECT_MIN_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;

  let ws = null;
  let connectionState = "idle";   // idle | connecting | open | closed
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let connectionListeners = new Set();

  // key -> { coin, interval, refcount, subscribers: Set<callbacks> }
  const subs = new Map();
  const keyOf = (coin, interval) => `${coin.toUpperCase()}|${interval}`;

  function setConnectionState(state, detail) {
    connectionState = state;
    for (const cb of connectionListeners) {
      try { cb(state, detail); } catch (_) { /* ignore */ }
    }
  }

  function ensureSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return ws;
    }
    setConnectionState("connecting");
    ws = new WebSocket(WS_URL);

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      setConnectionState("open");
      // Re-subscribe to everything we had registered before the drop.
      for (const sub of subs.values()) {
        sendSubscribe(sub.coin, sub.interval);
      }
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch (_) { return; }

      // Hyperliquid candle channel: { channel: "candle", data: <candle> }
      if (msg && msg.channel === "candle" && msg.data) {
        const c = msg.data;
        const bar = {
          time: Math.floor(Number(c.t) / 1000),
          open: Number(c.o),
          high: Number(c.h),
          low: Number(c.l),
          close: Number(c.c),
          volume: Number(c.v || 0),
        };
        const k = keyOf(c.s || "", c.i || "");
        const entry = subs.get(k);
        if (!entry) return;
        for (const cb of entry.subscribers) {
          try { cb(bar); } catch (err) { console.error("HL subscriber error", err); }
        }
      }
    });

    ws.addEventListener("close", () => {
      setConnectionState("closed");
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // 'close' will follow; centralise reconnect logic there.
      try { ws && ws.close(); } catch (_) { /* ignore */ }
    });

    return ws;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (subs.size === 0) return;     // nothing to reconnect for
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      ensureSocket();
    }, reconnectDelay);
  }

  function sendSubscribe(coin, interval) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: { type: "candle", coin: coin.toUpperCase(), interval },
    }));
  }

  function sendUnsubscribe(coin, interval) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      method: "unsubscribe",
      subscription: { type: "candle", coin: coin.toUpperCase(), interval },
    }));
  }

  async function fetchHistory(symbol, interval, lookback = 500) {
    const url = `/api/history?source=hyperliquid` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&lookback=${lookback}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`history HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data.bars || [];
  }

  function subscribe({ symbol, interval, onBar, onStatus }) {
    const coin = (symbol || "").toUpperCase();
    const k = keyOf(coin, interval);

    let entry = subs.get(k);
    if (!entry) {
      entry = { coin, interval, subscribers: new Set() };
      subs.set(k, entry);
    }
    entry.subscribers.add(onBar);

    // Mirror the global connection state into the pane's status indicator.
    const onConn = (state) => {
      if (typeof onStatus !== "function") return;
      if (state === "open") onStatus("live");
      else if (state === "connecting" || state === "idle") onStatus("loading");
      else onStatus("error", "ws " + state);
    };
    connectionListeners.add(onConn);
    onConn(connectionState);

    ensureSocket();
    if (entry.subscribers.size === 1 && ws && ws.readyState === WebSocket.OPEN) {
      sendSubscribe(coin, interval);
    }

    return {
      unsubscribe() {
        connectionListeners.delete(onConn);
        const e = subs.get(k);
        if (!e) return;
        e.subscribers.delete(onBar);
        if (e.subscribers.size === 0) {
          subs.delete(k);
          sendUnsubscribe(coin, interval);
        }
      },
    };
  }

  function onConnectionStatus(cb) {
    connectionListeners.add(cb);
    cb(connectionState);
    return () => connectionListeners.delete(cb);
  }

  window.HyperliquidClient = { fetchHistory, subscribe, onConnectionStatus };
})();
