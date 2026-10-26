// Partial KLineChart v9 style overrides for a dark theme (merged with defaults).
const GRID = "#21262d";
const AXIS = "#2a3038";
const TEXT = "#8b949e";
const UP = "#4caf50";
const DOWN = "#ffee58";

export const CHART_STYLES = {
  grid: {
    horizontal: { color: GRID },
    vertical: { color: GRID },
  },
  candle: {
    bar: {
      upColor: UP,
      downColor: DOWN,
      noChangeColor: "#888888",
      upBorderColor: UP,
      downBorderColor: DOWN,
      noChangeBorderColor: "#888888",
      upWickColor: UP,
      downWickColor: DOWN,
      noChangeWickColor: "#888888",
    },
    priceMark: {
      high: { color: TEXT },
      low: { color: TEXT },
      last: {
        upColor: UP,
        downColor: DOWN,
        noChangeColor: "#888888",
        text: { color: "#ffffff" },
      },
    },
    tooltip: { text: { color: TEXT } },
  },
  indicator: {
    tooltip: { text: { color: TEXT } },
  },
  xAxis: {
    axisLine: { color: AXIS },
    tickLine: { color: AXIS },
    tickText: { color: TEXT },
  },
  yAxis: {
    axisLine: { color: AXIS },
    tickLine: { color: AXIS },
    tickText: { color: TEXT },
  },
  crosshair: {
    horizontal: {
      line: { color: TEXT },
      text: { backgroundColor: AXIS, borderColor: AXIS, color: "#fff" },
    },
    vertical: {
      line: { color: TEXT },
      text: { backgroundColor: AXIS, borderColor: AXIS, color: "#fff" },
    },
  },
  separator: { color: AXIS },
};
