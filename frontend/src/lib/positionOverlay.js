import { registerOverlay } from "klinecharts";
import { correctOverlayX } from "./overlayTimeCtx";

// Long / Short position drawing tools, inspired by TradingView's tools of the
// same name. Three anchor clicks: entry, stop-loss, take-profit. The overlay
// paints a green profit zone (entry -> TP) and a red loss zone (entry -> SL)
// extending to the right edge. The only label is the overall risk:reward badge
// near the entry — everything else (per-level prices, %s, R-multiples) is left
// off deliberately to keep the tool uncluttered.

// ---- Theme ----
const PROFIT_FILL = "rgba(38, 166, 154, 0.20)";
const LOSS_FILL = "rgba(239, 83, 80, 0.18)";
const PROFIT = "#26a69a";
const LOSS = "#ef5350";
const ENTRY = "#aeb6c2";
const TEXT_ON_COLOR = "#0e1117";
const RR_GOOD = "#26a69a";   // R:R >= 2 — attractive setup
const RR_OK = "#f0b90b";     // R:R between 1 and 2 — marginal
const RR_BAD = "#ef5350";    // R:R < 1 — risking more than the reward

// Overlay IDs currently selected — used to conditionally render the per-overlay
// delete button. Populated by onSelected / cleared by onDeselected inside the
// template below. Module-scoped, since the template registers once at module
// load. Cross-pane clicks flow through the "tm:delete-overlay" DOM event that
// ChartPane listens for.
const selectedIds = new Set();

function rrColor(rr) {
  if (!Number.isFinite(rr) || rr <= 0) return RR_BAD;
  if (rr >= 2) return RR_GOOD;
  if (rr >= 1) return RR_OK;
  return RR_BAD;
}

// ---- Helpers ----
function num(n, p = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: p, maximumFractionDigits: p });
}

/**
 * Choose decimal places automatically based on price magnitude so the label
 * looks right for both large-price assets (equities, BTC) and micro-price ones
 * (cheap alts, FX pips). Mirrors common charting-platform conventions:
 *   >= 1000  → 2 dp   (e.g. 4 521.75)
 *   >= 10    → 2 dp   (e.g. 47.23)
 *   >= 1     → 4 dp   (e.g. 1.2345)
 *   >= 0.01  → 5 dp
 *   otherwise→ 6 dp
 */
function autoDecimals(price) {
  const abs = Math.abs(price);
  if (!Number.isFinite(abs) || abs === 0) return 2;
  if (abs >= 1000) return 2;
  if (abs >= 10)   return 2;
  if (abs >= 1)    return 4;
  if (abs >= 0.01) return 5;
  return 6;
}

/** A pill anchored at the LEFT of the entry zone — used for the R:R badge. */
function pillLeft(xLeft, y, text, color, bg, opts = {}) {
  return {
    type: "text",
    ignoreEvent: true,
    attrs: {
      x: xLeft + 4,
      y,
      text,
      align: "left",
      baseline: opts.baseline ?? "middle",
    },
    styles: {
      color,
      backgroundColor: bg,
      borderColor: bg,
      borderRadius: 4,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 3,
      paddingBottom: 3,
      size: opts.size ?? 11,
      weight: opts.bold ? "bold" : "normal",
    },
  };
}

