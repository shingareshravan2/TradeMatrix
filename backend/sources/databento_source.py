from __future__ import annotations

import asyncio
import atexit
import datetime
import logging
import os
import pickle
import tempfile
import threading
from pathlib import Path
from typing import AsyncIterator

import databento as db
import pandas as pd

from models import Candle
from sources.base import DataSource

_log = logging.getLogger("databento_source")
_log.setLevel(logging.INFO)
if not _log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
    _log.addHandler(_handler)
    _log.propagate = False

# Minimum lookback for intraday windows: enough to survive a long-weekend/holiday
# gap on the front month without being so wide that Databento has to return orders
# of magnitude more raw rows than the caller asked for.
_INTRADAY_MIN_WINDOW = 4 * 86400
# Start 1m requests with a compact window. If a gap leaves it short of the
# requested bars, retry with the wider weekend-safe window.
_ONE_MINUTE_MIN_WINDOW = 12 * 3600
_ONE_MINUTE_FALLBACK_WINDOW = 2 * 86400

# Path where the fetched-window cache is persisted across restarts. Small win in
# dev (survives auto-reload); big win in production (survives redeploy).
_CACHE_PATH = Path(os.environ.get("TRADEMATRIX_CACHE_DIR", "~/.cache/tradematrix")).expanduser() / "databento.pkl"
_CACHE_MAX_ENTRIES = 512
_CACHE_MAX_BYTES = 128 * 1024 * 1024

# Shared native-data windows for resampled intervals, scaled to the requested
# bar count. The 3m, 5m and 15m paths use smaller interval-specific windows instead.
_ENVELOPE_DAYS = {"ohlcv-1m": 40, "ohlcv-1h": 400}

# 3m, 5m and 15m windows are sized from the requested output bars instead of the
# larger shared 1m-schema envelope. The buffer accounts for weekends and sessions.
_RESAMPLE_WINDOW_BUFFER = 1.5

# Canonical interval -> (Databento native OHLCV schema, resample rule | None, seconds).
# Databento's native OHLCV schemas are 1m / 1h / 1d only; everything else resamples.
_INTERVAL_CFG = {
    "1m":  ("ohlcv-1m", None,    60),
    "3m":  ("ohlcv-1m", "3min",  180),
    "5m":  ("ohlcv-1m", "5min",  300),
    "15m": ("ohlcv-1m", "15min", 900),
    "30m": ("ohlcv-1m", "30min", 1800),
    "1h":  ("ohlcv-1h", None,    3600),
    "4h":  ("ohlcv-1h", "4h",    14400),
    "1d":  ("ohlcv-1d", None,    86400),
}

# Continuous front-month CME futures via `stype_in="continuous"` (equivalent to
# TradingView's NQ1! / ES1! / GC1! notation).
_SYMBOLS = [
    {"symbol": "NQ.c.0",  "name": "E-mini Nasdaq-100 (NQ1!)"},
    {"symbol": "ES.c.0",  "name": "E-mini S&P 500 (ES1!)"},
    {"symbol": "YM.c.0",  "name": "E-mini Dow (YM1!)"},
    {"symbol": "RTY.c.0", "name": "E-mini Russell 2000 (RTY1!)"},
    {"symbol": "GC.c.0",  "name": "Gold (GC1!)"},
    {"symbol": "SI.c.0",  "name": "Silver (SI1!)"},
    {"symbol": "CL.c.0",  "name": "Crude oil (CL1!)"},
    {"symbol": "HG.c.0",  "name": "Copper (HG1!)"},
    {"symbol": "NG.c.0",  "name": "Natural gas (NG1!)"},
]


