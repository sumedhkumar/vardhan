"""Flask entrypoint for Trading View Pro.

Serves the single-page frontend and a thin JSON API that delegates every
market-data request to the pluggable registry in :mod:`data_source`. There
are no authentication, rate-limit, or session concerns — this is a local
tool intended for ``python app.py`` on a developer's machine.
"""

from __future__ import annotations

import threading
import time

from flask import Flask, jsonify, render_template, request

import data_source
from data_source import SUPPORTED_INTERVALS
from symbol_index import INDEX as SYMBOL_INDEX


app = Flask(__name__, static_folder="static", template_folder="templates")


# ---------------------------------------------------------------------------
# Hyperliquid universe bootstrap (background thread, non-blocking)
# ---------------------------------------------------------------------------

_HL_REFRESH_SECS = 6 * 60 * 60  # 6h


def _refresh_hyperliquid_universe() -> None:
    """Pull the live coin list from Hyperliquid into the symbol index."""
    try:
        hl = data_source.get("hyperliquid")
    except KeyError:
        return
    rows = hl.fetch_meta() if hasattr(hl, "fetch_meta") else []
    if rows:
        SYMBOL_INDEX.set_dynamic("hyperliquid", rows)


def _hl_loop() -> None:
    # First pass runs immediately so the Hyperliquid universe is populated
    # within seconds of startup; subsequent passes refresh every 6h.
    while True:
        _refresh_hyperliquid_universe()
        time.sleep(_HL_REFRESH_SECS)


_BOOTSTRAPPED = False


def _bootstrap_once() -> None:
    """Idempotent first-time setup. Guarded against Flask reloader doubles."""
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED:
        return
    _BOOTSTRAPPED = True
    # Refresh runs entirely in the background so app.py imports stay snappy.
    # Until the first refresh lands, /api/symbols?source=hyperliquid serves
    # an empty list (the frontend falls back to typed-in symbols anyway).
    threading.Thread(target=_hl_loop, name="hl-meta-refresh", daemon=True).start()


_bootstrap_once()


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html", intervals=SUPPORTED_INTERVALS)


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------

@app.route("/api/sources")
def api_sources():
    """List registered sources + their datalist suggestions."""
    return jsonify({
        "sources": data_source.list_sources(),
        "intervals": list(SUPPORTED_INTERVALS),
    })


@app.route("/api/symbols")
def api_symbols():
    """Symbol search / catalog used by the frontend autocomplete.

    Query params:
        source (required): yfinance | hyperliquid | forex
        q (optional):      query string (empty -> top-N popular)
        limit (optional):  default 50, max 200
    """
    source = request.args.get("source", "").strip()
    query  = request.args.get("q", "").strip()
    try:
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    if not source:
        return jsonify({"error": "source is required"}), 400

    matches = SYMBOL_INDEX.search(source, query, limit=limit)
    return jsonify({"matches": matches})


@app.route("/api/history")
def api_history():
    """Seed bars for chart bootstrap.

    Query params: ``source``, ``symbol``, ``interval``, optional ``lookback``.
    """
    source = request.args.get("source", "").strip()
    symbol = request.args.get("symbol", "").strip()
    interval = request.args.get("interval", "").strip()
    try:
        lookback = int(request.args.get("lookback", "500"))
    except ValueError:
        lookback = 500

    if not source or not symbol or not interval:
        return jsonify({"error": "source, symbol, interval are required"}), 400
    if interval not in SUPPORTED_INTERVALS:
        return jsonify({"error": f"unsupported interval: {interval}"}), 400

    try:
        src = data_source.get(source)
    except KeyError:
        return jsonify({"error": f"unknown source: {source}"}), 404

    try:
        bars = src.history(symbol, interval, lookback)
    except Exception as exc:  # noqa: BLE001 — surface the message to the UI
        return jsonify({"error": str(exc)}), 502

    return jsonify({
        "source": source,
        "symbol": symbol,
        "interval": interval,
        "bars": [b.to_dict() for b in bars],
    })


@app.route("/api/quote")
def api_quote():
    """Latest bar — used by polling-based sources (e.g. yfinance)."""
    source = request.args.get("source", "").strip()
    symbol = request.args.get("symbol", "").strip()
    interval = request.args.get("interval", "").strip()

    if not source or not symbol or not interval:
        return jsonify({"error": "source, symbol, interval are required"}), 400
    if interval not in SUPPORTED_INTERVALS:
        return jsonify({"error": f"unsupported interval: {interval}"}), 400

    try:
        src = data_source.get(source)
    except KeyError:
        return jsonify({"error": f"unknown source: {source}"}), 404

    try:
        bar = src.quote(symbol, interval)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502

    return jsonify({
        "source": source,
        "symbol": symbol,
        "interval": interval,
        "bar": bar.to_dict() if bar else None,
    })


if __name__ == "__main__":
    # ``debug=False`` — yfinance's pickled cache plus Flask's reloader can
    # produce duplicate background threads; turn it on only if you need it.
    app.run(host="127.0.0.1", port=5000, debug=False)