function makeTemplate(name) {
  return {
    name,
    totalStep: 5, // 4 clicks (entry, SL, TP, right-edge) + finalised state
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,

    // When the user drags the 4th anchor (the right-edge handle) we don't want its
    // y to matter — it's a horizontal-extent handle. Keep it snapped to the entry
    // line so it visually looks like a right edge, and only let x change.
    performEventPressedMove: ({ points, performPointIndex }) => {
      if (performPointIndex === 3 && points[0] && points[3]) {
        points[3] = { ...points[3], value: points[0].value };
      }
    },
    performEventMoveForDrawing: ({ currentStep, points, performPoint }) => {
      // While the user is picking the 4th click, preview it snapped to entry's y.
      if (currentStep === 4 && points[0]) {
        return { ...performPoint, value: points[0].value };
      }
      return performPoint;
    },

    onSelected: ({ overlay }) => {
      selectedIds.add(overlay.id);
      return false;
    },
    onDeselected: ({ overlay }) => {
      selectedIds.delete(overlay.id);
      return false;
    },
    onClick: ({ figureKey, overlay }) => {
      if (figureKey === "delete") {
        try {
          window.dispatchEvent(new CustomEvent("tm:delete-overlay", { detail: overlay.id }));
        } catch {}
        return true;
      }
      return false;
    },
    onRemoved: ({ overlay }) => {
      selectedIds.delete(overlay.id);
      return false;
    },

    createPointFigures: ({ coordinates, bounding, overlay, barSpace }) => {
      if (coordinates.length < 3) return [];
      // Re-project each anchor's x from its true timestamp so switching timeframe
      // (esp. in replay) doesn't collapse the right-edge handle onto the entry —
      // which used to make xRight fall back to the full chart width, i.e. the zone
      // "extending to infinity". In-window anchors are unchanged.
      const [entry, sl, tp, edge] = correctOverlayX(overlay, coordinates, barSpace);
      const entryPrice = overlay.points[0]?.value ?? 0;
      const slPrice = overlay.points[1]?.value ?? 0;
      const tpPrice = overlay.points[2]?.value ?? 0;

      const xLeft = entry.x;
      // Right edge = the 4th anchor if placed, else the chart edge while user's
      // still drawing. Also fall back to the chart edge if they dragged it left
      // of the entry, so the box doesn't invert.
      const xRight = edge && edge.x > xLeft ? edge.x : bounding.width;
      const rectW = Math.max(0, xRight - xLeft);

      const profitTop = Math.min(entry.y, tp.y);
      const profitH = Math.abs(entry.y - tp.y);
      const lossTop = Math.min(entry.y, sl.y);
      const lossH = Math.abs(entry.y - sl.y);

      const risk = Math.abs(entryPrice - slPrice);
      const reward = Math.abs(tpPrice - entryPrice);
      const rr = risk > 0 ? reward / risk : 0;

      // Per-overlay delete pill — visible only while this overlay is selected.
      // Sits just above the highest of entry/tp/sl at the right edge. Clicking it
      // fires the global "tm:delete-overlay" event that ChartPane routes back to
      // the chart.
      const showDelete = selectedIds.has(overlay.id);
      const topY = Math.min(entry.y, tp.y, sl.y);
      const deleteFig = showDelete ? [{
        type: "text",
        key: "delete",
        attrs: {
          x: xRight - 6,
          y: topY - 16,
          text: "×",
          align: "right",
          baseline: "middle",
        },
        styles: {
          color: "#ffffff",
          backgroundColor: "#ef5350",
          borderColor: "#ef5350",
          borderRadius: 10,
          paddingLeft: 7,
          paddingRight: 7,
          paddingTop: 2,
          paddingBottom: 2,
          size: 13,
          weight: "bold",
        },
      }] : [];

      return [
        ...deleteFig,
        // --- Filled zones (visual only) ---
        {
          type: "rect",
          ignoreEvent: true,
          attrs: { x: xLeft, y: profitTop, width: rectW, height: profitH },
          styles: { style: "fill", color: PROFIT_FILL },
        },
        {
          type: "rect",
          ignoreEvent: true,
          attrs: { x: xLeft, y: lossTop, width: rectW, height: lossH },
          styles: { style: "fill", color: LOSS_FILL },
        },

        // --- Horizontal lines (these carry the drag hit-test) ---
        {
          type: "line",
          attrs: { coordinates: [{ x: xLeft, y: entry.y }, { x: xRight, y: entry.y }] },
          styles: { color: ENTRY, size: 1, style: "dashed", dashedValue: [4, 3] },
        },
        {
          type: "line",
          attrs: { coordinates: [{ x: xLeft, y: tp.y }, { x: xRight, y: tp.y }] },
          styles: { color: PROFIT, size: 1.5 },
        },
        {
          type: "line",
          attrs: { coordinates: [{ x: xLeft, y: sl.y }, { x: xRight, y: sl.y }] },
          styles: { color: LOSS, size: 1.5 },
        },

        // --- Overall risk:reward badge + TP/SL price labels ---
        // R:R badge on entry line. Colour-coded: green ≥ 2 (attractive),
        // amber 1..2 (marginal), red < 1 (bad). "1:X" is the traditional
        // trader shorthand (risk 1 to make X).
        // TP and SL prices sit on their own lines as left-anchored pills in
        // the same font size so the trader can read the exact levels at a glance
        // without needing to hover the anchor point.
        pillLeft(
          xLeft,
          entry.y,
          `R:R 1:${num(rr, rr >= 10 ? 1 : 2)}`,
          TEXT_ON_COLOR,
          rrColor(rr),
          { bold: true, size: 11 }
        ),
        pillLeft(
          xLeft,
          tp.y,
          `TP ${num(tpPrice, autoDecimals(tpPrice))}`,
          TEXT_ON_COLOR,
          PROFIT,
          { bold: true, size: 11 }
        ),
        pillLeft(
          xLeft,
          sl.y,
          `SL ${num(slPrice, autoDecimals(slPrice))}`,
          TEXT_ON_COLOR,
          LOSS,
          { bold: true, size: 11 }
        ),
      ];
    },
  };
}

let registered = false;
export function registerPositionOverlays() {
  if (registered) return;
  registered = true;
  registerOverlay(makeTemplate("longPosition"));
  registerOverlay(makeTemplate("shortPosition"));
}
