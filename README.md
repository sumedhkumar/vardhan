# Trading View Pro

A local-only multi-pane live charting dashboard built on
[Lightweight Charts](https://www.tradingview.com/lightweight-charts/), Flask,
yfinance, and Hyperliquid's public websocket.

- **1, 2, 4, 6, or 8** independently configurable panes in a responsive grid.
- **Per-pane source / symbol / timeframe** controls; pane state and grid count
  persist across reloads via `localStorage`.
- **Hyperliquid websocket** (browser-direct) for live crypto candles.
- **yfinance** (Flask-bridged, 5 s polling) for live Indian stocks/indices.
- **Pluggable** — add a new broker by implementing one class in `sources/`.
- No API keys, no database, no deployment story. `python app.py` and you're live.

## Quick start

```cmd
:: 1. Install Python deps (Python 3.10+ recommended)
pip install -r requirements.txt

:: 2. (optional) Vendor Lightweight Charts for fully offline operation
python _fetch_vendor.py

:: 3. Run
python app.py

:: 4. Open
start http://127.0.0.1:5000
```

If you skip step 2, the page falls back to loading Lightweight Charts from
unpkg's public CDN. Either way the rest of the app runs locally.

## Using the dashboard

- **Number of charts** — pick `1 / 2 / 4 / 6 / 8` from the toolbar. The grid
  reshuffles into the cleanest layout for that count and remembers your choice.
- **Per-pane controls** — each pane has its own *Source · Symbol · Timeframe*
  row. Type any symbol (autocomplete suggestions are provided), press
  <kbd>Enter</kbd> or click away to commit.
- **Ticker bar** — flashes green/red on every price tick and shows session
  change (vs. the first historical bar loaded for that pane).
- **Refresh** (⟳) — re-pulls history for that pane without touching the others.

### Defaults on first load

4 panes: BTC + ETH (Hyperliquid 5m) and RELIANCE.NS + ^NSEI (yfinance 15m).

## Project layout

```
trading_view_pro/
├── app.py                       # Flask entrypoint (serves UI + JSON API)
├── data_source.py               # Pluggable broker registry
├── sources/
│   ├── __init__.py              # Imports & registers built-ins
│   ├── yfinance_source.py       # Indian stocks via yfinance (poll-based)
│   └── hyperliquid_source.py    # Crypto history via REST (live in browser)
├── static/
│   ├── css/styles.css
│   ├── js/
│   │   ├── app.js               # Grid layout, persistence, lifecycle
│   │   ├── pane.js              # One pane: chart + ticker + controls
│   │   ├── hyperliquid.js       # Shared WS multiplexer
│   │   └── yfinance.js          # Polling client against Flask
│   └── vendor/                  # (created by _fetch_vendor.py)
├── templates/index.html
├── requirements.txt
└── _fetch_vendor.py             # One-shot helper, safe to delete
```

## How live updates flow

```
                     ┌──────────────────┐
   Hyperliquid WS ───►   browser pane   ◄─── Lightweight Charts series.update(bar)
   (wss://api.        │  hyperliquid.js │
    hyperliquid.xyz)  └──────────────────┘
                     ┌──────────────────┐
                     │  Flask /api/...  │
   yfinance Python ──►  app.py          ◄── browser polls every 5 s
                     │  data_source.py  │
                     └──────────────────┘
```

Hyperliquid panes share **one** websocket connection across the whole page;
multiple panes on the same `(symbol, interval)` reuse a single upstream
subscription via a refcounted map.

## Adding a new broker (Alpaca, Binance, Zerodha, Polygon, …)

The single seam is `data_source.py`. Implementing a new source means
implementing one class with two methods, then registering it.

### 1. Create `sources/my_broker_source.py`

```python
from data_source import Bar, register


class MyBrokerSource:
    name = "mybroker"
    suggested_symbols = ["AAPL", "MSFT", "TSLA"]   # datalist hints

    def history(self, symbol: str, interval: str, lookback: int) -> list[Bar]:
        # Hit your broker's REST API, return a list of Bar(time, o, h, l, c, v).
        # ``time`` is UNIX seconds at the bar's open.
        ...

    def quote(self, symbol: str, interval: str) -> Bar | None:
        # Latest bar — used for poll-based live updates. Return None if no data.
        ...


register(MyBrokerSource())
```

### 2. Wire it into the registry

```python
# sources/__init__.py
from . import yfinance_source       # noqa: F401
from . import hyperliquid_source    # noqa: F401
from . import my_broker_source      # noqa: F401   <-- add this line
```

That's it. The new source automatically:

- Appears in `/api/sources` (and therefore in every pane's *Source* dropdown,
  because the dropdown is currently hardcoded — see the note below).
- Becomes selectable as `?source=mybroker` on `/api/history` and `/api/quote`.
- Gets a `<datalist id="symbols-mybroker">` populated from `suggested_symbols`.

> **Note:** the *Source* `<select>` in `templates/index.html` lists
> `hyperliquid` and `yfinance` explicitly. If you add a new source you'll
> want to add an `<option value="mybroker">My Broker</option>` there too.
> If you'd like that to auto-populate from `/api/sources`, it's a ~10 line
> tweak in `static/js/app.js` — left manual on purpose so the default UX
> stays predictable.

### 3. Live updates

If your broker exposes a websocket and you want true push updates (no 5 s
polling), add a small JS client mirroring `static/js/hyperliquid.js` and
swap on `state.source` inside `pane.js → _reload()`. If polling is fine,
no frontend changes are needed — the existing yfinance polling code path
will work the moment your `quote()` method returns a `Bar`.

## Caveats

- **yfinance Indian-stock latency.** yfinance free-tier data for NSE/BSE has
  a delay (typically ~15 minutes). The dashboard reflects what yfinance
  returns; for true real-time NSE you'd plug in a Zerodha/Kite source.
- **yfinance 1m history** is capped at ~7 days by upstream. The pane just
  shows what's available for that window.
- **Symbol case.** Hyperliquid coins are uppercase (`BTC`, `ETH`, `HYPE`).
  yfinance Indian tickers use the `.NS` (NSE) or `.BO` (BSE) suffix
  (`RELIANCE.NS`, `^NSEI`, etc.).
- **No order execution.** Display only.

## License

Personal project — do whatever you like with it.
