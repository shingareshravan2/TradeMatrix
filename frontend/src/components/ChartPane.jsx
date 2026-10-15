import React, { useEffect, useRef, useState } from "react";
import { useChart } from "../hooks/useChart";
import { useCandleStream } from "../hooks/useCandleStream";
import { useReplayData, replayLimit, replayFetchEnd } from "../hooks/useReplayData";
import { useReplay } from "../replay/ReplayProvider";
import { useTrading } from "../trading/TradingProvider";
import { fetchCandles } from "../lib/api";
import { toKline, INTERVAL_SECONDS } from "../lib/kline";
import { registerHtfIndicator, HTF_INDICATOR, htfPanelWidth } from "../lib/htfIndicator";
import { registerFvgIndicator, FVG_INDICATOR } from "../lib/fvgIndicator";
import { registerCisdIndicator, CISD_INDICATOR } from "../lib/cisdIndicator";
import { registerPositionOverlays } from "../lib/positionOverlay";
import { registerFibonacciOverlay } from "../lib/fibonacciOverlay";
import { registerTrendLineOverlay } from "../lib/trendLineOverlay";
import { registerDatePriceRangeOverlay } from "../lib/datePriceRangeOverlay";
import { setPaneTimeCtx, clearPaneTimeCtx, fillMissingAnchorTimes } from "../lib/overlayTimeCtx";
import { registerSmtOverlay } from "../lib/smtOverlay";
import { detectDivergences } from "../lib/smtDetect";
import { registerPspIndicator, PSP_INDICATOR } from "../lib/pspIndicator";
import { detectPsp } from "../lib/pspDetect";
import TickerBar from "./TickerBar";
import SymbolSearch from "./SymbolSearch";
import TradePanel from "./TradePanel";
import BacktestPanel from "./BacktestPanel";

registerHtfIndicator();
registerFvgIndicator();
registerCisdIndicator();
registerPositionOverlays();
registerFibonacciOverlay();
registerTrendLineOverlay();
registerDatePriceRangeOverlay();
registerSmtOverlay();
registerPspIndicator();

const MAIN_PANE = "candle_pane";
const MAIN_INDICATORS = ["MA", "EMA", "BOLL"]; // overlaid on the price pane
const SUB_INDICATORS = ["VOL", "MACD", "RSI", "KDJ"]; // each in its own sub-pane
const ALL_INDICATORS = [...MAIN_INDICATORS, ...SUB_INDICATORS];

const HTF_OPTIONS = ["30m", "1h", "4h", "1d"]; // higher timeframes that can be stacked
const HTF_COUNT = 6; // candles shown per HTF group
const DEFAULT_RIGHT_OFFSET = 80;

// ICT "Smart Money Technique" — highly-correlated US index futures.
// When the pane's symbol is one of these AND `smt` is enabled, we fetch the OTHER
// two symbols' HTF candles alongside the main and highlight direction divergences.
const SMT_TRIO = ["NQ.c.0", "ES.c.0", "YM.c.0"];
const SMT_LABEL = { "NQ.c.0": "NQ", "ES.c.0": "ES", "YM.c.0": "YM" };

const toHtf = (c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close });

const DRAW_TOOLS = [
  // NOTE: the custom `trendLine` (a bounded segment locked level to the first
  // click's price — see lib/trendLineOverlay.js) is a direct-action toolbar
  // button next to the Σ backtest button, not a dropdown entry.
  { id: "horizontalStraightLine", label: "Horizontal line" },
  { id: "rayLine", label: "Ray line" },
  { id: "priceLine", label: "Price line" },
  { id: "rect", label: "Rectangle" },
];

// Direct-action toolbar buttons for the R:R-aware trader tools. Each is a
// single-click entry into the corresponding overlay (no submenu) — up-triangle
// for LONG (green), down-triangle for SHORT (red), phi glyph for Fibonacci.
const POSITION_TOOLS = [
  { id: "longPosition",  label: "Long position",  glyph: "▲", cls: "long"  },
  { id: "shortPosition", label: "Short position", glyph: "▼", cls: "short" },
  { id: "fibonacciLine", label: "Fibonacci",      glyph: "φ", cls: "fib"   },
];

// Overlay-name → human label, used to name each entry in the per-drawing delete
// list. Covers every user-drawable tool (draw menu + position/fibonacci buttons +
// the standalone Trend line button, which isn't in DRAW_TOOLS).
const OVERLAY_LABELS = {
  ...Object.fromEntries([...DRAW_TOOLS, ...POSITION_TOOLS].map((t) => [t.id, t.label])),
  trendLine: "Trend line",
  datePriceRange: "Date & price range",
};

