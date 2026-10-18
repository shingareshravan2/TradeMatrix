# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Two processes in dev. **Backend first:**

```bash
cd backend && ./run.sh      # venv + deps + uvicorn --reload on :1030
```

`run.sh` creates/reconciles `.venv`, sources `../.env` (for `DATABENTO_API_KEY`), and locates
`libstdc++`/`libz` in `/nix/store` for `LD_LIBRARY_PATH` so the numpy/pandas wheels work on NixOS.
Port is `${PORT:-1030}` — **not** 8000; the README's "uvicorn on :8000" is stale.

```bash
cd frontend && npm install && npm run dev   # :5173, proxies /api + /ws -> :1030
npm run build                               # -> frontend/dist
```

Single-image build (SPA served by FastAPI, no proxy): `docker compose up -d --build` → http://localhost:8080.
Cloud Run deploy steps live in `DEPLOY.md`.

Without `DATABENTO_API_KEY`, `DatabentoSource._client` is `None`: every futures request silently
returns `[]` and the startup prefetch logs "client not configured" and skips. The other two sources
need no credentials.

### Verification

There is no test suite and no linter. Changes are verified by driving the real app with the ad-hoc
Playwright scripts in `frontend/*.mjs`:

```bash
cd frontend && node shot.mjs /tmp/out.png databento NQ.c.0 15m
```

Each script seeds `localStorage` (`tm:chartCount`, `tm:panes`) via `addInitScript` *before* app code
runs, waits on specific `/api/candles` responses, then screenshots. They hardcode
`executablePath: "/run/current-system/sw/bin/brave"` — adjust for a different browser. `shot_smt.mjs`
polls a `window.__tmSmt` diagnostic that no longer exists in the app; that script's screenshots still
work but its diag output will be null.

## Architecture

### Backend: one interface, many brokers

`backend/sources/base.py` defines `DataSource` (`list_symbols`, `search_symbols`, `get_candles`,
`stream`). `backend/data_source.py`'s `REGISTRY` dict is the single plug point — adding a broker is a
new file in `sources/` plus one line there. Everything speaks one `Candle` dataclass
(`models.py`), whose `time` is **UNIX seconds**.

All three sources expose the *same canonical interval labels* (`1m 3m 5m 15m 30m 1h 4h 1d`) so the UI
is identical regardless of source. When an upstream lacks an interval, the source fetches a finer
native one and resamples — a new source should do the same rather than exposing its own vocabulary.

`main.py` routes: `GET /api/sources`, `GET /api/candles` (`limit` ≤ 5000, optional `end` in unix
seconds for history-as-of), `GET /api/search` (omit `source` to fan out across all sources
concurrently and tag each hit with its source). `StaticFiles` is mounted at `/` **last** so the API
and websocket routes win; it's absent in dev where Vite serves the SPA.

`WS /ws/stream` is **one socket for the whole app**, multiplexed by `paneId`. `StreamHub` holds one
asyncio task per pane; client sends `{action: "subscribe"|"unsubscribe", paneId, source, symbol,
interval}`, server replies `{paneId, candle}` or `{paneId, error}` (errors surface per-pane without
killing the socket).

Per-source specifics worth knowing before touching them:

- **databento** — historical only; `stream()` is a deliberate no-op generator (saves trial credits),
  so futures panes never tick live. Native OHLCV schemas are 1m/1h/1d only; everything else resamples
  with pandas. The "envelope" trick in `get_candles` makes every interval sharing a schema request the
  *same quantized window*, so one API call warms 3m/30m at once. 5m and 15m use narrower
  interval-specific windows. Windows are cached by
  `(symbol, schema, start_s, end_s)` in memory, pickled to `~/.cache/tradematrix/databento.pkl`
  (`TRADEMATRIX_CACHE_DIR`), and concurrent identical fetches coalesce onto one future. `end` is
  clamped to `now - 900s` because the historical feed lags real time (otherwise 422).
  `main.py`'s lifespan prefetches the curated symbol list at 1m/1h/1d (4-way concurrency) to warm
  those envelopes at boot.
- **yfinance** — polling, not streaming. `stream()` re-fetches bars on a per-interval cadence and
  interpolates a price tick every 5s in between; frozen outside NSE hours. Yahoo's intraday history
  is hard-capped per native interval (`_YAHOO_MAX_DAYS`).
- **hyperliquid** — the only true websocket feed; full coin universe for search via `/info` meta.

### Frontend: KLineChart v9, hand-built chart behaviour

Provider nesting in `App.jsx`: `StreamProvider` → `ReplayProvider` → `TradingProvider` → `ChartGrid`
→ up to 8 `ChartPane`s. All state that survives reloads lives in `localStorage`: `tm:chartCount`,
`tm:panes` (array of 8 pane configs `{source, symbol, interval, indicators[], htfs[], smt, fvg,
cisd, psp}`), `tm:sizes` (per-layout grid tracks), `tm:account`, `tm:replayBarPos`.

