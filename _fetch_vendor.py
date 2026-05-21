"""One-shot helper to download the Lightweight Charts standalone bundle.

Run once: ``python _fetch_vendor.py``. Safe to delete afterwards.
"""
import os
import sys
import urllib.request

URL = "https://unpkg.com/lightweight-charts@5.0.7/dist/lightweight-charts.standalone.production.js"
OUT = os.path.join("static", "vendor", "lightweight-charts.standalone.production.js")


def main() -> int:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    print(f"downloading {URL}")
    try:
        urllib.request.urlretrieve(URL, OUT)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    size = os.path.getsize(OUT)
    print(f"OK: wrote {size} bytes -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