export default function ChartPane({ paneId, config, sources, onConfigChange }) {
  const { hostRef, chartRef, ready, resetView, initialBarSpaceRef } = useChart(config.interval);
  const { mode, clock, targetDate, endTs } = useReplay();
  const activeTargetDate = targetDate ?? endTs;
  const { reportPrice, trades } = useTrading();
  const [price, setPrice] = useState(null);
  const [lastTime, setLastTime] = useState(null); // time (sec) of the latest candle
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState(null); // "draw" | "drawings" | "ind" | "trade" | "backtest" | null
  const [btResult, setBtResult] = useState(null);
  // Bumped whenever a drawing is added/finished/removed so the per-drawing delete
  // list re-renders (drawings live in overlayIdsRef, which doesn't trigger renders).
  const [, setDrawVersion] = useState(0);
  const menuRef = useRef(null);
  const overlayIdsRef = useRef([]);
  // Visible time window captured at a timeframe switch, so the new timeframe can
  // reopen on the SAME slice of the market (keeping drawings in view) instead of
  // snapping to the latest bars. { leftTs, rightTs, targetInterval }.
  const pendingViewRef = useRef(null);
  const markerIdsRef = useRef(new Map()); // tradeId -> overlay id
  const btMarkerIdsRef = useRef([]); // backtest entry-marker overlay ids
  const smtOverlayIdsRef = useRef(new Set()); // SMT divergence overlay ids
  const smtSigRef = useRef(""); // signature of the last-drawn divergence set
  const smtCorrelateRef = useRef({ key: null, promise: null }); // cached correlate fetch
  const pspSigRef = useRef(""); // signature of the last-drawn PSP marker set
  const pspCorrelateRef = useRef({ key: null, promise: null }); // cached PSP correlate fetch
  // Last-good HTF candles per `${source}|${symbol}|${htf}`. Lets a re-run (e.g.
  // toggling a new timeframe on) keep the already-loaded groups visible instead of
  // blanking them while every timeframe re-fetches, and lets a slow/failed refetch
  // fall back to the previous candles rather than vanishing.
  const htfCacheRef = useRef(new Map());
  // Replay only: fetched windows for HTFs FINER than the main timeframe, which
  // can't be aggregated from the coarser main candles (e.g. 30m/1h on a 1d chart).
  // Keyed by `${source}|${symbol}|${htf}`; the version bumps when a fetch lands so
  // the clock-driven reveal re-runs.
  const replayHtfFetchRef = useRef(new Map());
  const [replayHtfVersion, setReplayHtfVersion] = useState(0);

  const isReplay = mode === "replay";
  const indicators = (config.indicators ?? []).filter((x) => typeof x === "string");
  const indKey = indicators.join(",");
  // Always render lowest → highest timeframe, left → right, regardless of the
  // order the user toggled them on. HTF_OPTIONS is defined ascending, so filtering
  // it by the selected set yields that order (and makes htfKey order-independent).
  const htfs = HTF_OPTIONS.filter((x) => (config.htfs ?? []).includes(x));
  const htfKey = htfs.join(",");
  const smtEnabled = !!config.smt && SMT_TRIO.includes(config.symbol);
  const pspEnabled = !!config.psp && SMT_TRIO.includes(config.symbol);

  // Publish this pane's currently-loaded bar window so time-anchored overlays
  // (trend line, position, fibonacci) can re-project anchors that fall outside it
  // instead of snapping them to an edge bar. Cheap: reads the chart's own data
  // array and its first/last timestamp. Called wherever the data changes (initial
  // history, each live/replay tick, and older-history loads).
  const refreshTimeCtx = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = chart.getDataList?.() ?? [];
    if (!data.length) return;
    const firstTs = data[0]?.timestamp;
    const lastTs = data[data.length - 1]?.timestamp;
    // Average REAL time each bar covers across the loaded window — gap-inclusive,
    // so markets that don't trade 24/7 (equities, futures) don't fool the overlay
    // re-projection into overcounting bars. Falls back to the nominal interval
    // when there's only one bar to measure.
    const nominalMs = (INTERVAL_SECONDS[config.interval] || 60) * 1000;
    const msPerBar =
      data.length > 1 && lastTs > firstTs ? (lastTs - firstTs) / (data.length - 1) : nominalMs;
    setPaneTimeCtx(paneId, { firstTs, lastTs, msPerBar, times: data.map((d) => d.timestamp) });
  };

  // Update the ticker and mark the trading account at the pane's current price.
  const mark = (close, time) => {
    setPrice(close);
    setLastTime(time);
    if (close != null) reportPrice(config.symbol, close, time);
    refreshTimeCtx();
    restorePendingView();
  };

  // Drop this pane's published time window when the pane unmounts.
  useEffect(() => () => clearPaneTimeCtx(paneId), [paneId]);

  // In live mode, flag data that's gone stale (e.g. a closed/holiday market) so a
  // frozen chart reads as "market closed" rather than broken.
  const stale =
    !isReplay &&
    lastTime != null &&
    Date.now() / 1000 - lastTime > 3 * (INTERVAL_SECONDS[config.interval] || 60);

  // Live feed (active in live mode).
  useCandleStream({
    paneId,
    source: config.source,
    symbol: config.symbol,
    interval: config.interval,
    enabled: !isReplay,
    onHistory: (cands) => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.applyNewData(cands.map(toKline), true); // more=true -> allow loading older
      const last = cands[cands.length - 1];
      if (last) mark(last.close, last.time);
    },
    onUpdate: (c) => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.updateData(toKline(c));
      mark(c.close, c.time);
    },
    onError: setError,
    onLoading: setLoading,
  });

  // Oldest user-drawing anchor time (quantized to the day so small edits don't churn
  // the replay fetch). In replay a finer timeframe reveals far fewer calendar days
  // than a daily view, so a drawing made on the higher timeframe can fall outside
  // the loaded finer-TF window and land off its candles — passing this lets the
  // replay loader fetch enough history to cover it. Recomputed every render; the
  // draw lifecycle (bumpDraw) re-renders whenever a drawing is added/moved/removed.
  const drawingsMinTs = (() => {
    const chart = chartRef.current;
    if (!chart) return null;
    let min = null;
    for (const id of overlayIdsRef.current) {
      const ov = chart.getOverlayById?.(id);
      for (const p of ov?.points ?? []) {
        if (Number.isFinite(p?.timestamp)) min = min == null ? p.timestamp : Math.min(min, p.timestamp);
      }
    }
    return min == null ? null : Math.floor(min / 86400000) * 86400000;
  })();

  // Replay feed (active in replay mode) — driven by the global clock.
  useReplayData({
    paneId,
    source: config.source,
    symbol: config.symbol,
    interval: config.interval,
    enabled: isReplay,
    chartRef,
    ready,
    onPrice: mark,
    onLoading: setLoading,
    coverSince: drawingsMinTs,
  });

  // Endless history (live mode): when the user scrolls back to the oldest bar,
  // fetch a batch of older candles until the data source runs out.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || isReplay) return;
    chart.setLoadDataCallback(async ({ type, data, callback }) => {
      if (type !== "forward" || !data) {
        callback([], true);
        return;
      }
      try {
        const end = Math.floor(data.timestamp / 1000) - 1;
        const older = await fetchCandles(config.source, config.symbol, config.interval, 500, end);
        const klines = older.filter((c) => c.time * 1000 < data.timestamp).map(toKline);
        callback(klines, klines.length > 0);
        refreshTimeCtx(); // older bars extend the window left — re-anchor overlays
      } catch {
        callback([], false);
      }
    });
    return () => {
      try { chart.setLoadDataCallback(() => {}); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isReplay, config.source, config.symbol, config.interval]);

  const sourceDef = sources.find((s) => s.name === config.source) ?? sources[0];

  const update = (patch) => {
    const next = { ...config, ...patch };
    if (patch.source) {
      const def = sources.find((s) => s.name === patch.source);
      if (def) {
        if (patch.symbol === undefined && !def.symbols.includes(next.symbol)) {
          next.symbol = def.symbols[0];
        }
        if (!def.intervals.includes(next.interval)) next.interval = def.intervals[0];
      }
    }
    // Pure timeframe switch (same instrument): remember the currently-visible time
    // window so restorePendingView can reopen the new timeframe on it. Captured
    // BEFORE the switch, while the chart still holds the old timeframe's bars.
    if (
      next.interval !== config.interval &&
      next.source === config.source &&
      next.symbol === config.symbol
    ) {
      captureViewForIntervalChange(next.interval);
    }
    onConfigChange(next);
  };

  // Snapshot the visible [leftTs, rightTs] time window from the current (old)
  // timeframe's bars, plus the time span covered by any user drawings. Anchor
  // timestamps are absolute, so we can read them off the old timeframe's overlays.
  const captureViewForIntervalChange = (nextInterval) => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      const vr = chart.getVisibleRange();
      const data = chart.getDataList();
      if (!data.length || !vr) return;
      const li = Math.max(0, Math.min(data.length - 1, vr.from));
      const ri = Math.max(0, Math.min(data.length - 1, vr.to));
      const leftTs = data[li]?.timestamp;
      const rightTs = data[ri]?.timestamp;
      // Span of user drawings currently on this pane, so the new timeframe can
      // reopen framed on them instead of on the recent edge (which would leave a
      // drawing made further back off-screen to the left).
      let drawMin = null, drawMax = null;
      for (const id of overlayIdsRef.current) {
        const ov = chart.getOverlayById?.(id);
        for (const p of ov?.points ?? []) {
          if (Number.isFinite(p?.timestamp)) {
            drawMin = drawMin == null ? p.timestamp : Math.min(drawMin, p.timestamp);
            drawMax = drawMax == null ? p.timestamp : Math.max(drawMax, p.timestamp);
          }
        }
      }
      if (leftTs != null && rightTs != null && rightTs > leftTs) {
        pendingViewRef.current = { leftTs, rightTs, drawMin, drawMax, targetInterval: nextInterval };
      }
    } catch {}
  };

  // After the new timeframe's data has loaded, reopen it on the SAME time window
  // that was visible before the switch. Candle width ALWAYS stays at the normal
  // default — we never shrink to fit a drawing's span, since that produced the
  // "candles too small on switch" bug. We only SCROLL: to the drawing's right edge
  // if there is one (so a line made on the old timeframe stays in view — its recent
  // portion at least; scroll left for a wider one), otherwise to the same moment
  // that was at the right edge before. Runs once per switch (consumes the ref).
  // Called from mark() after each data apply.
  const restorePendingView = () => {
    const pv = pendingViewRef.current;
    const chart = chartRef.current;
    if (!pv || !chart || pv.targetInterval !== config.interval) return;
    const data = chart.getDataList();
    if (!data.length) return;
    pendingViewRef.current = null; // consume once; re-asserts below handle late resets

    const applyView = () => {
      const c = chartRef.current;
      const d = c?.getDataList?.() ?? [];
      const width = hostRef.current?.clientWidth ?? 0;
      if (!c || !d.length || width <= 0 || config.interval !== pv.targetInterval) return;
      const normal = initialBarSpaceRef.current || 8;
      const lastTs = d[d.length - 1].timestamp;
      // Put the CURRENT price (the last candle / replay clock) in the CENTRE, with
      // room to its right, instead of jammed against the right edge. We do that by
      // reserving ~half the main plot width as right-offset (beyond the HTF panel's
      // own reserved margin), then scrolling the last bar to that offset. Candle
      // width always stays at the normal default (never shrunk). Drawings made near
      // the current price come along into view; older ones are a scroll to the left.
      const htfW = htfs.length ? htfPanelWidth(htfs.length, HTF_COUNT) : DEFAULT_RIGHT_OFFSET;
      const centerOffset = Math.round(htfW + (width - htfW) / 2);
      try {
        c.setBarSpace(normal); // ALWAYS normal candle width
        c.setOffsetRightDistance(centerOffset);
        c.scrollToRealTime(0); // last bar to the offset position → current price centred
      } catch {}
    };

    // If the drawings sit further back than the finer timeframe's initial history
    // (the coarse→fine case: 1h loads far fewer days than a daily view spans), the
    // anchors fall outside the loaded window and get extrapolated off-screen. Fetch
    // older bars to actually COVER them so they resolve to real candles at the exact
    // spot. One targeted fetch, async so it never blocks the switch. Live mode only —
    // replay manages its own coordinated window.
    const ensureDrawingCovered = async () => {
      if (isReplay || pv.drawMin == null) return;
      const c0 = chartRef.current;
      const d0 = c0?.getDataList?.() ?? [];
      if (!c0 || !d0.length || config.interval !== pv.targetInterval) return;
      if (d0[0].timestamp <= pv.drawMin) return; // already covered
      const intervalMs = (INTERVAL_SECONDS[config.interval] || 60) * 1000;
      // Nominal-interval bar count over-estimates for gapped markets (fewer real
      // bars than wall-clock hours), which is fine here — it just fetches a little
      // extra history, guaranteeing the drawing is covered. Capped at the backend max.
      const needBars = Math.ceil((pv.rightTs - pv.drawMin) / intervalMs) + 60;
      const limit = Math.min(5000, Math.max(needBars, 500));
      try {
        const older = await fetchCandles(config.source, config.symbol, config.interval, limit, Math.floor(pv.rightTs / 1000));
        const c = chartRef.current;
        if (!c || config.interval !== pv.targetInterval) return;
        const firstNow = c.getDataList?.()[0]?.timestamp ?? Infinity;
        const prepend = older.filter((x) => x.time * 1000 < firstNow).map(toKline);
        if (prepend.length) { c.applyMoreData(prepend, true); refreshTimeCtx(); }
        applyView(); // re-frame now that the drawing's bars exist
        setTimeout(applyView, 120);
      } catch {}
    };

    // Apply now, then re-assert a couple of times: the new timeframe's data can
    // arrive in more than one batch, and each applyNewData re-frames the chart to
    // the latest bars — so a single apply gets clobbered. Re-asserting over ~0.5s
    // makes the restored window stick.
    applyView();
    setTimeout(applyView, 160);
    setTimeout(applyView, 420);
    ensureDrawingCovered(); // fire-and-forget: backfills history if a drawing is older (live)
  };

  // ---- Indicators: sync chart indicators with the persisted name list ----
  const appliedRef = useRef(new Set());
  const builtForRef = useRef(null);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    if (builtForRef.current !== chart) {
      appliedRef.current = new Set(); // chart was (re)created; re-apply from scratch
      builtForRef.current = chart;
    }
    const applied = appliedRef.current;
    const desired = new Set(indicators);

    for (const name of [...applied]) {
      if (!desired.has(name)) {
        chart.removeIndicator(MAIN_INDICATORS.includes(name) ? MAIN_PANE : name, name);
        applied.delete(name);
      }
    }
    for (const name of desired) {
      if (!applied.has(name)) {
        if (MAIN_INDICATORS.includes(name)) chart.createIndicator(name, true, { id: MAIN_PANE });
        else chart.createIndicator(name, false, { id: name });
        applied.add(name);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, indKey]);

  // ---- ICT HTF candles: fetch the chosen higher timeframes and paint them in the
  // right margin via the custom indicator. Reserves right-offset space for the panel.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || !htfs.length) return;
    let cancelled = false;
    // Reserve the right-margin BEFORE the async fetch — otherwise the first
    // paint clips the panel off the right edge (the fetch below can take
    // seconds on cold Databento calls).
    try { chart.setOffsetRightDistance(htfPanelWidth(htfs.length, HTF_COUNT)); } catch {}
    // Remove any stale HTF indicator from a previous run before creating a new
    // one, otherwise a duplicate createIndicator call is silently dropped and
    // the panel doesn't render. Seed with skeleton groups (labels, no candles
    // yet) so every chosen timeframe's column shows immediately instead of a
    // single "HTF …" placeholder while data loads.
    try { chart.removeIndicator(MAIN_PANE, HTF_INDICATOR); } catch {}
    // Seed each group from the last-good cache so already-loaded timeframes stay
    // painted through the re-run (e.g. when a new timeframe is toggled on) instead
    // of flashing to an empty skeleton while everything re-fetches.
    const cacheKey = (htf) => `${config.source}|${config.symbol}|${htf}`;
    const seeded = (htf) => htfCacheRef.current.get(cacheKey(htf)) ?? { htf, candles: [] };
    chart.createIndicator(
      { name: HTF_INDICATOR, extendData: { groups: htfs.map((htf) => seeded(htf)) } },
      true,
      { id: MAIN_PANE }
    );

    // In replay mode the HTF candles are rebuilt from the main chart's revealed
    // bars (<= the replay clock) by the clock-driven effect below, so they track
    // the replayed time and the newest one grows then locks. Skip the live fetch.
    if (isReplay) {
      return () => {
        try { chart.removeIndicator(MAIN_PANE, HTF_INDICATOR); } catch {}
        try { chart.setOffsetRightDistance(DEFAULT_RIGHT_OFFSET); } catch {}
      };
    }

    const others = smtEnabled ? SMT_TRIO.filter((s) => s !== config.symbol) : [];

    const refresh = async () => {
      // Fetch every timeframe CONCURRENTLY and repaint as each arrives — so one
      // slow cold Databento fetch (a 4h/1d envelope miss can take 20s+) can't
      // block the others (or a freshly-added 30m) from showing. Was previously a
      // sequential loop that only painted after ALL fetches finished, so a single
      // slow interval left the whole panel stuck on "HTF …". Panel order and the
      // reserved right-margin width both follow `htfs`.
      //
      // Seed from the last-good cache, NOT empty: a group that already has candles
      // keeps them until its refetch lands, so a slow/failed refetch (or the first
      // paint of a periodic refresh cycle) never blanks the other groups.
      const byHtf = new Map(htfs.map((htf) => [htf, seeded(htf)]));
      const paint = () => {
        if (cancelled || !chartRef.current) return;
        const groups = htfs.map((htf) => byHtf.get(htf));
        chartRef.current.setOffsetRightDistance(htfPanelWidth(groups.length, HTF_COUNT));
        chartRef.current.overrideIndicator({ name: HTF_INDICATOR, extendData: { groups } }, MAIN_PANE);
      };
      await Promise.all(
        htfs.map(async (htf) => {
          try {
            const cs = await fetchCandles(config.source, config.symbol, htf, HTF_COUNT);
            // A momentarily-empty response shouldn't wipe a group that already has
            // candles — keep the previous data rather than blanking.
            if (!cs.length && (byHtf.get(htf)?.candles?.length ?? 0) > 0) {
              paint();
              return;
            }
            const group = { htf, candles: cs.map(toHtf) };
            // Paint this timeframe's OWN candles immediately — do NOT wait on the
            // SMT correlate fetches below. The correlates hit OTHER symbols whose
            // envelopes may be cold and slow (databento's 30m shares the big
            // ohlcv-1m envelope, which can take tens of seconds or 504), and
            // blocking the group's paint on them meant the candles themselves
            // never appeared (the "30m HTF not showing" bug).
            byHtf.set(htf, group);
            htfCacheRef.current.set(cacheKey(htf), group); // remember last-good
            paint();
            if (others.length) {
              // Pull the correlated symbols' HTF too and reduce to {label, dir} —
              // the indicator only needs the last-candle direction. Added to the
              // group asynchronously; a slow/failed correlate never hides candles.
              const correlates = await Promise.all(
                others.map(async (sym) => {
                  try {
                    const oc = await fetchCandles(config.source, sym, htf, HTF_COUNT);
                    const last = oc[oc.length - 1];
                    if (!last) return null;
                    return {
                      symbol: sym,
                      label: SMT_LABEL[sym] ?? sym,
                      dir: last.close >= last.open ? "up" : "down",
                    };
                  } catch {
                    return null;
                  }
                })
              );
              group.correlates = correlates.filter(Boolean);
              byHtf.set(htf, group);
              htfCacheRef.current.set(cacheKey(htf), group);
            }
          } catch {
            // Keep whatever we last had for this timeframe (seeded above) so a
            // failed refetch leaves the existing candles in place instead of
            // vanishing them.
          }
          paint(); // incremental: show each timeframe the moment its data lands
        })
      );
    };

    refresh();
    // 60s is comfortably fresh for HTF and cuts periodic load on slow backends
    // (Databento) by 3x vs the old 20s cadence.
    const timer = setInterval(refresh, 60000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      try { chart.removeIndicator(MAIN_PANE, HTF_INDICATOR); } catch {}
      try { chart.setOffsetRightDistance(DEFAULT_RIGHT_OFFSET); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, config.source, config.symbol, htfKey, smtEnabled, isReplay]);

  // ---- Replay HTF candles: rebuild each higher-timeframe group from the main
  // chart's revealed bars (which in replay are exactly the bars <= the clock), so
  // the HTF panel tracks the replayed time. Runs every clock tick: the bar that
  // contains the clock keeps growing (its high/low/close evolve as more sub-bars
  // are revealed) and locks in when the clock crosses the HTF boundary, at which
  // point a fresh forming bar begins. No network — pure aggregation of on-chart data.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || !isReplay || !htfs.length) return;
    const mainData = chart.getDataList();
    if (!mainData || !mainData.length) return;
    const mainSec = INTERVAL_SECONDS[config.interval] || 60;
    const groups = htfs.map((htf) => {
      const htfSec = INTERVAL_SECONDS[htf] || 1800;
      // HTF FINER than the main timeframe can't be built by aggregating the
      // coarser main candles (they'd collapse to the main candles). Use the
      // separately-fetched real HTF window instead, revealing only candles that
      // have fully CLOSED at/before the clock (no future leak).
      if (htfSec < mainSec) {
        const win = replayHtfFetchRef.current.get(`${config.source}|${config.symbol}|${htf}`) || [];
        const candles = [];
        for (const c of win) {
          if (clock != null && c.time + htfSec > clock) break; // not yet closed
          candles.push(toHtf(c));
        }
        return { htf, candles: candles.slice(-HTF_COUNT) };
      }
      const bucketMs = htfSec * 1000;
      const buckets = new Map(); // bucketStartMs -> aggregated HTF candle
      for (const c of mainData) {
        const ts = c.timestamp;
        if (ts == null) continue;
        const key = Math.floor(ts / bucketMs) * bucketMs;
        const b = buckets.get(key);
        if (!b) buckets.set(key, { t: Math.floor(key / 1000), o: c.open, h: c.high, l: c.low, c: c.close });
        else {
          if (c.high > b.h) b.h = c.high;
          if (c.low < b.l) b.l = c.low;
          b.c = c.close; // latest revealed sub-bar's close => forming candle grows
        }
      }
      // Map preserves insertion (chronological) order; keep the last HTF_COUNT.
      return { htf, candles: Array.from(buckets.values()).slice(-HTF_COUNT) };
    });
    try { chart.overrideIndicator({ name: HTF_INDICATOR, extendData: { groups } }, MAIN_PANE); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isReplay, htfKey, clock, config.interval, replayHtfVersion]);

  // In replay, fetch the real candles for any HTF finer than the main timeframe
  // (they can't be aggregated from the coarser main data). One window per htf,
  // "as of" the replay date; the reveal above slices it to the clock.
  useEffect(() => {
    if (!ready || !isReplay || !htfs.length) return;
    let cancelled = false;
    const mainSec = INTERVAL_SECONDS[config.interval] || 60;
    const finer = htfs.filter((htf) => (INTERVAL_SECONDS[htf] || 1800) < mainSec);
    if (!finer.length) return;
    (async () => {
      await Promise.all(
        finer.map(async (htf) => {
          try {
            const htfEnd = replayFetchEnd(activeTargetDate, htf);
            const cs = await fetchCandles(config.source, config.symbol, htf, replayLimit(htf), htfEnd);
            if (!cancelled) replayHtfFetchRef.current.set(`${config.source}|${config.symbol}|${htf}`, cs);
          } catch {}
        })
      );
      if (!cancelled) setReplayHtfVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isReplay, config.source, config.symbol, htfKey, config.interval, activeTargetDate]);

  // ---- ICT Fair Value Gaps: stacked indicator that shades 3-candle imbalances
  // on the price pane, extended a couple of candles forward. Toggled by config.fvg.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    if (!config.fvg) {
      try { chart.removeIndicator(MAIN_PANE, FVG_INDICATOR); } catch {}
      return;
    }
    try { chart.removeIndicator(MAIN_PANE, FVG_INDICATOR); } catch {}
    chart.createIndicator({ name: FVG_INDICATOR }, true, { id: MAIN_PANE });
    return () => {
      try { chart.removeIndicator(MAIN_PANE, FVG_INDICATOR); } catch {}
    };
  }, [ready, config.fvg]);

  // ---- ICT Change in State of Delivery: marks the level (open of the last
  // same-direction run) that price reclaimed/broke to flip delivery. Toggled by
  // config.cisd.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    if (!config.cisd) {
      try { chart.removeIndicator(MAIN_PANE, CISD_INDICATOR); } catch {}
      return;
    }
    try { chart.removeIndicator(MAIN_PANE, CISD_INDICATOR); } catch {}
    chart.createIndicator({ name: CISD_INDICATOR }, true, { id: MAIN_PANE });
    return () => {
      try { chart.removeIndicator(MAIN_PANE, CISD_INDICATOR); } catch {}
    };
  }, [ready, config.cisd]);

  // ---- SMT trend lines on the main chart ----
  // When SMT is enabled + we're on one of the trio, detect divergences between
  // this symbol and each correlate at the current interval, then draw a segment
  // overlay connecting the two divergent swing points on the main chart. Red =
  // bearish (main HH vs correlate LH), teal = bullish (main LL vs correlate HL).
  //
  // Works in BOTH live and replay. In replay the correlate window is fetched "as
  // of" the replay date (endTs, same window the main pane replays) and both
  // series are clipped to the global clock, so we only ever draw divergences the
  // trader could have seen at that replay moment — never future swings. Overlays
  // are locked (never draggable — computed, not user-drawn).
  const clearSmt = () => {
    const c = chartRef.current;
    for (const id of smtOverlayIdsRef.current) {
      try { c?.removeOverlay(id); } catch {}
    }
    smtOverlayIdsRef.current.clear();
  };

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || !smtEnabled) return;
    let cancelled = false;
    const correlates = SMT_TRIO.filter((s) => s !== config.symbol);

    const detect = async () => {
      if (cancelled) return;
      const mainData = chart.getDataList?.() ?? [];
      if (!mainData.length) return;
      // KLineChart internal format uses `timestamp` (ms); our detector wants
      // `time` (seconds) alongside high/low, so normalise. In replay getDataList
      // is already clipped to the clock; clip again defensively.
      let mainCandles = mainData.map((c) => ({
        time: Math.floor(c.timestamp / 1000),
        high: c.high,
        low: c.low,
      }));
      if (isReplay && clock != null) mainCandles = mainCandles.filter((c) => c.time <= clock);
      if (!mainCandles.length) return;

      // Fetch the correlate windows. In replay, fetch based on the replay date and
      // cache the result (activeTargetDate is stable for the session), then clip per-clock
      // locally — so advancing the clock never triggers a network round-trip. In
      // live we refetch each pass so freshly-formed swings show up.
      const asOf = isReplay ? (replayFetchEnd(activeTargetDate, config.interval) ?? undefined) : undefined;
      const key = `${isReplay ? "R" : "L"}|${config.source}|${config.symbol}|${config.interval}|${asOf ?? "latest"}`;
      if (!isReplay || smtCorrelateRef.current.key !== key) {
        // Replay: fetch the SAME per-interval window the main pane replays
        // (replayLimit is timeframe-scaled) so the correlate covers the whole
        // replayable range. A fixed bar count under-reached on fine timeframes —
        // e.g. 1500 5m bars span only ~5 days while the 5m main window spans ~17,
        // so for most of the replay the correlate was entirely in the clock's
        // future, got clipped to empty, and no SMT drew. Live: match the main's
        // loaded bar count (capped) so freshly-formed swings line up.
        const limit = isReplay ? replayLimit(config.interval) : Math.min(1000, mainData.length);
        smtCorrelateRef.current = {
          key,
          promise: Promise.all(
            correlates.map(async (sym) => {
              try {
                const cs = await fetchCandles(config.source, sym, config.interval, limit, asOf);
                return { symbol: sym, candles: cs };
              } catch { return null; }
            })
          ),
        };
      }
      const cors = (await smtCorrelateRef.current.promise).filter(Boolean);
      if (cancelled || !chartRef.current) return;

      // Detect divergences against each correlate, clipping the correlate to the
      // clock in replay so we don't peek at swings that form after "now".
      const divs = [];
      for (const cor of cors) {
        let corCandles = cor.candles;
        if (isReplay && clock != null) corCandles = corCandles.filter((c) => c.time <= clock);
        const label = SMT_LABEL[cor.symbol] ?? cor.symbol;
        for (const d of detectDivergences(mainCandles, corCandles)) divs.push({ label, ...d });
      }

      // Only touch the chart when the divergence set actually changes — replay
      // re-runs this every 200ms clock tick, and blindly clearing/recreating
      // overlays each tick would flicker and thrash klinecharts.
      const sig = divs.map((d) => `${d.label}|${d.direction}|${d.p1.time}|${d.p2.time}`).join("~");
      if (sig === smtSigRef.current) return;
      smtSigRef.current = sig;

      clearSmt();
      for (const d of divs) {
        try {
          const id = chartRef.current.createOverlay({
            name: "smtLine",
            points: [
              { timestamp: d.p1.time * 1000, value: d.p1.price },
              { timestamp: d.p2.time * 1000, value: d.p2.price },
            ],
            lock: true,
            extendData: { correlate: d.label, direction: d.direction },
          });
          if (typeof id === "string") smtOverlayIdsRef.current.add(id);
        } catch {}
      }
    };

    // Live: small delay so the initial applyNewData settles, then poll every 30s
    // so freshly-formed swings appear without a reload. Replay: the `clock` dep
    // re-runs this effect on each tick, so just detect immediately (no polling).
    let first;
    let timer;
    if (isReplay) {
      detect();
    } else {
      first = setTimeout(detect, 400);
      timer = setInterval(detect, 30_000);
    }

    return () => {
      cancelled = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, smtEnabled, config.source, config.symbol, config.interval, isReplay, clock, activeTargetDate]);

  // Remove SMT overlays + reset caches when the instrument, SMT toggle, or replay
  // mode changes (NOT on every clock tick — the detector effect above handles
  // per-tick updates via signature diffing, keeping overlays alive across ticks).
  useEffect(() => {
    return () => {
      clearSmt();
      smtSigRef.current = "";
      smtCorrelateRef.current = { key: null, promise: null };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smtEnabled, config.source, config.symbol, config.interval, isReplay]);

  // ---- ICT Precision Swing Points (PSP) ----
  // Candle-level cousin of SMT: mark each swing candle on this instrument whose
  // CLOSE diverges from a correlate (NQ/ES/YM) — pivot high closing opposite is a
  // bearish PSP, pivot low a bullish PSP. Detection is computed here (it needs the
  // correlate's candles) and pushed into the PSP indicator via `extendData.byTime`.
  //
  // Lifecycle effect: create/remove the indicator on toggle, and reset it (and the
  // correlate cache) when the instrument or timeframe changes so stale markers
  // don't linger while the fresh set is fetched.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    if (!pspEnabled) {
      try { chart.removeIndicator(MAIN_PANE, PSP_INDICATOR); } catch {}
      return;
    }
    try { chart.removeIndicator(MAIN_PANE, PSP_INDICATOR); } catch {}
    chart.createIndicator({ name: PSP_INDICATOR, extendData: { byTime: {} } }, true, { id: MAIN_PANE });
    // Freshly (re)created empty — force the detect effect to re-populate it rather
    // than short-circuit on a matching signature (which would leave it blank).
    pspSigRef.current = "";
    return () => {
      try { chart.removeIndicator(MAIN_PANE, PSP_INDICATOR); } catch {}
      pspSigRef.current = "";
      pspCorrelateRef.current = { key: null, promise: null };
    };
  }, [ready, pspEnabled, config.source, config.symbol, config.interval]);

  // Detection effect: fetch the correlate window (cached in replay, refetched live
  // so new bars show up), find diverging swing candles, and override the
  // indicator's data only when the marker set actually changes (avoids per-tick
  // thrash in replay). Both series are clipped to the clock in replay — never a
  // swing the trader couldn't have seen "as of" that moment.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || !pspEnabled) return;
    let cancelled = false;
    const correlates = SMT_TRIO.filter((s) => s !== config.symbol);

    // Returns true once the chart's candles are loaded (so the caller can stop
    // fast-retrying), false while they're still pending.
    const detect = async () => {
      if (cancelled) return true;
      const mainData = chart.getDataList?.() ?? [];
      if (!mainData.length) return false; // candles not loaded yet — retry soon
      let mainCandles = mainData.map((c) => ({
        time: Math.floor(c.timestamp / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      if (isReplay && clock != null) mainCandles = mainCandles.filter((c) => c.time <= clock);
      if (mainCandles.length < 3) return true;

      const asOf = isReplay ? (replayFetchEnd(activeTargetDate, config.interval) ?? undefined) : undefined;
      const key = `${isReplay ? "R" : "L"}|${config.source}|${config.symbol}|${config.interval}|${asOf ?? "latest"}`;
      if (pspCorrelateRef.current.key !== key) {
        const limit = isReplay ? replayLimit(config.interval) : Math.min(1000, mainData.length);
        pspCorrelateRef.current = {
          key,
          promise: Promise.all(
            correlates.map(async (sym) => {
              try {
                const cs = await fetchCandles(config.source, sym, config.interval, limit, asOf);
                return { symbol: sym, candles: cs };
              } catch { return null; }
            })
          ),
        };
      }
      const cors = (await pspCorrelateRef.current.promise).filter(Boolean);
      if (cancelled || !chartRef.current) return true;

      const corSeries = cors.map((cor) => {
        let candles = cor.candles;
        if (isReplay && clock != null) candles = candles.filter((c) => c.time <= clock);
        return { label: SMT_LABEL[cor.symbol] ?? cor.symbol, candles };
      });
      const marks = detectPsp(mainCandles, corSeries);

      const sig = marks.map((m) => `${m.time}${m.direction[0]}${m.labels.join("")}`).join("~");
      if (sig === pspSigRef.current) return true;
      pspSigRef.current = sig;

      const byTime = {};
      for (const m of marks) byTime[m.time] = { direction: m.direction, labels: m.labels };
      // Re-create (rather than overrideIndicator) so the new markers reliably
      // repaint: an extendData override alone doesn't force a redraw on a static
      // chart, so the markers could stay invisible until the user panned/zoomed.
      try {
        chartRef.current.removeIndicator(MAIN_PANE, PSP_INDICATOR);
        chartRef.current.createIndicator({ name: PSP_INDICATOR, extendData: { byTime } }, true, { id: MAIN_PANE });
      } catch {}
      return true;
    };

    let timer;
    let cancelledLocal = false;
    if (isReplay) {
      // Replay re-runs this effect every clock tick (via deps), so a single pass is
      // enough — no polling.
      detect();
    } else {
      // Live: retry quickly until the candles have loaded and markers are drawn,
      // then settle into a slow refresh. A fixed one-shot missed when the (sometimes
      // slow) candle/correlate fetch hadn't landed yet, leaving PSP blank.
      let attempts = 0;
      const run = async () => {
        if (cancelledLocal) return;
        const ready2 = await detect();
        if (cancelledLocal) return;
        attempts += 1;
        // Once loaded, refresh correlates on the next slow tick so new bars show up.
        if (ready2) pspCorrelateRef.current = { key: null, promise: null };
        const delay = ready2 ? 30_000 : Math.min(5_000, 500 * attempts);
        timer = setTimeout(run, delay);
      };
      timer = setTimeout(run, 300);
    }

    return () => {
      cancelled = true;
      cancelledLocal = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pspEnabled, config.source, config.symbol, config.interval, isReplay, clock, activeTargetDate]);

  const toggleHtf = (htf) => {
    const next = htfs.includes(htf) ? htfs.filter((h) => h !== htf) : [...htfs, htf];
    onConfigChange({ ...config, htfs: next });
  };

  // ---- Trade markers: draw a marker for each of this symbol's trades ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    for (const tr of trades) {
      if (tr.symbol !== config.symbol || tr.time == null || markerIdsRef.current.has(tr.id)) continue;
      try {
        const id = chart.createOverlay({
          name: "simpleAnnotation",
          points: [{ timestamp: tr.time * 1000, value: tr.price }],
          extendData: tr.side === "buy" ? "B" : "S",
          lock: true,
        });
        if (id) markerIdsRef.current.set(tr.id, id);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, config.symbol, ready]);

  // Trade markers are anchored to this symbol; clear them when it changes.
  useEffect(() => {
    return () => {
      const chart = chartRef.current;
      if (!chart) return;
      for (const id of markerIdsRef.current.values()) {
        try { chart.removeOverlay(id); } catch {}
      }
      markerIdsRef.current.clear();
    };
  }, [config.symbol, isReplay]);

  // Backtest entry markers (redrawn whenever a run completes; capped for clarity).
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      for (const id of btMarkerIdsRef.current) {
        try { chart.removeOverlay(id); } catch {}
      }
      btMarkerIdsRef.current = [];
    }
    if (!chart || !ready || !btResult) return;
    for (const tr of btResult.trades.slice(0, 150)) {
      try {
        const id = chart.createOverlay({
          name: "simpleAnnotation",
          points: [{ timestamp: tr.entryTime * 1000, value: tr.entryPrice }],
          extendData: tr.side > 0 ? "▲" : "▼",
          lock: true,
        });
        if (id) btMarkerIdsRef.current.push(id);
      } catch {}
    }
  }, [btResult, ready]);

  // Drop backtest results when the instrument changes.
  useEffect(() => {
    setBtResult(null);
  }, [config.symbol, config.interval]);

  // ---- Drawing overlays ----
  const clearDrawings = () => {
    chartRef.current?.removeOverlay();
    overlayIdsRef.current = [];
    setDrawVersion((v) => v + 1);
    setMenu(null);
  };

  // Per-overlay delete: the position + fibonacci overlays render a small "×"
  // pill when selected. Clicking that pill dispatches a global
  // "tm:delete-overlay" event carrying the overlay id — we listen here, remove
  // the overlay from THIS pane's chart (silently no-ops if it lives on a
  // different pane's chart), and prune it from our tracking list.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    const onDelete = (e) => {
      const id = e.detail;
      try { chart.removeOverlay(id); } catch {}
      overlayIdsRef.current = overlayIdsRef.current.filter((x) => x !== id);
    };
    window.addEventListener("tm:delete-overlay", onDelete);
    return () => window.removeEventListener("tm:delete-overlay", onDelete);
  }, [ready]);

  const bumpDraw = () => setDrawVersion((v) => v + 1);

  // Back-fill a real timestamp on any anchor that landed in the blank area past the
  // last bar (KLineChart leaves those timestamp-less, anchored only by a raw bar
  // index that means nothing on another timeframe — the "drawing jumps left on a
  // lower timeframe" bug). Deferred to a microtask so we never re-enter KLineChart's
  // draw/press event mid-dispatch; runs before any replay/live tick could clobber
  // the point via updatePointPosition. See lib/overlayTimeCtx.fillMissingAnchorTimes.
  const anchorOverlayTimes = (overlay) => {
    if (!overlay?.id) return;
    const points = fillMissingAnchorTimes(overlay, paneId);
    if (!points) return;
    Promise.resolve().then(() => {
      try { chartRef.current?.overrideOverlay({ id: overlay.id, points }); } catch {}
    });
  };

  const startDraw = (overlayName) => {
    const chart = chartRef.current;
    if (!chart) return;
    // Object form so we can hook per-instance lifecycle callbacks: onDrawEnd
    // refreshes the delete list once the drawing is finished, and onRemoved keeps
    // our tracking list + the delete menu in sync no matter HOW the overlay goes
    // away (toolbar delete, on-chart × pill, clear-all, or klinecharts itself).
    const id = chart.createOverlay({
      name: overlayName,
      // Tag the overlay with its pane so the time-anchored tools can look up this
      // pane's loaded-bar window (see lib/overlayTimeCtx) and re-project anchors
      // that fall outside it when the timeframe changes.
      extendData: { paneId },
      onDrawEnd: (e) => { anchorOverlayTimes(e?.overlay); bumpDraw(); },
      // A drag can push an endpoint into the blank area past the last bar, which
      // re-strips its timestamp (same root cause as a draw click there) — re-anchor
      // on drag-end too so a dragged handle also survives timeframe switches.
      onPressedMoveEnd: (e) => { anchorOverlayTimes(e?.overlay); },
      onRemoved: () => {
        overlayIdsRef.current = overlayIdsRef.current.filter((x) => x !== id);
        bumpDraw();
      },
    });
    if (id) overlayIdsRef.current.push(id);
    bumpDraw();
    setMenu(null);
  };

  // Delete a single drawing by id. onRemoved (above) prunes the tracking list and
  // bumps, but we prune here too so the menu updates even if the callback is a
  // no-op for some overlay type.
  const deleteDrawing = (id) => {
    const chart = chartRef.current;
    try { chart?.removeOverlay(id); } catch {}
    overlayIdsRef.current = overlayIdsRef.current.filter((x) => x !== id);
    bumpDraw();
  };

  // Cancel any in-progress drawing (an armed but not-yet-finished overlay).
  // While a drawing is in progress, every click on the chart places the next
  // anchor instead of panning — so if the user forgets to finish, the chart
  // feels "stuck" (no pan). ESC (and clicking ✕ in the toolbar) drops the
  // pending overlay so click-drag pans again.
  const cancelPendingDraw = () => {
    const chart = chartRef.current;
    if (!chart) return false;
    for (const id of [...overlayIdsRef.current]) {
      const overlay = chart.getOverlayById?.(id);
      if (overlay?.isDrawing?.()) {
        try { chart.removeOverlay(id); } catch {}
        overlayIdsRef.current = overlayIdsRef.current.filter((x) => x !== id);
        return true;
      }
    }
    return false;
  };

  // Global ESC handler — cancels a pending drawing across every pane.
  useEffect(() => {
    if (!ready) return;
    const onKey = (e) => {
      if (e.key === "Escape") cancelPendingDraw();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Overlays are anchored to specific times/prices, so reset them when the
  // INSTRUMENT changes (a different symbol's price levels are meaningless). Do
  // NOT clear on a timeframe switch: a trendline drawn on 1h is still valid on
  // 15m/4h of the same instrument — klinecharts re-anchors overlays by their
  // timestamp+price, so they carry across timeframes (and through replay).
  useEffect(() => {
    clearDrawings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source, config.symbol]);

  const toggleIndicator = (name) => {
    const next = indicators.includes(name)
      ? indicators.filter((n) => n !== name)
      : [...indicators, name];
    onConfigChange({ ...config, indicators: next });
  };

  // Close menus on outside click.
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  // Current drawings on this pane, in draw order, for the delete menu. Recomputed
  // each render (drawVersion drives re-renders); we read live overlay objects so
  // ids that no longer exist are skipped, and index each tool type for clarity
  // ("Trend line 1", "Trend line 2", …).
  const drawings = (() => {
    const chart = chartRef.current;
    if (!chart) return [];
    const counts = {};
    const out = [];
    for (const id of overlayIdsRef.current) {
      const ov = chart.getOverlayById?.(id);
      if (!ov) continue;
      counts[ov.name] = (counts[ov.name] ?? 0) + 1;
      out.push({ id, label: OVERLAY_LABELS[ov.name] ?? ov.name, n: counts[ov.name] });
    }
    return out;
  })();

  return (
    <div className="pane">
      <div className="pane-header">
        <SymbolSearch
          source={config.source}
          value={config.symbol}
          onPick={(src, sym) => update({ source: src, symbol: sym })}
        />
        <select value={config.interval} onChange={(e) => update({ interval: e.target.value })}>
          {sourceDef.intervals.map((iv) => (
            <option key={iv} value={iv}>{iv}</option>
          ))}
        </select>

        <div className="tools" ref={menuRef}>
          <div className="menu-wrap">
            <button
              className="tool"
              title="Drawing tools"
              onClick={() => setMenu((m) => (m === "draw" ? null : "draw"))}
            >
              ✎
            </button>
            {menu === "draw" && (
              <div className="tool-menu">
                {DRAW_TOOLS.map((t) => (
                  <button key={t.id} className="menu-item" onClick={() => startDraw(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="menu-wrap">
            <button
              className={`tool${drawings.length ? " active" : ""}`}
              title="Delete drawings"
              onClick={() => setMenu((m) => (m === "drawings" ? null : "drawings"))}
            >
              ✕
            </button>
            {menu === "drawings" && (
              <div className="tool-menu">
                {drawings.length === 0 ? (
                  <div className="menu-item menu-empty">No drawings yet</div>
                ) : (
                  <>
                    <div className="menu-sep">Drawings</div>
                    {drawings.map((d) => (
                      <div key={d.id} className="menu-item draw-row">
                        <span className="draw-label">{d.label} {d.n}</span>
                        <button
                          className="draw-del"
                          title={`Delete ${d.label} ${d.n}`}
                          onClick={() => deleteDrawing(d.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button className="menu-item draw-clear" onClick={clearDrawings}>
                      Clear all
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="menu-wrap">
            <button
              className={`tool${indicators.length ? " active" : ""}`}
              title="Indicators"
              onClick={() => setMenu((m) => (m === "ind" ? null : "ind"))}
            >
              ƒ
            </button>
            {menu === "ind" && (
              <div className="tool-menu">
                {ALL_INDICATORS.map((name) => (
                  <label key={name} className="menu-item check">
                    <input
                      type="checkbox"
                      checked={indicators.includes(name)}
                      onChange={() => toggleIndicator(name)}
                    />
                    {name}
                    {SUB_INDICATORS.includes(name) ? " ·sub" : ""}
                  </label>
                ))}
                <div className="menu-sep">HTF candles</div>
                {HTF_OPTIONS.map((htf) => (
                  <label key={htf} className="menu-item check">
                    <input
                      type="checkbox"
                      checked={htfs.includes(htf)}
                      onChange={() => toggleHtf(htf)}
                    />
                    {htf.toUpperCase()} candles
                  </label>
                ))}
                <label
                  className="menu-item check"
                  title={
                    SMT_TRIO.includes(config.symbol)
                      ? "Show correlated NQ/ES/YM direction badges; amber = SMT divergence"
                      : "SMT works on NQ.c.0 / ES.c.0 / YM.c.0 — pick one of those first"
                  }
                >
                  <input
                    type="checkbox"
                    checked={!!config.smt}
                    disabled={!SMT_TRIO.includes(config.symbol)}
                    onChange={() => onConfigChange({ ...config, smt: !config.smt })}
                  />
                  SMT (NQ/ES/YM)
                </label>
                <label className="menu-item check" title="Shade ICT fair value gaps (3-candle imbalances), extended 2 candles forward">
                  <input
                    type="checkbox"
                    checked={!!config.fvg}
                    onChange={() => onConfigChange({ ...config, fvg: !config.fvg })}
                  />
                  Fair value gaps
                </label>
                <label className="menu-item check" title="ICT Change in State of Delivery — marks the open level reclaimed/broken when delivery flips bullish/bearish">
                  <input
                    type="checkbox"
                    checked={!!config.cisd}
                    onChange={() => onConfigChange({ ...config, cisd: !config.cisd })}
                  />
                  Change in state of delivery
                </label>
                <label
                  className="menu-item check"
                  title={
                    SMT_TRIO.includes(config.symbol)
                      ? "ICT Precision Swing Point — marks swing candles that close opposite to a correlated index (NQ/ES/YM)"
                      : "PSP works on NQ.c.0 / ES.c.0 / YM.c.0 — pick one of those first"
                  }
                >
                  <input
                    type="checkbox"
                    checked={!!config.psp}
                    disabled={!SMT_TRIO.includes(config.symbol)}
                    onChange={() => onConfigChange({ ...config, psp: !config.psp })}
                  />
                  PSP (precision swing point)
                </label>
              </div>
            )}
          </div>
          <div className="menu-wrap">
            <button
              className="tool"
              title="Paper trade"
              onClick={() => setMenu((m) => (m === "trade" ? null : "trade"))}
            >
              $
            </button>
            {menu === "trade" && (
              <div className="tool-menu">
                <TradePanel symbol={config.symbol} />
              </div>
            )}
          </div>
          {POSITION_TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool tool-${t.cls}`}
              title={t.label}
              onClick={() => startDraw(t.id)}
            >
              {t.glyph}
            </button>
          ))}
          <button
            className="tool tool-trend"
            title="Trend line"
            onClick={() => startDraw("trendLine")}
          >
            ╱
          </button>
          <button
            className="tool tool-range"
            title="Date & price range"
            onClick={() => startDraw("datePriceRange")}
          >
            ⤢
          </button>
          <div className="menu-wrap">
            <button
              className={`tool${btResult ? " active" : ""}`}
              title="Strategy backtest"
              onClick={() => setMenu((m) => (m === "backtest" ? null : "backtest"))}
            >
              Σ
            </button>
            {menu === "backtest" && (
              <div className="tool-menu">
                <BacktestPanel
                  source={config.source}
                  symbol={config.symbol}
                  interval={config.interval}
                  onResult={setBtResult}
                />
              </div>
            )}
          </div>
        </div>

        {stale && (
          <span className="stale-badge" title="No recent data — market may be closed">
            closed
          </span>
        )}
        <TickerBar price={price} />
      </div>
      <div className="chart-host" ref={hostRef}>
        {loading && (
          <div className="pane-loading" role="status" aria-live="polite">
            <div className="pane-loading-spinner" />
            <div className="pane-loading-label">
              Loading {config.symbol}<span className="pane-loading-sub"> · {config.source} · {config.interval}</span>
            </div>
          </div>
        )}
        {error && <div className="pane-error">{error}</div>}
        {/* Y-axis reset + unstick: returns to the default zoom / scroll /
            autoscale AND cancels any pending drawing + re-enables scroll+zoom
            in case they got flipped off. One-click recovery from any stuck
            state — armed drawing tool, manual y-scale drag, disabled scroll. */}
        <button
          type="button"
          className="reset-view"
          title="Reset chart & unstick (cancel drawing, re-enable pan/zoom)"
          aria-label="Reset chart and unstick"
          onClick={() => {
            // Cancel any drawing that's still waiting for anchor clicks —
            // otherwise all subsequent chart clicks are anchor placements, not
            // pans, and mouse drag can't move the chart.
            cancelPendingDraw();
            // Belt-and-braces: force scroll + zoom back on regardless of
            // whatever state the chart is in. Nothing external should ever be
            // turning these off, but this closes the loop if they do.
            const chart = chartRef.current;
            if (chart) {
              try { chart.setScrollEnabled(true); } catch {}
              try { chart.setZoomEnabled(true); } catch {}
            }
            resetView();
          }}
        >
          ⤾
        </button>
      </div>
    </div>
  );
}
