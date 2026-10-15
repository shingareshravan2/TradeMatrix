import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useEffect,
  useCallback,
} from "react";
import { INTERVAL_SECONDS } from "../lib/kline";

const ReplayContext = createContext(null);

const TICK_MS = 200;
// When play is pressed from the end of the window, rewind by this many bars so
// candles replay forward — but no further, so the earlier bars stay on the left
// as history instead of the chart resetting to a single candle.
const REPLAY_START_LOOKBACK_BARS = 300;

/**
 * Global replay on an ABSOLUTE wall-clock. Every pane reveals candles with
 * time <= clock, so all charts show the same moment. The clock spans
 * [latest pane-start, latest pane-end] so it sits where every pane has data;
 * panes whose data ends earlier (closed markets) freeze at their last bar.
 */
export function ReplayProvider({ children }) {
  const [mode, setModeState] = useState("live"); // "live" | "replay"
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(null); // unix seconds
  const [targetDate, setTargetDate] = useState(null); // selected replay date (null = latest)
  const [panesMeta, setPanesMeta] = useState({});

  const range = useMemo(() => {
    const metas = Object.values(panesMeta).filter((m) => m.minTime != null && m.maxTime != null);
    if (!metas.length) return null;
    return {
      start: Math.max(...metas.map((m) => m.minTime)),
      end: Math.max(...metas.map((m) => m.maxTime)),
    };
  }, [panesMeta]);

  const finestSec = useMemo(() => {
    const secs = Object.values(panesMeta).map((m) => INTERVAL_SECONDS[m.interval] || 60);
    return secs.length ? Math.min(...secs) : 60;
  }, [panesMeta]);

  // The earliest bar time strictly AFTER `t`, across all panes (union). Markets
  // that don't trade 24/7 have long stretches with no bars — this lets the clock
  // hop from real bar to real bar and skip that dead time. Returns null past the
  // last bar. Binary-searches each pane's sorted `times`.
  const nextBarTime = useCallback((t) => {
    let best = null;
    for (const m of Object.values(panesMeta)) {
      const ts = m.times;
      if (!ts || !ts.length) continue;
      let lo = 0, hi = ts.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid + 1; else hi = mid; }
      if (lo < ts.length && (best == null || ts[lo] < best)) best = ts[lo];
    }
    return best;
  }, [panesMeta]);

  // The latest bar time strictly BEFORE `t`, across all panes — the mirror of
  // nextBarTime, used by step-back so ⏮ lands on the previous real candle.
  const prevBarTime = useCallback((t) => {
    let best = null;
    for (const m of Object.values(panesMeta)) {
      const ts = m.times;
      if (!ts || !ts.length) continue;
      let lo = 0, hi = ts.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < t) lo = mid + 1; else hi = mid; }
      if (lo > 0 && (best == null || ts[lo - 1] > best)) best = ts[lo - 1];
    }
    return best;
  }, [panesMeta]);

  const registerPane = useCallback((id, meta) => {
    setPanesMeta((prev) => ({ ...prev, [id]: meta }));
  }, []);
  const unregisterPane = useCallback((id) => {
    setPanesMeta((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setMode = useCallback((m) => {
    setModeState(m);
    setPlaying(false);
    if (m === "replay") {
      setClock(null);
      setTargetDate(null);
    }
  }, []);

  // Seat the clock, re-seating whenever the range changes (panes load asynchronously)
  // or the clock drifts outside it. When targetDate is set (user selected a replay date),
  // seat at targetDate so replay starts from that date forward. Otherwise, land near
  // the END of the window (~99%) so entering replay LOOKS like the live view — same
  // latest bars visible.
  useEffect(() => {
    if (mode !== "replay" || !range) return;
    setClock((c) => {
      if (c == null) {
        if (targetDate != null) {
          return Math.max(range.start, Math.min(range.end, targetDate));
        }
        return Math.round(range.start + (range.end - range.start) * 0.99);
      }
      // The range moved (e.g. a timeframe switch loaded a different window). Keep
      // the SAME moment so timeframes stay coordinated — only CLAMP it into the
      // new window; never fling the clock forward to the latest bar.
      if (c < range.start) return range.start;
      if (c > range.end) return range.end;
      return c;
    });
  }, [mode, range, targetDate]);

  useEffect(() => {
    if (!playing || mode !== "replay" || !range) return;
    const id = setInterval(() => {
      setClock((c) => {
        const base = c ?? range.start;
        let next = base + finestSec * speed * (TICK_MS / 1000);
        // Gap-skip: if the next real bar is more than ~1.5 bars away in wall-clock
        // (a night/weekend/holiday with no candles), jump straight to it instead of
        // crawling through the dead time — that crawl is the "clock moves but the
        // candles don't" freeze on non-24/7 markets. Contiguous in-session bars sit
        // ~1 interval apart, below the threshold, so normal play stays smooth.
        const nb = nextBarTime(base);
        if (nb != null && nb - base > finestSec * 1.5 && nb > next) next = nb;
        if (next >= range.end) {
          setPlaying(false);
          return range.end;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, mode, speed, finestSec, range, nextBarTime]);

  const clamp = useCallback((t) => (range ? Math.max(range.start, Math.min(range.end, t)) : t), [range]);

  const value = {
    mode,
    setMode,
    playing,
    // Play forward. On entry the clock is seated at ~99% of the window so replay
    // "looks like live" — but pressing play there (or after a run has parked the
    // clock at range.end) leaves nothing to advance: the first tick hits range.end
    // and immediately pauses, which reads as "play does nothing". So when we're
    // at/near the end, rewind — but only by a bounded lookback (capped at half the
    // window), NOT all the way to range.start, so the earlier bars stay visible on
    // the left as history instead of the chart collapsing to a single candle. A
    // clock the user has scrubbed into the middle is left alone — play resumes there.
    play: () => {
      setClock((c) => {
        if (!range) return c;
        const span = range.end - range.start;
        const atEnd = c == null || c >= range.end - span * 0.02;
        if (!atEnd) return c;
        const lookback = Math.min(REPLAY_START_LOOKBACK_BARS * finestSec, span * 0.5);
        return range.end - lookback;
      });
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    speed,
    setSpeed,
    clock,
    range,
    hasData: !!range,
    displayTime: clock,
    seek: (t) => setClock(clamp(t)),
    // Step to the adjacent REAL bar (skipping gaps) so ⏭/⏮ advance exactly one
    // candle, not one nominal interval that might land in dead non-trading time.
    stepForward: () => setClock((c) => {
      const from = c ?? range?.start ?? 0;
      const nb = nextBarTime(from);
      return clamp(nb != null ? nb : from + finestSec);
    }),
    stepBack: () => setClock((c) => {
      const from = c ?? range?.start ?? 0;
      const pb = prevBarTime(from);
      return clamp(pb != null ? pb : from - finestSec);
    }),
    targetDate,
    setTargetDate: (ts) => {
      setTargetDate(ts);
      setPlaying(false);
      setClock(ts != null ? ts : null);
    },
    endTs: targetDate,
    setEndTs: (ts) => {
      setTargetDate(ts);
      setPlaying(false);
      setClock(ts != null ? ts : null);
    },
    registerPane,
    unregisterPane,
  };

  return <ReplayContext.Provider value={value}>{children}</ReplayContext.Provider>;
}

export function useReplay() {
  const ctx = useContext(ReplayContext);
  if (!ctx) throw new Error("useReplay must be used within ReplayProvider");
  return ctx;
}
