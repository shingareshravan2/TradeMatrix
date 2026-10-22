import { useEffect } from "react";
import { fetchCandles, readInitialCandleSnapshot } from "../lib/api";
import { useStream } from "../ws/StreamProvider";

// Keep the initial load fast; scroll-back lazy-load pulls deeper history on demand.
// 500 gives the chart plenty to render on first paint (a few days of intraday) and
// scroll-back adds 500 more per batch. Was 1500 — dropping it cut typical Hyperliquid
// first-paint by ~2-3x and shaved Databento response-parse time noticeably.
const INITIAL_BARS = 500;

/**
 * Loads historical candles, then subscribes to live updates for this pane.
 * Reports raw backend candles (time in seconds) via `onHistory` (full array) and
 * `onUpdate` (single candle per tick); the consumer feeds them to the chart.
 * Re-runs on source/symbol/interval change and unsubscribes on unmount.
 */
export function useCandleStream({ paneId, source, symbol, interval, enabled = true, onHistory, onUpdate, onError, onLoading }) {
  const { subscribe, unsubscribe } = useStream();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function init() {
      onLoading?.(true);
      const snapshot = readInitialCandleSnapshot(source, symbol, interval, INITIAL_BARS);
      try {
        if (snapshot) onHistory?.(snapshot);
        const history = await fetchCandles(
          source,
          symbol,
          interval,
          INITIAL_BARS,
          undefined,
          snapshot ? (fresh) => {
            if (cancelled) return;
            onHistory?.(fresh);
            onError?.(null);
          } : undefined
        );
        if (cancelled) return;
        if (!snapshot) onHistory?.(history);
        onError?.(null);

        subscribe(paneId, { source, symbol, interval }, (msg) => {
          if (msg.error) {
            onError?.(msg.error);
            return;
          }
          if (msg.candle) onUpdate?.(msg.candle);
        });
      } catch (err) {
        if (!cancelled) onError?.(err.message || String(err));
      } finally {
        if (!cancelled) onLoading?.(false);
      }
    }

    init();
    return () => {
      cancelled = true;
      unsubscribe(paneId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, source, symbol, interval, enabled]);
}
