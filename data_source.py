"""Pluggable data-source registry.

This is the single seam through which the rest of the app gets market data.
To add a new broker (Alpaca, Binance, Zerodha, Polygon, ...) implement the
:class:`DataSource` protocol in a new file under ``sources/``, register it
with :func:`register`, then import it from ``sources/__init__.py`` so it
loads on startup.

A ``DataSource`` exposes two methods:

* ``history(symbol, interval, lookback)`` returns a list of historical OHLCV
  bars used to seed the chart.
* ``quote(symbol, interval)`` returns the latest bar for polling-based live
  updates (websocket sources can leave it as a no-op since live ticks flow
  through their own frontend client).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------

@dataclass
class Bar:
    """One OHLCV candle.

    ``time`` is a UNIX timestamp in **seconds**, aligned to the start of the
    bar's interval. Lightweight Charts expects this exact shape.
    """

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# Canonical interval set surfaced to the frontend. Sources translate these
# strings to whatever their upstream API expects.
SUPPORTED_INTERVALS = (
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h",
    "1d", "1w",
)


# ---------------------------------------------------------------------------
# Source protocol + registry
# ---------------------------------------------------------------------------

@runtime_checkable
class DataSource(Protocol):
    """Interface every broker implementation must satisfy."""

    name: str
    # Symbols pre-populated into the per-pane autocomplete datalist.
    suggested_symbols: list[str]

    def history(self, symbol: str, interval: str, lookback: int) -> list[Bar]:
        """Return up to ``lookback`` bars ending at "now"."""

    def quote(self, symbol: str, interval: str) -> Bar | None:
        """Return the most recent (possibly still-forming) bar, or ``None``."""


_REGISTRY: dict[str, DataSource] = {}


def register(source: DataSource) -> None:
    """Add (or replace) a source in the registry."""
    _REGISTRY[source.name] = source


def get(name: str) -> DataSource:
    """Look up a source by name. Raises ``KeyError`` if unknown."""
    if name not in _REGISTRY:
        raise KeyError(f"unknown data source: {name!r}")
    return _REGISTRY[name]


def list_sources() -> list[dict]:
    """Serialisable description of every registered source for the frontend."""
    return [
        {"name": src.name, "suggested_symbols": list(src.suggested_symbols)}
        for src in _REGISTRY.values()
    ]


# Importing the ``sources`` package registers the built-ins via side-effect.
# Done at the bottom so the protocol + ``register`` are defined before any
# source module tries to import them (avoids the circular-import trap).
import sources  # noqa: E402,F401
