import json, sys, traceback
out = {"step": "start"}
try:
    out["step"] = "import app"
    import app
    out["sources"]   = sorted(app.data_source._REGISTRY.keys())
    out["sym_keys"]  = sorted(app.SYMBOL_INDEX._records.keys())
    out["yf_count"]  = len(app.SYMBOL_INDEX._records.get("yfinance", []))
    out["fx_count"]  = len(app.SYMBOL_INDEX._records.get("forex", []))
    out["hl_count"]  = len(app.SYMBOL_INDEX._records.get("hyperliquid", []))
    out["ok"] = True
except Exception:
    out["ok"] = False
    out["traceback"] = traceback.format_exc()
with open("_smoke.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, default=str)
sys.exit(0 if out.get("ok") else 1)
