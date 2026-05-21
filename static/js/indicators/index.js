/* Indicator registry — surfaces ordered metadata for the UI popover.
 *
 * The actual indicator implementations live in ``overlays.js`` and
 * ``oscillators.js`` and self-register into ``window.IndicatorRegistry``.
 * This file just decides their display order + groups them.
 */
(function () {
  "use strict";

  const ORDER_OVERLAYS = [
    "ema", "sma", "bb", "vwap", "donchian", "keltner",
    "ichimoku", "supertrend", "linreg", "pivot", "fib", "heikin",
  ];
  const ORDER_OSCILLATORS = [
    "volume", "rsi", "macd", "stoch", "adx", "atr",
    "obv", "cci", "willr", "roc", "mfi",
  ];

  function listGroup(ids) {
    const out = [];
    for (const id of ids) {
      const ind = window.IndicatorRegistry[id];
      if (ind) out.push(ind);
    }
    return out;
  }

  window.Indicators = {
    overlays:    () => listGroup(ORDER_OVERLAYS),
    oscillators: () => listGroup(ORDER_OSCILLATORS),
    get(id)      { return window.IndicatorRegistry[id] || null; },
    all()        { return [...this.overlays(), ...this.oscillators()]; },
  };
})();
