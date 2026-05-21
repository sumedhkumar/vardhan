"""yfinance-backed data source for Indian stocks and indices.

Lives behind the Flask backend because yfinance is a Python library with no
browser equivalent. Live updates are polling-based: the frontend calls
``/api/quote`` on a timer (5 s by default) and the route delegates here.

yfinance does not natively support every interval we want to expose. The
mapping below translates our canonical strings into the closest native
yfinance ``interval`` and, when needed, a pandas ``resample`` rule so we can
synthesise ``3m``, ``2h`` and ``4h`` bars from finer-grained data.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd
import yfinance as yf

from data_source import Bar, register


# canonical -> (native yf interval, optional pandas resample rule)
_INTERVAL_MAP: dict[str, tuple[str, Optional[str]]] = {
    "1m":  ("1m",  None),
    "3m":  ("1m",  "3min"),     # synthesise from 1m
    "5m":  ("5m",  None),
    "15m": ("15m", None),
    "30m": ("30m", None),
    "1h":  ("60m", None),
    "2h":  ("60m", "2h"),       # synthesise from 1h
    "4h":  ("60m", "4h"),       # synthesise from 1h
    "1d":  ("1d",  None),
    "1w":  ("1wk", None),
}

# yfinance enforces a max ``period`` per interval. These are conservative
# choices that stay inside the documented limits.
_PERIOD_FOR: dict[str, str] = {
    "1m":  "5d",     # yf caps 1m at 7 days
    "3m":  "5d",
    "5m":  "30d",    # yf caps <1d intervals at 60d
    "15m": "60d",
    "30m": "60d",
    "1h":  "60d",    # 60m interval capped at 730d but 60d keeps payload small
    "2h":  "60d",
    "4h":  "60d",
    "1d":  "2y",
    "1w":  "5y",
}


def _df_to_bars(df: pd.DataFrame) -> list[Bar]:
    """Convert a yfinance OHLCV DataFrame into a list of :class:`Bar`."""
    if df is None or df.empty:
        return []

    # yfinance returns a tz-aware DatetimeIndex; convert to UTC seconds.
    idx = df.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("UTC")
    else:
        idx = idx.tz_localize("UTC")

    out: list[Bar] = []
    for ts, row in zip(idx, df.itertuples(index=False)):
        # row fields: Open, High, Low, Close, Volume (plus extras we ignore)
        o, h, l, c = row.Open, row.High, row.Low, row.Close
        if pd.isna(o) or pd.isna(c):
            continue
        v = getattr(row, "Volume", 0.0)
        out.append(Bar(
            time=int(ts.timestamp()),
            open=float(o),
            high=float(h),
            low=float(l),
            close=float(c),
            volume=float(v) if not pd.isna(v) else 0.0,
        ))
    return out


def _fetch_native(symbol: str, native_interval: str, period: str) -> pd.DataFrame:
    """Pull a raw OHLCV frame from yfinance."""
    tkr = yf.Ticker(symbol)
    df = tkr.history(period=period, interval=native_interval, auto_adjust=False)
    if df is None or df.empty:
        return pd.DataFrame()
    # Normalise column names (yfinance sometimes returns "Adj Close" too).
    cols = [c for c in ("Open", "High", "Low", "Close", "Volume") if c in df.columns]
    return df[cols].dropna(subset=["Open", "Close"])


def _resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample a 1m/1h frame into the target rule with proper OHLCV agg."""
    if df.empty:
        return df
    agg = {
        "Open":   "first",
        "High":   "max",
        "Low":    "min",
        "Close":  "last",
        "Volume": "sum",
    }
    out = df.resample(rule, label="left", closed="left").agg(agg)
    return out.dropna(subset=["Open", "Close"])


class YFinanceSource:
    name = "yfinance"
    suggested_symbols = [
        "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
        "SBIN.NS", "ITC.NS", "LT.NS", "AXISBANK.NS", "BHARTIARTL.NS",
        "ADANIENT.NS", "TATAMOTORS.NS", "MARUTI.NS", "WIPRO.NS", "HCLTECH.NS",
        "^NSEI", "^BSESN", "^NSEBANK",
    ]

    def _frame_for(self, symbol: str, interval: str) -> pd.DataFrame:
        if interval not in _INTERVAL_MAP:
            raise ValueError(f"unsupported interval: {interval}")
        native, rule = _INTERVAL_MAP[interval]
        period = _PERIOD_FOR[interval]
        df = _fetch_native(symbol, native, period)
        if rule:
            df = _resample(df, rule)
        return df

    def history(self, symbol: str, interval: str, lookback: int) -> list[Bar]:
        df = self._frame_for(symbol, interval)
        if df.empty:
            return []
        if lookback and len(df) > lookback:
            df = df.iloc[-lookback:]
        return _df_to_bars(df)

    def quote(self, symbol: str, interval: str) -> Bar | None:
        # Pull a small recent window so we always have a valid "last bar".
        # Two bars give us a safety margin for resampling boundary effects.
        df = self._frame_for(symbol, interval)
        if df.empty:
            return None
        return _df_to_bars(df.iloc[-1:])[0] if len(df) else None


register(YFinanceSource())
