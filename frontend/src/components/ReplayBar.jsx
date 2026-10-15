import React, { useCallback, useEffect, useRef, useState } from "react";
import { useReplay } from "../replay/ReplayProvider";

const SPEEDS = [1, 2, 4, 10];
const POS_KEY = "tm:replayBarPos";
const BAR_MARGIN = 8;

// Persist the floating bar's screen position so a refresh doesn't yank it back
// to the default corner. Falls back to a bottom-left anchor when there's no
// saved value (chosen because charts are usually centered and the top toolbar
// is busy).
function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.x === "number" && typeof p.y === "number") return p;
    }
  } catch {}
  return { x: 16, y: Math.max(80, (typeof window !== "undefined" ? window.innerHeight : 800) - 80) };
}

function fmt(ts) {
  if (ts == null) return "—";
  // Day/month/year with 24h time, matching the chart's date format.
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "dd/mm/yyyy" (UTC) <-> unix seconds, for the replay date text input.
function tsToDateInput(ts) {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
function dateInputToTs(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v || "").trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const t = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// The hidden native <input type=date> that backs the calendar button needs an
// ISO "YYYY-MM-DD" value; convert to/from it separately from the dd/mm/yyyy text.
function tsToNativeDate(ts) {
  if (ts == null) return "";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
function nativeDateToTs(v) {
  if (!v) return null;
  const t = new Date(v + "T00:00:00Z").getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export default function ReplayBar() {
  const {
    mode,
    setMode,
    playing,
    play,
    pause,
    speed,
    setSpeed,
    clock,
    range,
    displayTime,
    hasData,
    seek,
    stepBack,
    stepForward,
    targetDate,
    setTargetDate,
    endTs,
    setEndTs,
  } = useReplay();

  const activeDate = targetDate ?? endTs;
  const updateDate = setTargetDate ?? setEndTs;

  // Floating-bar drag state. Pointer events are used (unifies mouse + touch);
  // pointer capture keeps the drag alive even if the pointer leaves the handle.
  const barRef = useRef(null);
  const dragRef = useRef(null); // { dx, dy } offset from bar top-left at drag start
  const dateNativeRef = useRef(null); // hidden native date input behind the 📅 button
  const [pos, setPos] = useState(loadPos);

  // Local text for the replay date input so partial/invalid typing (e.g. "09/03/20")
  // isn't clobbered by a re-derived value; we only commit on a complete
  // date. Kept in sync when activeDate changes elsewhere.
  const [dateText, setDateText] = useState(() => tsToDateInput(activeDate));
  useEffect(() => { setDateText(tsToDateInput(activeDate)); }, [activeDate]);

  const clampPos = useCallback((x, y) => {
    const bar = barRef.current;
    const w = bar ? bar.offsetWidth : 200;
    const h = bar ? bar.offsetHeight : 40;
    const maxX = Math.max(BAR_MARGIN, (typeof window !== "undefined" ? window.innerWidth : 1200) - w - BAR_MARGIN);
    const maxY = Math.max(BAR_MARGIN, (typeof window !== "undefined" ? window.innerHeight : 800) - h - BAR_MARGIN);
    return { x: Math.min(Math.max(BAR_MARGIN, x), maxX), y: Math.min(Math.max(BAR_MARGIN, y), maxY) };
  }, []);

  // Keep the bar inside the viewport when the window is resized (dragging it to
  // the far right and then shrinking the window would otherwise strand it).
  useEffect(() => {
    if (mode !== "replay") return;
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mode, clampPos]);

  // Persist the last-known position; runs on every drop (pointerup writes pos,
  // React re-renders, this effect flushes to localStorage).
  useEffect(() => {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
  }, [pos]);

  const onHandleDown = (e) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };
  const onHandleMove = (e) => {
    if (!dragRef.current) return;
    const nx = e.clientX - dragRef.current.dx;
    const ny = e.clientY - dragRef.current.dy;
    setPos(clampPos(nx, ny));
  };
  const onHandleUp = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  if (mode !== "replay") {
    return (
      <button className="count-group" onClick={() => setMode("replay")} title="Bar replay">
        <span style={{ padding: "4px 12px" }}>⏎ Replay</span>
      </button>
    );
  }

  return (
    <div
      ref={barRef}
      className="replay-bar floating"
      style={{ left: pos.x, top: pos.y }}
      role="toolbar"
      aria-label="Replay controls"
    >
      <span
        className="rb-handle"
        title="Drag to move"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      >
        ⋮⋮
      </span>
      <button className="rb-btn rb-exit" onClick={() => setMode("live")} title="Back to live">
        ✕ Live
      </button>

      <label className="rb-label">Date</label>
      <div className="rb-date-wrap">
        <input
          type="text"
          className="rb-date"
          inputMode="numeric"
          placeholder="dd/mm/yyyy"
          maxLength={10}
          value={dateText}
          onChange={(e) => {
            const v = e.target.value;
            setDateText(v);
            if (v.trim() === "") { updateDate(null); return; }
            const ts = dateInputToTs(v);
            if (ts != null) updateDate(ts);
          }}
          title="Replay from date (dd/mm/yyyy; blank = latest)"
        />
        <button
          type="button"
          className="rb-btn rb-cal"
          title="Pick a date"
          onClick={() => {
            const el = dateNativeRef.current;
            if (!el) return;
            try { el.showPicker(); } catch { el.focus(); el.click(); }
          }}
        >
          📅
        </button>
        {/* Hidden native date input — provides the calendar popup for the button
            above; its value stays in sync with activeDate so the picker opens on the
            current replay date. */}
        <input
          ref={dateNativeRef}
          type="date"
          className="rb-date-native"
          tabIndex={-1}
          aria-hidden="true"
          value={tsToNativeDate(activeDate)}
          onChange={(e) => updateDate(nativeDateToTs(e.target.value))}
        />
      </div>

      <button className="rb-btn" onClick={stepBack} title="Step back">⏮</button>
      <button className="rb-btn rb-play" onClick={playing ? pause : play} title={playing ? "Pause" : "Play"}>
        {playing ? "⏸" : "▶"}
      </button>
      <button className="rb-btn" onClick={stepForward} title="Step forward">⏭</button>

      <div className="rb-speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`rb-spd${s === speed ? " active" : ""}`}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>

      <input
        type="range"
        className="rb-scrub"
        min={range ? range.start : 0}
        max={range ? range.end : 1}
        value={clock ?? (range ? range.start : 0)}
        onChange={(e) => seek(Number(e.target.value))}
        disabled={!hasData}
      />
      <span className="rb-clock">{fmt(displayTime)}</span>
    </div>
  );
}
