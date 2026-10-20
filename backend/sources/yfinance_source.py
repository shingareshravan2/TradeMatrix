from __future__ import annotations

import asyncio
import datetime
import time
from typing import AsyncIterator

import yfinance as yf

from models import Candle
from sources.base import DataSource

# Approx seconds per canonical interval, for computing a start date from an `end`.
_INTERVAL_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900,
    "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400,
}

# Yahoo's max history per NATIVE interval (days). Intraday is heavily capped; daily+
# is effectively unlimited.
_YAHOO_MAX_DAYS = {"1m": 7, "5m": 60, "15m": 60, "30m": 60, "60m": 730, "1d": 100000}


def _period_days(interval: str, native: str, limit: int) -> int:
    """Calendar days to request so `limit` bars are available (with a buffer for
    weekends/holidays), capped by Yahoo's history limit for that native interval."""
    sec = _INTERVAL_SECONDS.get(interval, 60)
    need = int(sec * limit * 1.7 / 86400) + 2
    return max(2, min(need, _YAHOO_MAX_DAYS.get(native, 100000)))

# Canonical interval -> (history period, poll cadence seconds, Yahoo native interval,
# resample rule | None). Canonical labels are shared with every source. Yahoo lacks
# 3m and 4h, so we fetch a finer native interval and resample. Yahoo's "1h" is "60m".
# Intraday history is limited by Yahoo (e.g. 1m only ~7 days), so periods are conservative.
_INTERVAL_CFG = {
    "1m": ("5d", 5, "1m", None),
    "3m": ("5d", 10, "1m", "3min"),
    "5m": ("1mo", 15, "5m", None),
    "15m": ("1mo", 30, "15m", None),
    "30m": ("3mo", 60, "30m", None),
    "1h": ("6mo", 120, "60m", None),
    "4h": ("2y", 300, "60m", "4h"),
    "1d": ("2y", 300, "1d", None),
}


def _df_to_candles(df) -> list[Candle]:
    candles: list[Candle] = []
    for ts, row in df.iterrows():
        candles.append(
            Candle(
                time=int(ts.timestamp()),
                open=float(row["Open"]),
                high=float(row["High"]),
                low=float(row["Low"]),
                close=float(row["Close"]),
                volume=float(row.get("Volume", 0.0) or 0.0),
            )
        )
    return candles


class YFinanceSource(DataSource):
    name = "yfinance"
    intervals = list(_INTERVAL_CFG.keys())

    def list_symbols(self) -> list[str]:
        # NSE symbols use the .NS suffix; ^NSEI is the NIFTY 50 index.
        return ["RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "SBIN.NS", "^NSEI"]

    def _search(self, query: str) -> list[dict]:
        results = yf.Search(query, max_results=25).quotes
        out: list[dict] = []
        for q in results:
            sym = q.get("symbol")
            if not sym:
                continue
            name = q.get("shortname") or q.get("longname") or sym
            exch = q.get("exchange", "")
            out.append({"symbol": sym, "name": f"{name} ({exch})" if exch else name})
        return out

    async def search_symbols(self, query: str) -> list[dict]:
        if not query:
            return [{"symbol": s, "name": s} for s in self.list_symbols()]
        try:
            return await asyncio.to_thread(self._search, query)
        except Exception:
            return []

    def _fetch(self, symbol: str, interval: str, limit: int, end: int | None) -> list[Candle]:
        _, _, native, rule = _INTERVAL_CFG.get(interval, ("5d", 5, "1m", None))
        ticker = yf.Ticker(symbol)
        if end is None:
            # Period scales with the requested bar count (so the backtest can pull a
            # long window) while live/replay requests stay small.
            days = _period_days(interval, native, limit)
            df = ticker.history(period=f"{days}d", interval=native)
        else:
            # Fetch enough calendar days to cover the requested bars plus weekends
            # and holidays. Multiplying the bar duration by 3 was still too short
            # for small intraday requests ending on a weekend (e.g. 500 1m bars
            # started after the prior NSE session had closed).
            days = _period_days(interval, native, limit)
            end_dt = datetime.datetime.fromtimestamp(end, datetime.timezone.utc)
            start_dt = end_dt - datetime.timedelta(days=days)
            df = ticker.history(start=start_dt, end=end_dt, interval=native)
        if df.empty:
            return []
        if rule:
            df = (
                df.resample(rule, label="left", closed="left")
                .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
                .dropna(subset=["Open", "High", "Low", "Close"])
            )
        candles = _df_to_candles(df)
        return candles[-limit:]

    async def get_candles(
        self, symbol: str, interval: str, limit: int = 500, end: int | None = None
    ) -> list[Candle]:
        return await asyncio.to_thread(self._fetch, symbol, interval, limit, end)

    def _last_price(self, ticker) -> float | None:
        try:
            fi = ticker.fast_info
            p = None
            try:
                p = fi["lastPrice"]
            except Exception:
                p = getattr(fi, "last_price", None)
            return float(p) if p is not None else None
        except Exception:
            return None

    async def stream(self, symbol: str, interval: str) -> AsyncIterator[Candle]:
        _, bar_poll, _, _ = _INTERVAL_CFG.get(interval, ("5d", 5, "1m", None))
        ticker = yf.Ticker(symbol)
        last_bar: Candle | None = None
        next_refetch = 0.0
        while True:
            now = time.time()
            # Roll new bars on the interval cadence (full fetch + resample).
            if now >= next_refetch:
                try:
                    bars = await asyncio.to_thread(self._fetch, symbol, interval, 2, None)
                    if bars and (last_bar is None or bars[-1].time >= last_bar.time):
                        last_bar = bars[-1]
                        yield last_bar
                except Exception:
                    pass
                next_refetch = now + bar_poll
            # Lightweight price tick between bar rolls so the current bar moves live
            # during market hours (frozen when the market is closed — no new quote).
            price = await asyncio.to_thread(self._last_price, ticker)
            if price is not None and last_bar is not None and price != last_bar.close:
                last_bar = Candle(
                    time=last_bar.time,
                    open=last_bar.open,
                    high=max(last_bar.high, price),
                    low=min(last_bar.low, price),
                    close=price,
                    volume=last_bar.volume,
                )
                yield last_bar
            await asyncio.sleep(5)
