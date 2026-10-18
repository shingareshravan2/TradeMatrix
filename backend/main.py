from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from data_source import get_source, list_sources, search_all

_prefetch_log = logging.getLogger("prefetch")
_prefetch_log.setLevel(logging.INFO)
if not _prefetch_log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
    _prefetch_log.addHandler(_handler)
    _prefetch_log.propagate = False


async def _prefetch_databento() -> None:
    """Warm the Databento cache for the curated futures so the first user click on
    each doesn't pay the cold-fetch latency. Runs 4 requests concurrently with a
    semaphore — the old sequential-with-250ms-pause path took ~2 minutes to warm
    27 requests, which meant users hitting the app immediately after boot always
    paid the cold cost. 4 concurrent keeps under the trial-tier rate limits in
    practice and cuts total warmup to ~30s. Idempotent — piggybacks on the
    source's own cache + disk persistence."""
    try:
        from sources.databento_source import DatabentoSource, _SYMBOLS
    except Exception as exc:
        _prefetch_log.warning("Databento import failed, skipping prefetch: %s", exc)
        return
    src = get_source("databento")
    if not isinstance(src, DatabentoSource) or src._client is None:
        _prefetch_log.info("Databento client not configured — skipping prefetch")
        return

    # Prefetch native schemas: 1m warms 1m/3m/30m via the envelope, 1h warms 1h/4h
    # via its envelope, and 5m/15m use their own narrower windows.
    intervals = ("1m", "1h", "1d")
    jobs = [(entry["symbol"], iv) for entry in _SYMBOLS for iv in intervals]
    total = len(jobs)
    sem = asyncio.Semaphore(4)  # cap concurrency at 4 to stay under trial-tier limits
    done = 0

    async def one(sym: str, iv: str) -> None:
        nonlocal done
        async with sem:
            try:
                candles = await src.get_candles(sym, iv, limit=1500)
                done += 1
                _prefetch_log.info(
                    "PREFETCH ok %s %s (%d/%d) rows=%d", sym, iv, done, total, len(candles)
                )
            except Exception as exc:
                done += 1
                _prefetch_log.warning(
                    "PREFETCH fail %s %s (%d/%d): %s", sym, iv, done, total, exc
                )

    await asyncio.gather(*(one(sym, iv) for sym, iv in jobs), return_exceptions=True)
    _prefetch_log.info("PREFETCH done: %d requests", total)


@asynccontextmanager
async def lifespan(_: "FastAPI"):
    # Kick prefetch off in the background so startup returns immediately — the first
    # user paints may still be cold if they beat the warm-up, but the cache is
    # ready for the second click and beyond.
    task = asyncio.create_task(_prefetch_databento())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="TradeMatrix", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/sources")
def sources():
    return list_sources()


@app.get("/api/candles")
async def candles(
    source: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
    limit: int = Query(500, ge=1, le=5000),
    end: int | None = Query(None, description="unix seconds; return bars ending at/before this time"),
):
    src = get_source(source)
    data = await src.get_candles(symbol, interval, limit, end)
    return [c.to_dict() for c in data]


@app.get("/api/search")
async def search(query: str = Query(""), source: str | None = Query(None)):
    q = query.strip()
    if source:
        src = get_source(source)
        results = await src.search_symbols(q)
        for r in results:
            r["source"] = source
        return results
    return await search_all(q)


class StreamHub:
    """Manages one upstream subscription task per pane for a single client websocket."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.tasks: dict[str, asyncio.Task] = {}
        self.send_lock = asyncio.Lock()

    async def _safe_send(self, payload: dict):
        async with self.send_lock:
            await self.ws.send_text(json.dumps(payload))

    async def _pump(self, pane_id: str, source: str, symbol: str, interval: str):
        try:
            src = get_source(source)
            async for candle in src.stream(symbol, interval):
                await self._safe_send({"paneId": pane_id, "candle": candle.to_dict()})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # surface upstream errors to the client, keep socket alive
            await self._safe_send({"paneId": pane_id, "error": str(exc)})

    async def subscribe(self, pane_id: str, source: str, symbol: str, interval: str):
        await self.unsubscribe(pane_id)
        self.tasks[pane_id] = asyncio.create_task(
            self._pump(pane_id, source, symbol, interval)
        )

    async def unsubscribe(self, pane_id: str):
        task = self.tasks.pop(pane_id, None)
        if task:
            task.cancel()

    async def close(self):
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.tasks.clear()


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    hub = StreamHub(ws)
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")
            pane_id = str(msg.get("paneId"))
            if action == "subscribe":
                await hub.subscribe(pane_id, msg["source"], msg["symbol"], msg["interval"])
            elif action == "unsubscribe":
                await hub.unsubscribe(pane_id)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.close()


# Serve the built frontend (single-image deployment). Mounted LAST so the /api and
# /ws routes above take precedence. Absent in local dev, where Vite serves the SPA.
_DIST = os.environ.get("FRONTEND_DIST") or os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_DIST):
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
