import { describe, expect, it } from "bun:test";
import { nextPopupPosition, type PopupMoveDirection } from "./popup-position";

const area = { x: -1600, y: 40, width: 1600, height: 1000 };
const anchors = {
  tl: { x: -1600, y: 40 }, tm: { x: -1000, y: 40 }, tr: { x: -400, y: 40 },
  c: { x: -1000, y: 340 },
  bl: { x: -1600, y: 640 }, bm: { x: -1000, y: 640 }, br: { x: -400, y: 640 },
} as const;

describe("popup snapping", () => {
  const routes = [
    ["tl", "tl", "bl", "tl", "tm"],
    ["tm", "tm", "c", "tl", "tr"],
    ["tr", "tr", "br", "tm", "tr"],
    ["c", "tm", "bm", "c", "c"],
    ["bl", "tl", "bl", "bl", "bm"],
    ["bm", "c", "bm", "bl", "br"],
    ["br", "tr", "br", "bm", "br"],
  ] as const;

  for (const [from, up, down, left, right] of routes) {
    const destinations = { up, down, left, right };
    for (const direction of ["up", "down", "left", "right"] satisfies PopupMoveDirection[]) {
      it(`${from} + ${direction} snaps to ${destinations[direction]}`, () => {
        const bounds = { ...anchors[from], width: 400, height: 400 };
        const next = nextPopupPosition(bounds, area, direction);
        expect(next).toEqual(anchors[destinations[direction]]);
      });
    }
  }

  it("uses the nearest anchor after manual dragging", () => {
    const bounds = { x: -1470, y: 65, width: 400, height: 400 };
    expect(nextPopupPosition(bounds, area, "right")).toEqual(anchors.tm);
  });

  it("rounds centered positions to whole pixels", () => {
    const bounds = { ...anchors.tl, width: 401, height: 401 };
    expect(nextPopupPosition(bounds, area, "right")).toEqual(anchors.tm);
  });

  it("pins oversized windows to the work area origin", () => {
    const bounds = { x: -2000, y: -100, width: 2000, height: 1200 };
    expect(nextPopupPosition(bounds, area, "down")).toEqual({ x: -1600, y: 40 });
  });
});