class DatabentoSource(DataSource):
    name = "databento"
    intervals = list(_INTERVAL_CFG.keys())

    def __init__(self) -> None:
        key = os.environ.get("DATABENTO_API_KEY")
        self._client = db.Historical(key=key) if key else None
        # In-memory cache keyed by (symbol, schema, start_s, end_s) so the lazy-load
        # on scroll doesn't re-bill for the same window during a session.
        self._cache: dict[tuple[str, str, int, int], list[Candle]] = {}
        # Cache the dataset's available [start, end] per schema (refreshed every ~5 min).
        # Clamping both bounds prevents 422s when callers request a window that
        # extends past the available data on either side.
        self._dataset_range_cache: dict[str, tuple[float, int, int]] = {}
        # In-flight coalescing: when N callers ask for the same key at once, the
        # second..Nth `await` the first caller's Future instead of firing new
        # Databento requests.
        self._inflight: dict[tuple[str, str, int, int], asyncio.Future] = {}
        # Load anything a previous process left on disk, then arrange to write it
        # back on shutdown. Failure to load a stale/corrupt file is harmless.
        self._cache_lock = threading.Lock()
        self._dirty = False
        self._load_cache_from_disk()
        atexit.register(self._save_cache_to_disk)
        # Also autosave periodically so abrupt kills (SIGTERM, uvicorn --reload)
        # don't drop everything.
        self._autosave = threading.Thread(target=self._autosave_loop, daemon=True)
        self._autosave.start()

    def _autosave_loop(self) -> None:
        import time
        while True:
            time.sleep(300)  # 5 min
            if self._dirty:
                self._save_cache_to_disk()

    def _load_cache_from_disk(self) -> None:
        try:
            cache_size = _CACHE_PATH.stat().st_size
            if cache_size > _CACHE_MAX_BYTES:
                _log.warning(
                    "DBN cache load skipped: %s is %d bytes (limit %d); starting with an empty cache",
                    _CACHE_PATH,
                    cache_size,
                    _CACHE_MAX_BYTES,
                )
                return
            with _CACHE_PATH.open("rb") as fh:
                data = pickle.load(fh)
            if isinstance(data, dict):
                self._cache.update(data)
                _log.info("DBN cache loaded from disk: %d entries", len(self._cache))
        except FileNotFoundError:
            pass
        except Exception as exc:
            _log.warning("DBN cache load failed (%s): %s", type(exc).__name__, exc)

    def _save_cache_to_disk(self) -> None:
        if not self._dirty:
            return
        try:
            _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            # Write to a tempfile then rename so a crash mid-write doesn't leave
            # a truncated file behind for next boot.
            with self._cache_lock:
                snapshot = dict(self._cache)
            fd, tmp = tempfile.mkstemp(prefix="databento.", dir=_CACHE_PATH.parent)
            try:
                with os.fdopen(fd, "wb") as fh:
                    pickle.dump(snapshot, fh, protocol=pickle.HIGHEST_PROTOCOL)
                os.replace(tmp, _CACHE_PATH)
            except Exception:
                try: os.unlink(tmp)
                except FileNotFoundError: pass
                raise
            self._dirty = False
            _log.info("DBN cache saved to disk: %d entries", len(snapshot))
        except Exception as exc:
            _log.warning("DBN cache save failed (%s): %s", type(exc).__name__, exc)

    def _dataset_range(self, schema: str) -> tuple[int, int]:
        import time
        now = time.time()
        cached = self._dataset_range_cache.get(schema)
        if cached and now - cached[0] < 300:
            return cached[1], cached[2]
        if self._client is None:
            return 0, int(now) - 86400
        try:
            info = self._client.metadata.get_dataset_range(dataset="GLBX.MDP3")
            sch = info.get("schema", {}).get(schema, {})
            start_str = sch.get("start") or info.get("start")
            end_str = sch.get("end") or info.get("end")
            start_s = int(datetime.datetime.fromisoformat(start_str.replace("Z", "+00:00")).timestamp())
            end_s = int(datetime.datetime.fromisoformat(end_str.replace("Z", "+00:00")).timestamp())
        except Exception as exc:
            _log.warning(
                "Databento dataset-range lookup failed for %s (%s: %s); using a 15-minute availability buffer",
                schema,
                type(exc).__name__,
                exc,
            )
            start_s, end_s = 0, int(now) - 900
        self._dataset_range_cache[schema] = (now, start_s, end_s)
        return start_s, end_s

    def list_symbols(self) -> list[str]:
        return [s["symbol"] for s in _SYMBOLS]

    async def search_symbols(self, query: str) -> list[dict]:
        if not query:
            return [{"symbol": s["symbol"], "name": s["name"]} for s in _SYMBOLS]
        q = query.upper()
        return [
            {"symbol": s["symbol"], "name": s["name"]}
            for s in _SYMBOLS
            if q in s["symbol"].upper() or q in s["name"].upper()
        ]

    async def _fetch_window_coalesced(
        self, symbol: str, schema: str, start_s: int, end_s: int
    ) -> list[Candle]:
        """Async front-door around `_fetch_window` that dedupes concurrent duplicates."""
        key = (symbol, schema, start_s, end_s)
        # Fast path: already cached, skip the Databento thread hop.
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        inflight = self._inflight.get(key)
        if inflight is not None:
            # Someone else is already fetching this window — piggyback on their result.
            return await inflight
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._inflight[key] = fut
        try:
            candles = await asyncio.to_thread(self._fetch_window, symbol, schema, start_s, end_s)
            fut.set_result(candles)
            return candles
        except Exception as exc:
            fut.set_exception(exc)
            raise
        finally:
            self._inflight.pop(key, None)

    def _fetch_window(self, symbol: str, schema: str, start_s: int, end_s: int) -> list[Candle]:
        """Pull a (symbol, schema, [start, end]) window from Databento. Cached."""
        import time as _time
        t0 = _time.monotonic()
        if self._client is None:
            return []
        # Clamp [start, end] to what the dataset actually has available so requesting
        # more history than exists returns whatever's there instead of 422-ing.
        available_start, available_end = self._dataset_range(schema)
        t_meta = _time.monotonic() - t0
        if end_s > available_end:
            end_s = available_end - 60
        if start_s < available_start:
            start_s = available_start
        if start_s >= end_s:
            return []
        win_days = (end_s - start_s) / 86400
        key = (symbol, schema, start_s, end_s)
        cached = self._cache.get(key)
        if cached is not None:
            _log.info(
                "DBN[%s %s win=%.1fd cache=HIT] rows=%d -> %.3fs",
                symbol, schema, win_days, len(cached), _time.monotonic() - t0,
            )
            return cached
        try:
            start = datetime.datetime.fromtimestamp(start_s, datetime.timezone.utc)
            end = datetime.datetime.fromtimestamp(end_s, datetime.timezone.utc)
            t_api0 = _time.monotonic()
            for attempt in range(3):
                try:
                    data = self._client.timeseries.get_range(
                        dataset="GLBX.MDP3",
                        symbols=[symbol],
                        schema=schema,
                        start=start,
                        end=end,
                        stype_in="continuous",
                    )
                    break
                except db.BentoHttpError as exc:
                    retryable = exc.http_status in (408, 429) or exc.http_status >= 500
                    if not retryable or attempt == 2:
                        raise
                    try:
                        delay = min(2.0, max(0.0, float(exc.headers.get("Retry-After", ""))))
                    except (TypeError, ValueError):
                        delay = 0.5 * (2**attempt)
                    _log.warning(
                        "Databento request retry %d/2 for %s (%s, HTTP %d) in %.1fs",
                        attempt + 1,
                        symbol,
                        schema,
                        exc.http_status,
                        delay,
                    )
                    _time.sleep(delay)
            t_api = _time.monotonic() - t_api0
            t_df0 = _time.monotonic()
            df = data.to_df()
            t_df = _time.monotonic() - t_df0
            if df.empty:
                _log.info(
                    "DBN[%s %s win=%.1fd cache=MISS] meta=%.3f api=%.3f to_df=%.3f rows=0 -> %.3fs",
                    symbol, schema, win_days, t_meta, t_api, t_df, _time.monotonic() - t0,
                )
                return []
            t_conv0 = _time.monotonic()
            candles = [
                Candle(
                    time=int(ts.timestamp()),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row.get("volume", 0) or 0),
                )
                for ts, row in df.iterrows()
            ]
            t_conv = _time.monotonic() - t_conv0
            _log.info(
                "DBN[%s %s win=%.1fd cache=MISS] meta=%.3f api=%.3f to_df=%.3f conv=%.3f rows=%d -> %.3fs",
                symbol, schema, win_days, t_meta, t_api, t_df, t_conv, len(candles),
                _time.monotonic() - t0,
            )
        except Exception as exc:
            _log.error(
                "Databento fetch failed: symbol=%s schema=%s window=[%s, %s] err=%s: %s",
                symbol, schema,
                datetime.datetime.fromtimestamp(start_s, datetime.timezone.utc).isoformat(),
                datetime.datetime.fromtimestamp(end_s, datetime.timezone.utc).isoformat(),
                type(exc).__name__, exc,
            )
            raise RuntimeError(
                f"Databento fetch failed for {symbol} ({schema}): {type(exc).__name__}: {exc}"
            ) from exc
        # Bounded cache (drop the oldest half when full — insertion-ordered).
        with self._cache_lock:
            self._cache[key] = candles
            if len(self._cache) > _CACHE_MAX_ENTRIES:
                # drop the oldest half
                for k in list(self._cache.keys())[: _CACHE_MAX_ENTRIES // 2]:
                    del self._cache[k]
        self._dirty = True
        return candles

    def _recent_cached_window(
        self, symbol: str, schema: str, end_s: int
    ) -> list[Candle] | None:
        """Find recent native bars usable for an initial latest-window chart load."""
        with self._cache_lock:
            candidates = [
                candles
                for (cached_symbol, cached_schema, _, _), candles in self._cache.items()
                if cached_symbol == symbol
                and cached_schema == schema
                and candles
                and end_s - candles[-1].time <= 7 * 86400
                and candles[-1].time <= end_s + 60
            ]
        if not candidates:
            return None
        return max(candidates, key=lambda candles: (candles[-1].time, len(candles)))

    async def get_candles(
        self, symbol: str, interval: str, limit: int = 500, end: int | None = None
    ) -> list[Candle]:
        cfg = _INTERVAL_CFG.get(interval)
        if cfg is None or self._client is None:
            return []
        schema, rule, sec = cfg
        if end is not None:
            end_s = end
        else:
            # Databento's historical feed lags real time; requesting `end=now`
            # triggers 422 (data_end_after_available_end). 15-min clamp covers it.
            end_s = int(datetime.datetime.now(datetime.timezone.utc).timestamp()) - 900
        # Quantize end_s so "give me the latest 1500 bars" requests fired seconds
        # apart share a cache key (Databento is our expensive dependency — cache HIT
        # returns in ~microseconds). Resampled intervals quantize to the schema's
        # granularity; most also share a common envelope window.
        if rule:
            envelope_bucket = 60 if schema == "ohlcv-1m" else 3600
            end_s = (end_s // envelope_bucket) * envelope_bucket
            if interval in ("3m", "5m", "15m"):
                # These chart windows need far less 1m history than the shared
                # envelope used by 30m; avoid fetching and resampling excess rows.
                window = max(int(sec * limit * _RESAMPLE_WINDOW_BUFFER), _INTRADAY_MIN_WINDOW)
            else:
                window = max(
                    int(_ENVELOPE_DAYS[schema] * 86400 * limit / 1500),
                    _INTRADAY_MIN_WINDOW,
                )
        else:
            bucket = max(60, sec)
            end_s = (end_s // bucket) * bucket
            # CME futures trade ~23h/day, so gaps beyond weekends are rare. Tight
            # buffer keeps payloads small.
            buffer = 1.2
            wanted = int(sec * limit * buffer)
            min_window = _ONE_MINUTE_MIN_WINDOW if interval == "1m" else _INTRADAY_MIN_WINDOW
            window = max(wanted, min_window) if sec < 86400 else wanted + 86400
        start_s = end_s - window

        # A just-warmed native window can satisfy an initial chart request even
        # when it is shorter than the requested lookback. This avoids blocking a
        # timeframe switch on another upstream call; scroll-back still requests
        # the missing history with an explicit `end`.
        cached_recent = (
            self._recent_cached_window(symbol, schema, end_s)
            if end is None
            else None
        )
        candles = cached_recent or await self._fetch_window_coalesced(symbol, schema, start_s, end_s)
        if interval == "1m" and len(candles) < limit and window < _ONE_MINUTE_FALLBACK_WINDOW:
            start_s = end_s - _ONE_MINUTE_FALLBACK_WINDOW
            candles = await self._fetch_window_coalesced(symbol, schema, start_s, end_s)

        if rule and candles:
            df = pd.DataFrame(
                [
                    {"t": c.time, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume}
                    for c in candles
                ]
            )
            df["t"] = pd.to_datetime(df["t"], unit="s", utc=True)
            df = df.set_index("t")
            agg = (
                df.resample(rule, label="left", closed="left")
                .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
                .dropna(subset=["open", "high", "low", "close"])
            )
            candles = [
                Candle(
                    time=int(ts.timestamp()),
                    open=float(r["open"]),
                    high=float(r["high"]),
                    low=float(r["low"]),
                    close=float(r["close"]),
                    volume=float(r["volume"]),
                )
                for ts, r in agg.iterrows()
            ]
        return candles[-limit:]

    async def stream(self, symbol: str, interval: str) -> AsyncIterator[Candle]:
        # Historical-only — no live ticks (saves trial credits). The WS pump just exits.
        return
        yield  # pragma: no cover (marks this as an async generator)
