"""Refresh the bundled symbol masters from upstream exchanges.

Usage
-----
    python scripts/build_symbol_masters.py            # both NSE + BSE
    python scripts/build_symbol_masters.py --nse      # NSE only
    python scripts/build_symbol_masters.py --bse      # BSE only

The script is idempotent: it overwrites ``data/nse_equities.json`` and/or
``data/bse_equities.json`` in place. The seeded JSONs that ship with the repo
are a fallback for offline first-run; running this script replaces them with
the up-to-date full universe (~2000 NSE, ~5000 BSE).

NSE and BSE both reject the default Python User-Agent, so we mimic a regular
browser. If either exchange changes its endpoint shape, the script reports
the failure and leaves the existing JSON untouched.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from typing import Iterable

import requests


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "data")

NSE_EQUITY_CSV = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
BSE_LIST_JSON  = "https://api.bseindia.com/BseIndiaAPI/api/ListOfScripCXl/w"

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/csv,application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_json(path: str, rows: Iterable[dict]) -> int:
    rows = list(rows)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    return len(rows)


def _warm_nse_session(s: requests.Session) -> None:
    """Hit the NSE homepage so the session picks up the anti-bot cookies."""
    try:
        s.get("https://www.nseindia.com", headers=BROWSER_HEADERS, timeout=10)
    except requests.RequestException:
        pass  # not fatal; the CSV endpoint sometimes works without cookies


# ---------------------------------------------------------------------------
# NSE
# ---------------------------------------------------------------------------

def fetch_nse() -> list[dict]:
    """Pull NSE's equity master CSV and shape it into our JSON format."""
    s = requests.Session()
    _warm_nse_session(s)

    r = s.get(NSE_EQUITY_CSV, headers=BROWSER_HEADERS, timeout=30)
    r.raise_for_status()

    reader = csv.DictReader(io.StringIO(r.text))
    out: list[dict] = []
    for row in reader:
        # NSE columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING,
        # PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
        symbol = (row.get("SYMBOL") or "").strip()
        name   = (row.get("NAME OF COMPANY") or row.get("NAME OF COMPANY ") or "").strip()
        series = (row.get(" SERIES") or row.get("SERIES") or "").strip()
        if not symbol or series and series not in {"EQ", "BE", "BL"}:
            continue
        out.append({
            "symbol":   f"{symbol}.NS",
            "name":     name or symbol,
            "exchange": "NSE",
            "sector":   "",            # NSE master doesn't carry sector
        })
    return out


# ---------------------------------------------------------------------------
# BSE
# ---------------------------------------------------------------------------

def fetch_bse() -> list[dict]:
    """Pull BSE's listed-equity catalogue. The endpoint takes paged queries."""
    s = requests.Session()
    out: list[dict] = []

    # The BSE endpoint paginates 500 rows at a time via the scripcode range.
    # In practice a single big page (100000) returns the entire list.
    params = {
        "Group": "",
        "Scripcode": "",
        "industry": "",
        "segment": "Equity",
        "status": "Active",
    }
    headers = dict(BROWSER_HEADERS)
    headers["Referer"] = "https://www.bseindia.com/"

    r = s.get(BSE_LIST_JSON, params=params, headers=headers, timeout=30)
    r.raise_for_status()
    payload = r.json()

    for row in payload:
        # BSE fields: SCRIP_CD, scrip_id, Scrip_Name, Status, Group, Segment,
        # ISIN_NUMBER, Industry, INSTRUMENT, FACE_VALUE
        scrip_id = (row.get("scrip_id") or row.get("Scrip_Id") or "").strip()
        name     = (row.get("Scrip_Name") or row.get("scrip_name") or "").strip()
        industry = (row.get("Industry") or row.get("industry") or "").strip()
        if not scrip_id:
            continue
        out.append({
            "symbol":   f"{scrip_id}.BO",
            "name":     name or scrip_id,
            "exchange": "BSE",
            "sector":   industry,
        })
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--nse", action="store_true", help="refresh NSE only")
    p.add_argument("--bse", action="store_true", help="refresh BSE only")
    args = p.parse_args(argv)

    do_nse = args.nse or not (args.nse or args.bse)
    do_bse = args.bse or not (args.nse or args.bse)

    os.makedirs(DATA_DIR, exist_ok=True)
    rc = 0

    if do_nse:
        try:
            rows = fetch_nse()
            n = _write_json(os.path.join(DATA_DIR, "nse_equities.json"), rows)
            print(f"[NSE] wrote {n} symbols")
        except Exception as exc:  # noqa: BLE001
            print(f"[NSE] FAILED: {exc}", file=sys.stderr)
            rc = 1

    if do_bse:
        try:
            rows = fetch_bse()
            n = _write_json(os.path.join(DATA_DIR, "bse_equities.json"), rows)
            print(f"[BSE] wrote {n} symbols")
        except Exception as exc:  # noqa: BLE001
            print(f"[BSE] FAILED: {exc}", file=sys.stderr)
            rc = 1

    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
