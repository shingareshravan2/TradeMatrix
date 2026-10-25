import { registerOverlay } from "klinecharts";
import { correctOverlayX } from "./overlayTimeCtx";

const BORDER = "#26a69a";
const FILL = "rgba(38, 166, 154, 0.16)";

let registered = false;
export function registerRectangleOverlay() {
  if (registered) return;
  registered = true;
  registerOverlay({
    name: "rectangle",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,

    createPointFigures: ({ coordinates, overlay, barSpace }) => {
      if (coordinates.length < 2) return [];
      const [p1, p2] = correctOverlayX(overlay, coordinates, barSpace);
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      return [{
        type: "rect",
        attrs: {
          x,
          y,
          width: Math.abs(p2.x - p1.x),
          height: Math.abs(p2.y - p1.y),
        },
        styles: {
          style: "stroke_fill",
          color: FILL,
          borderColor: BORDER,
          borderSize: 1,
        },
      }];
    },
  });
}
