import { describe, expect, it } from "vitest";
import { CARD, CARD_ASPECT, captionLines, ellipsize, fitTitleSize, portraitFraming } from "./portrait";

const box = (w: number, h: number, d: number, at = { x: 0, y: 0, z: 0 }) => ({ min: { x: at.x - w / 2, y: at.y, z: at.z - d / 2 }, max: { x: at.x + w / 2, y: at.y + h, z: at.z + d / 2 } });
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("portrait framing (the first live card clipped the ears and the lantern, and put grass over the feet)", () => {
  it("backs off with the creature's size, so a tall or a wide creature both fit with the same margin", () => {
    const small = portraitFraming(box(0.6, 0.9, 0.5), 0, CARD.w / CARD.h);
    const tall = portraitFraming(box(0.6, 1.8, 0.5), 0, CARD.w / CARD.h);
    const wide = portraitFraming(box(2.4, 0.9, 0.5), 0, CARD.w / CARD.h);
    expect(dist(tall.position, tall.target)).toBeCloseTo(2 * dist(small.position, small.target), 5);
    expect(dist(wide.position, wide.target)).toBeGreaterThan(dist(small.position, small.target));
    expect(dist(small.position, small.target)).toBeGreaterThanOrEqual(0.6);
  });
  it("stands in front of the creature, turned to its left and a little above, aiming just below its centre for headroom", () => {
    const f = portraitFraming(box(1, 1, 1, { x: 3, y: 0.2, z: -2 }), 0, CARD.w / CARD.h);
    expect(f.target).toEqual([3, 0.2 + 0.5 - 0.06, -2]);
    expect(f.position[2]).toBeGreaterThan(f.target[2]);       // heading 0 faces +z: the camera is on that side
    expect(f.position[0]).toBeGreaterThan(f.target[0]);       // turned a quarter of a right angle
    expect(f.position[1]).toBeGreaterThan(f.target[1]);       // and above
    expect(f.fov).toBe(28);
    const turned = portraitFraming(box(1, 1, 1), Math.PI, CARD.w / CARD.h);
    expect(turned.position[2]).toBeLessThan(0);                // a creature facing -z is shot from -z
  });
});

describe("caption", () => {
  it("names the domain, the creature, its rarity and the hatch date", () => {
    expect(captionLines({ domain: "untilwow.com", species: "Moss Hare", tierLabel: "Common find", hatchedOn: "October 8, 2026" }))
      .toEqual({ title: "untilwow.com", subtitle: "Moss Hare · Common find · Hatched October 8, 2026" });
  });
  it("shrinks a long name to the largest size that fits, and never below the floor", () => {
    const widthOf = (chars: number) => (size: number) => chars * size * 0.55;
    expect(fitTitleSize(widthOf(12), 700)).toBe(64);
    expect(fitTitleSize(widthOf(40), 700)).toBe(30);
    expect(fitTitleSize(widthOf(24), 700)).toBe(52);
  });
  it("ellipsizes only what cannot fit at the floor size", () => {
    const measure = (t: string) => t.length * 10;
    expect(ellipsize("untilwow.com", measure, 200)).toBe("untilwow.com");
    expect(ellipsize("a-very-long-name-indeed.com", measure, 120)).toBe("a-very-long…");
  });
  it("the card keeps the picture's 4:5 and adds the band below it", () => {
    expect(CARD.w / CARD.h).toBe(0.8);
    expect(CARD_ASPECT).toBeCloseTo(1024 / 1480, 6);
  });
});