**Live and replay are two mutually exclusive feeds into the same chart instance.** `useCandleStream`
(`enabled: !isReplay`) loads 500 bars then subscribes to the websocket; `useReplayData`
(`enabled: isReplay`) loads one coordinated window and reveals bars as the clock advances. A pane's
chart object is created once by `useChart` and shared by both.

**Replay is a single global absolute wall-clock,** not per-pane playback. Each pane registers
`{interval, minTime, maxTime, times[]}` with `ReplayProvider`; `range` spans
`[max(pane starts), max(pane ends)]` so it sits where every pane has data. The clock ticks every
200ms by `finestSec × speed` and gap-skips to the next real bar (binary search over the union of
pane `times`) so non-24/7 markets don't crawl through dead overnight time. Every pane then reveals
bars with `time <= clock`, keeping all charts on the same moment. Replay windows are sized by
*duration* (`REPLAY_WINDOW_SEC`), not bar count, so switching timeframes keeps the same dates.

Two KLineChart conventions cause most of the historical bugs here, and both are load-bearing:

1. `applyNewData` auto-scrolls to the latest bar; `updateData` preserves the right-side offset. Use
   `applyNewData` only when the data set fundamentally changes (fetch landed, clock jumped backwards)
   and `updateData` for appends during play — see the long comment at `useReplayData.js:107`. Getting
   this backwards produces "candles freeze during play" / "chart won't pan".
2. KLineChart anchors an overlay point to the **nearest loaded bar, clamped** to the window — it never
   extrapolates. That's why cross-timeframe drawings used to collapse onto bar 0 or stretch to
   infinity. `lib/overlayTimeCtx.js` is the fix and its header comment is the full explanation:
   `ChartPane.refreshTimeCtx()` publishes each pane's `{firstTs, lastTs, msPerBar, times}` on every
   data change, custom overlays call `correctOverlayX()` inside `createPointFigures` to re-project x
   from the anchor's true timestamp, and `fillMissingAnchorTimes()` back-fills a real timestamp onto
   anchors clicked in the blank area past the last bar (KLineChart leaves those holding only a
   meaningless `dataIndex`). **Any new time-anchored overlay must do both.**

Custom chart extensions follow one pattern: a module-level `registerIndicator`/`registerOverlay` with
a `let registered` idempotence guard, called at `ChartPane` module load. Indicators that paint raw
canvas (`lib/htfIndicator.js`, `fvgIndicator`, `cisdIndicator`, `pspIndicator`) use
`figures: [], calc: () => []` and do everything in `draw`; data reaches them through `extendData`.
Note `pspIndicator` is re-created rather than `overrideIndicator`'d on data change — an `extendData`
override alone doesn't force a repaint on a static chart. Nearly every klinecharts call is wrapped in
`try {} catch {}` because anything thrown inside its render loop silently kills the frame.

Other cross-cutting pieces:

- `lib/kline.js` `toKline` is the **only** seconds→milliseconds converter; backend candles are
  seconds, KLineChart is ms. `INTERVAL_SECONDS` there is shared by the replay clock and window sizing.
- `lib/apiCache.js` is an in-memory LRU + in-flight dedup in front of `/api/candles` (60s TTL for
  latest, 24h when `end` is pinned). It is deliberately **not** persisted — an earlier localStorage
  version left stuck blobs that blocked fresh fetches.
- **SMT** (`smtDetect.js`, swing-price divergence) and **PSP** (`pspDetect.js`, swing-candle close
  divergence) only work on the `NQ.c.0`/`ES.c.0`/`YM.c.0` trio. In replay both fetch correlates
  "as of" `endTs` and clip both series to the clock, so they never draw a swing the trader couldn't
  have seen. Both diff a signature string before touching the chart, since their effects re-run on
  every 200ms tick.
- Paper trading is one global netted account keyed by symbol, marked from whatever price each pane
  last reported (live tick or replay candle) via `reportPrice`.
- Backtests run entirely client-side: `backtest/strategies.js` emits a target position per bar,
  `backtest/engine.js` fills the *previous* bar's target at the current bar's open (no look-ahead),
  all-in sizing, fees in bps.
- Chart timezone is locked to `Etc/GMT+4` (NY summer time year-round — the `Etc/GMT` sign is inverted
  by design, and this intentionally does not flip for DST). All dates render day/month/year via
  `makeFormatDate` in `useChart.js`.
- Several chart effects deliberately suppress `react-hooks/exhaustive-deps`; each has a comment
  explaining the omission (e.g. `coverSince` is excluded from `useReplayData` so drawing doesn't
  trigger a refetch on slow sources).

## Conventions

Commits are Conventional Commits with a scope drawn from the feature area
(`feat(charts):`, `fix(replay):`, `fix(drawings):`, `fix(htf):`).

The dense "why" comments in `overlayTimeCtx.js`, `useReplayData.js`, `apiCache.js`, and
`databento_source.py` encode bugs that were expensive to find. Treat them as regression
documentation — update rather than drop them when changing that code.
