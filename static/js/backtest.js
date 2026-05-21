/* Backtesting engine — pure-JS, long-only, market-on-close fills.
 *
 * Walks the bar series, applies the strategy's signals, tracks a single
 * open position at a time, and produces:
 *   * trades:  list of {entryTime, entryPrice, exitTime, exitPrice, pnl, pnlPct}
 *   * equity:  list of {time, value}  (one point per bar)
 *   * stats:   {totalReturnPct, winRatePct, totalTrades, avgWinPct, avgLossPct,
 *              maxDrawdownPct, sharpe, profitFactor, expectancyPct}
 *
 * Assumptions documented in the README:
 *   - Entry & exit fills at the signal-bar's CLOSE price.
 *   - Single position, full capital deployed (sizing="full"), long only.
 *   - Fee + slippage applied in basis points (deducted from notional).
 */
(function () {
  "use strict";

  function backtest(bars, strategy, opts) {
    opts = opts || {};
    const capital  = opts.capital  != null ? opts.capital  : 100000;
    const feeBps   = opts.feeBps   != null ? opts.feeBps   : 5;
    const slipBps  = opts.slipBps  != null ? opts.slipBps  : 2;
    const costRate = (feeBps + slipBps) / 10000;

    if (!bars || bars.length < 2) {
      return { trades: [], equity: [], stats: emptyStats() };
    }

    const sigList = strategy.signals(bars, strategy.params || strategy.defaults || {});
    const signalsByTime = new Map();
    for (const s of sigList) signalsByTime.set(s.time, s.side);

    const trades = [];
    const equity = [];
    let cash = capital;
    let position = 0;             // units held (0 if flat)
    let entryPrice = 0;
    let entryTime = 0;
    let peakEquity = capital;
    let maxDD = 0;

    const dailyReturns = [];      // for Sharpe
    let prevValue = capital;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const sig = signalsByTime.get(b.time);

      // Entry: open a long position at this bar's close price.
      if (sig === "long" && position === 0) {
        const fillPrice = b.close * (1 + costRate);
        position   = cash / fillPrice;
        entryPrice = fillPrice;
        entryTime  = b.time;
        cash = 0;
      }
      // Exit: close out at this bar's close price.
      else if (sig === "exit" && position > 0) {
        const fillPrice = b.close * (1 - costRate);
        const proceeds  = position * fillPrice;
        const pnl       = proceeds - position * entryPrice;
        const pnlPct    = (fillPrice / entryPrice - 1) * 100;
        trades.push({
          entryTime, entryPrice,
          exitTime: b.time, exitPrice: fillPrice,
          pnl, pnlPct,
        });
        cash = proceeds;
        position = 0;
        entryPrice = 0;
      }

      const value = cash + position * b.close;
      equity.push({ time: b.time, value });

      // Drawdown bookkeeping.
      if (value > peakEquity) peakEquity = value;
      const dd = peakEquity ? (peakEquity - value) / peakEquity : 0;
      if (dd > maxDD) maxDD = dd;

      if (i > 0 && prevValue > 0) {
        dailyReturns.push((value - prevValue) / prevValue);
      }
      prevValue = value;
    }

    // Close any open position at the last bar so the equity curve is honest.
    if (position > 0) {
      const last = bars[bars.length - 1];
      const fillPrice = last.close * (1 - costRate);
      const proceeds = position * fillPrice;
      trades.push({
        entryTime, entryPrice,
        exitTime: last.time, exitPrice: fillPrice,
        pnl: proceeds - position * entryPrice,
        pnlPct: (fillPrice / entryPrice - 1) * 100,
        forcedExit: true,
      });
      cash = proceeds;
      position = 0;
    }

    return { trades, equity, stats: computeStats(trades, equity, capital, maxDD, dailyReturns) };
  }

  function computeStats(trades, equity, capital, maxDD, dailyReturns) {
    const finalEq = equity.length ? equity[equity.length - 1].value : capital;
    const totalReturnPct = capital ? (finalEq / capital - 1) * 100 : 0;

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const winRatePct = trades.length ? (wins.length / trades.length) * 100 : 0;
    const avgWinPct  = wins.length   ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length   : 0;
    const avgLossPct = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;

    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss   = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const profitFactor = grossLoss ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

    // Sharpe from equity returns (annualisation guess based on bars/year).
    let sharpe = 0;
    if (dailyReturns.length > 1) {
      const mean = dailyReturns.reduce((a, r) => a + r, 0) / dailyReturns.length;
      let variance = 0;
      for (const r of dailyReturns) variance += (r - mean) ** 2;
      variance /= dailyReturns.length;
      const sd = Math.sqrt(variance);
      // Annualisation factor: assume ~252 bars-per-year as a rough constant.
      // Strategies operating on intraday timeframes will report inflated
      // Sharpe — that's an inherent limitation of a single annualisation
      // factor and is documented in the README.
      sharpe = sd ? (mean / sd) * Math.sqrt(252) : 0;
    }

    const expectancyPct = trades.length
      ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length
      : 0;

    return {
      totalReturnPct,
      winRatePct,
      totalTrades: trades.length,
      avgWinPct,
      avgLossPct,
      maxDrawdownPct: maxDD * 100,
      sharpe,
      profitFactor,
      expectancyPct,
    };
  }

  function emptyStats() {
    return {
      totalReturnPct: 0, winRatePct: 0, totalTrades: 0,
      avgWinPct: 0, avgLossPct: 0, maxDrawdownPct: 0,
      sharpe: 0, profitFactor: 0, expectancyPct: 0,
    };
  }

  /** Convert trades into chart marker objects for a candlestick series. */
  function tradesToMarkers(trades) {
    const out = [];
    for (const t of trades) {
      out.push({
        time: t.entryTime,
        position: "belowBar",
        color: "#16c784",
        shape: "arrowUp",
        text: "BUY",
      });
      out.push({
        time: t.exitTime,
        position: "aboveBar",
        color: t.pnl >= 0 ? "#16c784" : "#ea3943",
        shape: "arrowDown",
        text: t.pnl >= 0 ? "SELL+" : "SELL−",
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  window.Backtest = { run: backtest, tradesToMarkers };
})();
