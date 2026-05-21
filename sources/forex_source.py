"""Forex source — thin wrapper that delegates OHLCV to yfinance.

Yahoo exposes forex via the ``XXXYYY=X`` ticker convention (e.g.
``EURUSD=X``, ``USDINR=X``). The mechanics are identical to equities, so
this class just calls the existing yfinance machinery. The reason it
exists as a separate ``DataSource`` is purely UX: it gives the frontend a
distinct "Forex" entry in the source dropdown with its own symbol catalog.
"""

from __future__ import annotations

from data_source import Bar, register
from sources.yfinance_source import YFinanceSource


class ForexSource:
    name = "forex"
    # Suggested symbols are surfaced via symbol_index.py's forex_pairs.json
    # bundle; this list is the small fallback used if that file is missing.
    suggested_symbols = ["EURUSD=X", "USDJPY=X", "GBPUSD=X", "USDINR=X"]

    def __init__(self) -> None:
        # Reuse the yfinance source for the actual fetching logic.
        self._yf = YFinanceSource()

    def history(self, symbol: str, interval: str, lookback: int) -> list[Bar]:
        return self._yf.history(symbol, interval, lookback)

    def quote(self, symbol: str, interval: str) -> Bar | None:
        return self._yf.quote(symbol, interval)


register(ForexSource())
