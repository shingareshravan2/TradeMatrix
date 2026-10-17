import { useEffect, useRef, useState } from "react";
import { fetchCandles } from "../lib/api";
import { toKline, INTERVAL_SECONDS } from "../lib/kline";
import { useReplay } from "../replay/ReplayProvider";

// Replay coordinates every timeframe to the same REPLAY CLOCK window (a fixed
// duration), so switching timeframes keeps the exact same dates instead of
// drifting apart (a fixed bar count made 4h span ~250 days but 15m only ~16).
// But the clock window alone is too few bars for coarse timeframes (45 days = 45
// daily candles → a nearly empty daily chart), so we LOAD at least MIN_REPLAY_BARS
// for chart context and separately CLAMP the clock's range to the window (see
// registerPane below). Coarse timeframes thus show plenty of history on the left
// while the replayable/coordinated span stays consistent.
const REPLAY_WINDOW_SEC = 45 * 86400; // ~45 days — the coordinated clock range
const MAX_REPLAY_BARS = 5000;         // backend per-request cap
const MIN_REPLAY_BARS = 300;          // floor so coarse timeframes still fill the chart
export function replayLimit(interval) {
  const sec = INTERVAL_SECONDS[interval] || 60;
  const forWindow = Math.ceil(REPLAY_WINDOW_SEC / sec);
  return Math.min(MAX_REPLAY_BARS, Math.max(MIN_REPLAY_BARS, forWindow));
}

/**
 * Compute the query `end` timestamp for candles so that the loaded window
 * contains context before `targetDate` and enough future candles to replay
 * forward from `targetDate`. Returns null when fetching the latest live data.
 */
export function replayFetchEnd(targetDate, interval) {
  if (targetDate == null) return null;
  const sec = INTERVAL_SECONDS[interval] || 60;
  const limit = replayLimit(interval);
  const totalSpan = limit * sec;
  // Reserve ~60% of the fetched bars for forward playback, capped by totalSpan
  const forwardSpan = Math.floor(totalSpan * 0.6);
  const nowSec = Math.floor(Date.now() / 1000);
  const desiredEnd = targetDate + forwardSpan;
  // If the desired end reaches today/now (within 5 minutes), fetch latest (null)
  if (desiredEnd >= nowSec - 300) return null;
  return desiredEnd;
}

/**
 * Replay-mode data feed for a pane. Loads a window of history once, then reveals
 * candles with time <= the global wall-clock so all panes stay time-aligned.
 * No-op unless `enabled`.
 */
