"""In-process symbol search index.

Loads the bundled JSON masters from ``data/`` once at startup and exposes
:meth:`SymbolIndex.search` for the ``/api/symbols`` Flask endpoint. Built on
``rapidfuzz`` for fast substring + prefix scoring; falls back to a pure-Python
matcher if rapidfuzz is missing.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Iterable

try:
    from rapidfuzz import fuzz
    _HAVE_RAPIDFUZZ = True
except ImportError:                                        # pragma: no cover
    _HAVE_RAPIDFUZZ = False


_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR  = os.path.join(_REPO_ROOT, "data")


# Map ``source`` (as exposed to the frontend) -> list of JSON files to load
# and concatenate.
_SOURCE_FILES: dict[str, list[str]] = {
    # yfinance covers Indian equities + indices (all .NS/.BO/^ symbols)
    "yfinance":   ["nse_equities.json", "bse_equities.json", "indices_in.json"],
    "forex":      ["forex_pairs.json"],
    # hyperliquid is populated dynamically from the live meta endpoint, not
    # from a bundled JSON; see set_dynamic() below.
    "hyperliquid": [],
}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _score(query: str, symbol: str, name: str) -> int:
    """Return a 0-100 relevance score. Higher is better."""
    q = query.lower()
    s = symbol.lower()
    n = (name or "").lower()

    # Exact symbol match wins outright.
    if s == q or s.split(".")[0] == q:
        return 100
    # Symbol prefix match is the next-best signal.
    if s.startswith(q):
        return 95
    if any(part.startswith(q) for part in s.split(".")):
        return 92
    # Word-prefix on the company name.
    if any(w.startswith(q) for w in n.split()):
        return 85
    # Substring match on either field.
    if q in s:
        return 75
    if q in n:
        return 65
    # Fall back to fuzzy partial-ratio against the name.
    if _HAVE_RAPIDFUZZ and len(q) >= 3:
        f = int(fuzz.partial_ratio(q, n))   # 0..100
        if f >= 75:
            return f - 20                   # cap below substring matches
    return 0


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

class SymbolIndex:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._catalogs: dict[str, list[dict]] = {}
        self.reload()

    def reload(self) -> None:
        """Re-read all JSON files from disk into memory."""
        with self._lock:
            self._catalogs = {}
            for source, files in _SOURCE_FILES.items():
                rows: list[dict] = []
                for fname in files:
                    path = os.path.join(_DATA_DIR, fname)
                    if not os.path.isfile(path):
                        continue
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            rows.extend(json.load(f))
                    except (json.JSONDecodeError, OSError):
                        continue
                # de-dupe by symbol while preserving first-seen order
                seen: set[str] = set()
                deduped: list[dict] = []
                for r in rows:
                    sym = r.get("symbol")
                    if not sym or sym in seen:
                        continue
                    seen.add(sym)
                    deduped.append(r)
                self._catalogs[source] = deduped

    def set_dynamic(self, source: str, rows: Iterable[dict]) -> None:
        """Replace a source's catalog with a dynamically-fetched list.

        Used by the Hyperliquid bootstrap (which calls /info meta on startup).
        """
        with self._lock:
            self._catalogs[source] = list(rows)

    def all(self, source: str) -> list[dict]:
        with self._lock:
            return list(self._catalogs.get(source, ()))

    def search(self, source: str, query: str, limit: int = 50) -> list[dict]:
        query = (query or "").strip()
        with self._lock:
            rows = self._catalogs.get(source, ())
            if not query:
                # Stable, deterministic "popular first" ordering: rely on the
                # bundled JSON order (curated by index of importance).
                return list(rows[:limit])

            scored: list[tuple[int, dict]] = []
            for row in rows:
                s = _score(query, row.get("symbol", ""), row.get("name", ""))
                if s > 0:
                    scored.append((s, row))
            scored.sort(key=lambda t: (-t[0], t[1].get("symbol", "")))
            return [r for _, r in scored[:limit]]


# A single process-wide instance, lazily reloaded on demand.
INDEX = SymbolIndex()
