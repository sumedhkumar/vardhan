"""Hyperliquid data source — REST history only.

Live ticks come over a websocket that the **browser** connects to directly
(see ``static/js/hyperliquid.js``). This module exists so that initial chart
seeding goes through the same ``/api/history`` endpoint as every other
source, which keeps the data_source.py abstraction clean.

Hyperliquid public market endpoints require no API key.
"""

from __future__ import annotations

import time
from typing import Optional

import requests

from data_source import Bar, register


_INFO_URL = "https://api.hyperliquid.xyz/info"

# Hyperliquid supports all our canonical intervals natively.
_INTERVAL_MS: dict[str, int] = {
    "1m":  60_000,
    "3m":  3 * 60_000,
    "5m":  5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h":  60 * 60_000,
    "2h":  2 * 60 * 60_000,
    "4h":  4 * 60 * 60_000,
    "1d":  24 * 60 * 60_000,
    "1w":  7 * 24 * 60 * 60_000,
}


def _candle_to_bar(c: dict) -> Bar:
    # Hyperliquid candle payload uses string-encoded floats. Field names:
    # t (start ms), T (end ms), s (coin), i (interval), o, c, h, l, v, n.
    return Bar(
        time=int(c["t"]) // 1000,
        open=float(c["o"]),
        high=float(c["h"]),
        low=float(c["l"]),
        close=float(c["c"]),
        volume=float(c.get("v", 0.0) or 0.0),
    )


class HyperliquidSource:
    name = "hyperliquid"
    # Fallback only — the live coin universe is fetched via :meth:`fetch_meta`
    # at Flask startup and pushed into ``symbol_index.INDEX``.
    suggested_symbols = [
        "BTC", "ETH", "SOL", "HYPE", "ARB", "AVAX", "BNB", "DOGE",
        "SUI", "APT", "OP", "MATIC", "LINK", "TIA", "INJ", "NEAR",
        "LTC", "XRP",
    ]

    def fetch_meta(self) -> list[dict]:
        """Pull every available perp from Hyperliquid's ``meta`` endpoint.

        Returns the rows in the format the symbol index expects:
        ``[{symbol, name, exchange:'Hyperliquid'}, ...]``.
        Returns an empty list on network failure (callers fall back to the
        hardcoded ``suggested_symbols``).
        """
        try:
            r = requests.post(_INFO_URL, json={"type": "meta"}, timeout=10)
            r.raise_for_status()
            data = r.json() or {}
        except (requests.RequestException, ValueError):
            return []
        universe = data.get("universe") or []
        out: list[dict] = []
        for row in universe:
            name = (row.get("name") or "").strip()
            if not name:
                continue
            out.append({
                "symbol":   name,
                "name":     f"{name} perp",
                "exchange": "Hyperliquid",
                "sector":   "Perp",
            })
        out.sort(key=lambda r: r["symbol"])
        return out

    def history(self, symbol: str, interval: str, lookback: int) -> list[Bar]:
        if interval not in _INTERVAL_MS:
            raise ValueError(f"unsupported interval: {interval}")
        # Default to ~500 bars if caller didn't specify a useful number.
        bars = max(50, min(lookback or 500, 5000))
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - bars * _INTERVAL_MS[interval]

        payload = {
            "type": "candleSnapshot",
            "req": {
                "coin": symbol.upper(),
                "interval": interval,
                "startTime": start_ms,
                "endTime": end_ms,
            },
        }
        try:
            r = requests.post(_INFO_URL, json=payload, timeout=10)
            r.raise_for_status()
            data = r.json() or []
        except requests.RequestException:
            return []

        out = [_candle_to_bar(c) for c in data if isinstance(c, dict)]
        out.sort(key=lambda b: b.time)
        return out

    def quote(self, symbol: str, interval: str) -> Bar | None:
        # The websocket carries live ticks; we only need a fallback for the
        # rare case the frontend asks via /api/quote (e.g. before WS connects).
        bars = self.history(symbol, interval, lookback=2)
        return bars[-1] if bars else None


register(HyperliquidSource())
