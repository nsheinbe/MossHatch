import { describe, expect, it } from "vitest";
import { liftChips, ROW_PX } from "./chipLayout";

const box = (x: number, y: number, row = 0) => ({ x, y, w: 220, h: 48, row });

describe("chip overlay layout", () => {
  it("keeps each chip's own row when nothing overlaps", () => {
    expect(liftChips([box(100, 500), box(400, 500, 1), box(700, 500)])).toEqual([0, ROW_PX, 0]);
  });
  it("lifts a chip that would land on one already placed (a koi sleeper among the eggs) until it is clear", () => {
    const lifts = liftChips([box(300, 500), box(330, 505), box(310, 498)]);
    expect(lifts).toEqual([0, ROW_PX, 2 * ROW_PX]);
    const rects = lifts.map((l, i) => { const b = [box(300, 500), box(330, 505), box(310, 498)][i]!; return { t: b.y - l - b.h, b: b.y - l }; });
    for (let i = 1; i < rects.length; i++) expect(rects[i]!.b).toBeLessThanOrEqual(rects[i - 1]!.t);
  });
  it("is bounded: a pile-up stops lifting after a few rows", () => {
    const lifts = liftChips(Array.from({ length: 9 }, () => box(300, 500)));
    expect(Math.max(...lifts)).toBe(4 * ROW_PX);
  });
});