export function useReplayData({ paneId, source, symbol, interval, enabled, chartRef, ready, onPrice, onLoading, onError, coverSince }) {
  const { clock, targetDate, endTs, registerPane, unregisterPane } = useReplay();
  const activeTargetDate = targetDate ?? endTs;
  // Always anchor the fetch window on the current clock when it is available.
  // This covers two cases:
  //   1. No targetDate set (user entered replay by clicking "Replay" and
  //      navigated by stepping/playing): activeTargetDate is null, so the old
  //      code fell back to null → replayFetchEnd returned null → latest bars
  //      were fetched. The new pane's maxTime pointed to today, range.start
  //      jumped ~45 days back, and the clock (still on e.g. April 4th) got
  //      clamped backward to that new range.start — the "chart goes backward
  //      on timeframe switch" bug.
  //   2. User played forward past the original targetDate: use the advanced
  //      clock instead of the stale original date so the fetched window
  //      actually covers the current replay position.
  // Fall back to activeTargetDate only when the clock is not yet seated (null).
  const fetchAnchor = clock != null ? clock : activeTargetDate;
  const dataRef = useRef([]);
  const renderedRef = useRef(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || !ready) return;
    let cancelled = false;
    (async () => {
      onLoading?.(true);
      try {
        // Load the coordinated replay window centred on fetchAnchor — the current
        // clock position if the user has played forward past the original targetDate,
        // otherwise the original targetDate. This ensures the fetched window always
        // covers the current clock when switching timeframes mid-replay, preventing
        // range.end from being earlier than the clock (which would clamp the clock
        // backwards and make the chart jump to a wrong date).
        // But if a drawing sits further back than that (common after drawing on a
        // higher timeframe then switching to a lower one, where the same bar count
        // spans far fewer days), load enough extra history to reach it so it stays
        // anchored to its candles. `coverSince` is ms; bar count is nominal-interval-
        // based (over-estimates for gapped markets, which just fetches a little extra)
        // and capped at the backend max.
        const fetchEnd = replayFetchEnd(fetchAnchor, interval);
        let limit = replayLimit(interval);
        if (Number.isFinite(coverSince)) {
          const endRefS = fetchEnd ?? Math.floor(Date.now() / 1000);
          const sec = INTERVAL_SECONDS[interval] || 60;
          const needBars = Math.ceil((endRefS - coverSince / 1000) / sec) + 60;
          if (needBars > limit) limit = Math.min(MAX_REPLAY_BARS, needBars);
        }
        const cs = await fetchCandles(source, symbol, interval, limit, fetchEnd);
        if (cancelled) return;
        if (!cs.length) {
          dataRef.current = [];
          try { chartRef.current?.applyNewData([]); } catch {}
          onError?.(`No candles returned for ${symbol} ${interval}`);
          setVersion((v) => v + 1);
          return;
        }
        onError?.(null);
        dataRef.current = cs;
        renderedRef.current = 0;
        if (cs.length) {
          // Clamp the clock's start to the coordinated window even when we loaded
          // extra history for context, so every timeframe's replayable range is the
          // same span (keeping timeframes in sync) while the chart still shows the
          // older bars on the left. When activeTargetDate is set, ensure minTime
          // includes it so the user can replay from that moment forward. Use the
          // original activeTargetDate (not fetchAnchor) here so the replayable range
          // always starts from the user's chosen date even after playing forward.
          const lastBarTime = cs[cs.length - 1].time;
          const defaultMin = Math.max(cs[0].time, lastBarTime - REPLAY_WINDOW_SEC);
          // Use activeTargetDate as the replayable-range start when the user
          // picked a date. When no date was picked, use the clock as the
          // effective anchor (it equals fetchAnchor at this point) so the
          // window is centred on the current clock position. Fall back to
          // defaultMin only when neither is available.
          const effectiveStart = activeTargetDate ?? clock ?? null;
          const minTime = effectiveStart != null
            ? Math.max(cs[0].time, Math.min(effectiveStart, defaultMin))
            : defaultMin;

          registerPane(paneId, {
            interval,
            minTime,
            maxTime: lastBarTime,
            // Sorted bar times so the replay clock can skip non-trading gaps
            // (nights, weekends, holidays) instead of crawling through dead
            // wall-clock time where no candle exists. See ReplayProvider.
            times: cs.map((c) => c.time),
          });
        }
        setVersion((v) => v + 1);
      } catch (err) {
        dataRef.current = [];
        if (!cancelled) onError?.(err.message || String(err));
      } finally {
        if (!cancelled) onLoading?.(false);
      }
    })();
    return () => {
      cancelled = true;
      unregisterPane(paneId);
    };
    // coverSince intentionally NOT a dep: a timeframe switch (interval change) already
    // re-runs this and captures the current coverSince, and same-timeframe drawings are
    // always inside the loaded window — so we avoid a refetch on every draw (which would
    // stall on slow sources like Databento).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ready, source, symbol, interval, activeTargetDate]);

  // Reveal candles up to the global clock.
  useEffect(() => {
    if (!enabled) return;
    const chart = chartRef.current;
    const arr = dataRef.current;
    if (!chart || !arr.length || clock == null) return;

    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= clock) lo = mid + 1;
      else hi = mid;
    }
    const count = lo;

    // Split the work: applyNewData when the data set fundamentally changes
    // (first render after a fetch, or the clock jumped backwards), updateData
    // when we're just appending new bars during play. This is critical because
    // applyNewData auto-scrolls the chart back to the latest bar — using it
    // every tick would snap scroll on every 200ms and make the chart feel
    // unpannable during play.
    //
    // When we DO applyNewData (fetch change), also release the y-axis manual-
    // scale flag so the new price range fits — setStyles({yAxis:{type:"normal"}})
    // is the documented handle that flips Axis._autoCalcTickFlag back to true
    // (see klinecharts ChartImp.setStyles).
    if (renderedRef.current === 0 || count < renderedRef.current) {
      if (count > 0) {
        chart.applyNewData(arr.slice(0, count).map(toKline));
        try { chart.setStyles({ yAxis: { type: "normal" } }); } catch {}
      }
    } else {
      // Append the newly-revealed bars. updateData keeps the chart's right-side
      // offset (`lastBarRightSideDiffBarCount`) constant while the data grows,
      // so the visible window advances by exactly one bar per append and the new
      // candle streams in at the right edge on its own — no manual scroll needed.
      //
      // An earlier version added `scrollByDistance(-added * barSpace)` here to
      // "nudge the view forward". That was backwards: klinecharts treats a
      // negative distance as scrolling toward OLDER data, so it fought the
      // natural streaming every tick and pinned the candles in place while the
      // clock kept moving (the "5min candles freeze on play" bug). Removed.
      for (let i = renderedRef.current; i < count; i++) {
        chart.updateData(toKline(arr[i]));
      }
    }
    renderedRef.current = count;
    if (count > 0) onPrice?.(arr[count - 1].close, arr[count - 1].time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, version, enabled]);
}
