// SMT (Smart Money Technique) divergence detection.
//
// Concept: correlated assets (NQ / ES / YM index futures) usually make swing
// highs and lows together. When they DON'T — one makes a higher high while the
// other makes a lower high, for instance — that's an "SMT divergence" and
// suggests the move on the stronger asset is likely to fail.
//
// This module finds swing points on two candle series and returns the pairs of
// adjacent swings on the main series that diverge from the correlate.

const SWING_WINDOW = 3;   // a candle is a swing if it's the extreme within ±3
const DEFAULT_TIME_DIFF = 60;

function swingMatchTolerance(...series) {
  const deltas = [];
  for (const candles of series) {
    for (let i = 1; i < candles.length; i++) {
      const delta = candles[i].time - candles[i - 1].time;
      if (delta > 0) deltas.push(delta);
    }
  }
  if (!deltas.length) return DEFAULT_TIME_DIFF;
  deltas.sort((a, b) => a - b);
  const cadence = deltas[Math.floor(deltas.length / 2)];
  // Permit small timestamp differences, but don't match a minute pivot to a
  // different swing many hours away just because it is the nearest available.
  return Math.max(DEFAULT_TIME_DIFF, cadence * 3);
}

/** Return {highs, lows} — arrays of {time, price} for the extreme points. */
export function findSwings(candles, window = SWING_WINDOW, confirmationWindow = window) {
  const highs = [];
  const lows = [];
  const n = candles.length;
  for (let i = window; i < n - confirmationWindow; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + confirmationWindow && (isHigh || isLow); j++) {
      if (j === i) continue;
      const other = candles[j];
      if (other.high >= c.high) isHigh = false;
      if (other.low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ time: c.time, price: c.high });
    if (isLow) lows.push({ time: c.time, price: c.low });
  }
  return { highs, lows };
}

function findClosest(list, targetTime, tolerance = DEFAULT_TIME_DIFF) {
  let best = null;
  let bestDiff = Infinity;
  for (const s of list) {
    const diff = Math.abs(s.time - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return bestDiff <= tolerance ? best : null;
}

/**
 * Compare last-N swings of `main` against `correlate`. Return the pairs where
 * the two disagree on direction: main made a higher high but correlate made a
 * lower high (or same-price), etc. Only the MOST RECENT pair per kind is
 * returned — clutter control.
 *
 * Returns array of {
 *   kind: "highs" | "lows",
 *   direction: "bearish" | "bullish",  // trader-facing name
 *   p1, p2: {time, price} on MAIN symbol — draw a segment between these
 * }
 */
export function detectDivergences(mainCandles, correlateCandles) {
  if (!Array.isArray(mainCandles) || !Array.isArray(correlateCandles)) return [];
  if (mainCandles.length < 2 * SWING_WINDOW + 2) return [];
  if (correlateCandles.length < 2 * SWING_WINDOW + 2) return [];
  const matchTolerance = swingMatchTolerance(mainCandles, correlateCandles);

  // SMT must be visible as soon as a candle makes a fresh local extreme. A
  // symmetric window waits for three future candles to confirm each pivot,
  // which makes replay signals appear several bars after the divergence. Keep
  // the same left-side context, but don't require any right-side confirmation.
  const mainSwings = findSwings(mainCandles, SWING_WINDOW, 0);
  const corSwings = findSwings(correlateCandles, SWING_WINDOW, 0);
  const results = [];

  for (const kind of ["highs", "lows"]) {
    const list = mainSwings[kind];
    if (list.length < 2) continue;
    // Walk newest-first so we grab the freshest divergence and stop.
    for (let i = list.length - 1; i >= 1; i--) {
      const curr = list[i];
      const prev = list[i - 1];
      const corCurr = findClosest(corSwings[kind], curr.time, matchTolerance);
      const corPrev = findClosest(corSwings[kind], prev.time, matchTolerance);
      if (!corCurr || !corPrev) continue;

      // 1 = higher, -1 = lower, compared prev → curr
      const mainDir = curr.price > prev.price ? 1 : curr.price < prev.price ? -1 : 0;
      const corDir  = corCurr.price > corPrev.price ? 1 : corCurr.price < corPrev.price ? -1 : 0;
      if (mainDir === 0 || corDir === 0) continue;
      if (mainDir === corDir) continue;

      // Bearish SMT = made a higher high while correlate made a lower high →
      // rally on main likely to fail. Bullish SMT = made a lower low while
      // correlate made a higher low → sell-off on main likely to fail.
      const direction =
        kind === "highs" ? (mainDir === 1 ? "bearish" : "bullish")
                         : (mainDir === -1 ? "bullish" : "bearish");
      results.push({ kind, direction, p1: prev, p2: curr });
      break; // freshest only per kind
    }
  }
  return results;
}
