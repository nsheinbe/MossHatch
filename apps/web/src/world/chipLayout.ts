/** A chip as projected this frame: its anchor (bottom-centre, CSS px), its size, and the row it asks for. */
export interface ChipBox { x: number; y: number; w: number; h: number; row: number }

/** Height of one chip row (px); must match the lift the overlay has always used per row. */
export const ROW_PX = 62;
const GAP = 4, MAX_EXTRA = 4;

/**
 * Lift each chip (in order) by its own row, plus as many extra rows as it takes not to overlap a chip already placed. Chips are
 * anchored to eggs and sleepers whose places depend on the name (a koi sleeps in the pool, among the eggs), so two can land on the
 * same spot; overlapping buttons are unreadable and fail WCAG 2.5.8 target spacing. Returns the lift in px for each chip.
 */
export function liftChips(boxes: readonly ChipBox[]): number[] {
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  return boxes.map((c) => {
    let lift = c.row * ROW_PX;
    for (let extra = 0; extra <= MAX_EXTRA; extra++) {
      const b = c.y - lift, t = b - c.h, l = c.x - c.w / 2, r = c.x + c.w / 2;
      const hit = placed.some((p) => l < p.r + GAP && r > p.l - GAP && t < p.b + GAP && b > p.t - GAP);
      if (!hit || extra === MAX_EXTRA) { placed.push({ l, r, t, b }); break; }
      lift += ROW_PX;
    }
    return lift;
  });
}
