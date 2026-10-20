# TradeMatrix

A locally-run dashboard showing a configurable number of live trading charts
(1, 2, 4, 6, or 8) in a responsive split-screen grid. Each pane independently
picks a data source, symbol, and timeframe. Live crypto comes from **Hyperliquid**
(websocket); live Indian stocks come from **yfinance** (polling).

- **Frontend:** React + Vite + [KLineChart](https://klinecharts.com) v9 (built-in indicators + drawing tools)
- **Backend:** FastAPI — bridges every data source behind one uniform interface
- Per-pane **unified symbol search** — one box searches *all* sources at once
  (Hyperliquid's full coin universe + Yahoo's global symbols), each result tagged
  with its source; picking one sets the source automatically. Plus an independent
  timeframe selector, a colour-coded ticker that flashes green/red on each price
  change, and layout + selections persisted across reloads.
- **Drawing tools & indicators** per pane (powered by KLineChart): the `✎` menu
  has trend line, horizontal/ray/price lines, Fibonacci and rectangle; `✕` clears
  drawings; the `ƒ` menu toggles MA/EMA/BOLL overlays and VOL/MACD/RSI/KDJ sub-pane
  indicators. Indicator selections persist; drawings reset on instrument/timeframe
  change.
- **ICT HTF candles** (inspired by fadi's indicator): the `ƒ` menu can stack
  higher-timeframe candle panels (1H / 4H / 1D) in the right margin of any pane,
  fetched from the backend and aligned to the price axis.
- **Resizable panes** — drag the dividers between charts; sizes persist per layout.
- **Bar replay** — the toolbar's Replay mode steps the whole dashboard through history
  on one synced clock (as-of date, play/pause, 1×–10× speed, step, scrubber); every
  pane reveals candles up to the clock.
- **Paper trading** — a simulated account (the `$` per-pane panel): buy/sell/flat at
  the current price (replay or live), long/short with netted realized + unrealized
  P&L, on-chart trade markers, and a toolbar account summary with equity, P&L and an
  equity-curve sparkline.
- **Strategy backtests** — the `Σ` per-pane panel runs built-in strategies (SMA/EMA
  crossover, RSI mean-reversion, Donchian breakout) with editable params over a
  window of the instrument, reporting return, win rate, max drawdown, profit factor
  and an equity curve, with entry markers on the chart. Runs client-side (next-bar
  fills, fees, no look-ahead).

## Architecture

All data flows through the backend behind a single abstraction (`backend/sources/base.py`).
Live candles and (future) market-replay candles share **one `Candle` shape and one
websocket message schema**, so the frontend renders them identically — only the
producer differs.

**Add a new broker** (Alpaca, Binance, Zerodha, Polygon, …):
1. Create `backend/sources/<broker>.py` implementing `DataSource`.
2. Register one instance in `backend/data_source.py`.

## Run

Two processes. **Backend first:**

```bash
cd backend
./run.sh                # creates .venv, installs deps, serves on :1030
```

`run.sh` auto-sets `LD_LIBRARY_PATH` for `libstdc++` so numpy/pandas wheels work on
NixOS. It listens on all interfaces so the backend can be reached through a
forwarded port. On other systems plain
`uvicorn main:app --reload --host 0.0.0.0 --port 1030` works after
`pip install -r requirements.txt`.

**Frontend:**

```bash
cd frontend
npm install
npm run dev             # serves on :5173, proxies /api and /ws to the backend
```

Open http://localhost:5173.

## Docker (single image)

A multi-stage `Dockerfile` builds the frontend to static assets and serves them
from the FastAPI backend — one image, one container, one port.

Recommended (named container, fixed port 8080, auto-restart):

```bash
docker compose up -d --build      # build + run
docker compose down               # stop
```

Or plain Docker:

```bash
docker build -t tradematrix:latest .
docker run --rm --name tradematrix -p 8080:8080 tradematrix:latest
```

Open http://localhost:8080. The API, websocket, and SPA are all served from the
same origin, so no proxy is needed in this mode. Container port is **8080**,
published on host port **8080** (change the left side of `8080:8080` in
`docker-compose.yml` if 8080 is taken).

## Notes

- **yfinance is polling, not streaming.** "Live" Indian-stock prices update on a timer
  and are only fresh during NSE market hours (09:15–15:30 IST); outside that you see
  the last close. Yahoo's intraday history is limited, so replaying dates outside its
  available window may return no candles; use a more recent date, a coarser interval,
  or a source with deeper history.
- All 8 panes share a single backend websocket (multiplexed by pane id).

## Roadmap

- **Market replay / backtesting:** the data layer is already designed for it. A
  `ReplaySession` will read history via the same `get_candles()` and emit over the
  same websocket schema at a controlled rate (play/pause/seek) — no live-mode code
  changes required.
