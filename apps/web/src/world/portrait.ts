import { TOKENS } from "./materials";

/**
 * The hatch card's portrait: how the creature is framed, and the caption band drawn under the picture.
 *
 * The first live card (untilwow.com, 2026-10-08) was shot from fixed offsets at 512 x 640 without multisampling: grass blades crossed
 * the creature's feet, its ears touched the top edge, the lantern post was cut in half, the hatched texture shimmered, and the file
 * said nothing about which name or creature it was. This module holds the pure parts of the fix (framing from the creature's bounds,
 * the caption's text and sizing) so they can be tested without a GPU, and the one function that touches a canvas.
 */

/** The picture the engine renders, and the band under it. The card is `w` by `h + band`. */
export const CARD = { w: 1024, h: 1280, band: 200 } as const;
export const CARD_ASPECT = CARD.w / (CARD.h + CARD.band);

export interface PortraitCaption { domain: string; species: string; tierLabel: string; hatchedOn: string }

interface V3 { x: number; y: number; z: number }
export interface Framing { position: [number, number, number]; target: [number, number, number]; fov: number }

/**
 * Place the portrait camera from the creature's world-space bounds: a little above and in front of the creature, turned a quarter of a
 * right angle to its left so the face has depth, far enough back for the taller of its height and width to fit with a margin, and
 * aimed just below its centre so the frame leaves headroom above the ears. Heading 0 faces +z, as the creature does.
 */
export function portraitFraming(box: { min: V3; max: V3 }, heading: number, aspect: number, o: { fov?: number; margin?: number; yaw?: number; pitch?: number; headroom?: number } = {}): Framing {
  const fov = o.fov ?? 28, margin = o.margin ?? 1.3, yaw = o.yaw ?? 0.42, pitch = o.pitch ?? 0.16, headroom = o.headroom ?? 0.06;
  const size = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
  const center = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  const halfTan = Math.tan((fov / 2) * Math.PI / 180);
  const byHeight = (size.y / 2) * margin / halfTan;
  const byWidth = (Math.max(size.x, size.z) / 2) * margin / (halfTan * aspect);
  const distance = Math.max(byHeight, byWidth, 0.6);
  const a = heading + yaw;
  const dir = { x: Math.sin(a) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(a) * Math.cos(pitch) };
  const target: [number, number, number] = [center.x, center.y - size.y * headroom, center.z];
  return { position: [target[0] + dir.x * distance, target[1] + dir.y * distance, target[2] + dir.z * distance], target, fov };
}

/** The two caption lines. */
export function captionLines(c: PortraitCaption): { title: string; subtitle: string } {
  return { title: c.domain, subtitle: `${c.species} · ${c.tierLabel} · Hatched ${c.hatchedOn}` };
}

/** The largest size from `max` down to `min` at which `measure(size)` fits `available`; `min` when none does. */
export function fitTitleSize(measure: (size: number) => number, available: number, max = 64, min = 30, step = 2): number {
  for (let s = max; s > min; s -= step) if (measure(s) <= available) return s;
  return min;
}

/** `text`, or its longest prefix plus an ellipsis that `measure` says fits `available`. */
export function ellipsize(text: string, measure: (t: string) => number, available: number): string {
  if (measure(text) <= available) return text;
  for (let n = text.length - 1; n > 0; n--) { const t = `${text.slice(0, n)}…`; if (measure(t) <= available) return t; }
  return "…";
}

const DISPLAY = '"Young Serif", Georgia, "Times New Roman", serif';
const TEXT = '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif';

async function fontsReady(): Promise<void> {
  const fonts = (document as Document & { fonts?: { load(spec: string): Promise<unknown> } }).fonts;
  if (!fonts) return;
  try { await Promise.all([fonts.load(`400 64px "Young Serif"`), fonts.load(`400 30px "Atkinson Hyperlegible"`)]); } catch { /* the fallback faces draw instead */ }
}

/** The card: the rendered picture with the caption band under it, as a PNG data URL (the download and the panel both use it). */
export async function composeCard(picture: HTMLCanvasElement, caption: PortraitCaption): Promise<string> {
  const { w, h, band } = CARD;
  await fontsReady();
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h + band;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("canvas-2d-unavailable");
  ctx.drawImage(picture, 0, 0, w, h);
  ctx.fillStyle = TOKENS.ink; ctx.fillRect(0, h, w, band);
  ctx.fillStyle = TOKENS.moss; ctx.fillRect(0, h, w, 3);
  const pad = 48;
  const { title, subtitle } = captionLines(caption);
  // Row 1: the name, shrunk to fit beside the wordmark. Row 2: creature, rarity, date; the site on the right.
  ctx.textBaseline = "alphabetic";
  ctx.font = `400 34px ${DISPLAY}`;
  const wordmark = "Mosshatch";
  const wordmarkW = ctx.measureText(wordmark).width;
  const titleAvail = w - pad * 2 - wordmarkW - 40;
  const titleSize = fitTitleSize((s) => { ctx.font = `400 ${s}px ${DISPLAY}`; return ctx.measureText(title).width; }, titleAvail);
  ctx.font = `400 ${titleSize}px ${DISPLAY}`;
  ctx.fillStyle = TOKENS.shell; ctx.textAlign = "left";
  ctx.fillText(ellipsize(title, (t) => ctx.measureText(t).width, titleAvail), pad, h + 86);
  ctx.font = `400 34px ${DISPLAY}`; ctx.textAlign = "right";
  ctx.fillText(wordmark, w - pad, h + 86);
  ctx.font = `400 24px ${TEXT}`; ctx.globalAlpha = 0.72;
  ctx.fillText("mosshatch.com", w - pad, h + 150);
  const siteW = ctx.measureText("mosshatch.com").width;
  ctx.font = `400 30px ${TEXT}`; ctx.textAlign = "left";
  ctx.fillText(ellipsize(subtitle, (t) => ctx.measureText(t).width, w - pad * 2 - siteW - 40), pad, h + 150);
  ctx.globalAlpha = 1;
  return cv.toDataURL("image/png");
}
