import crypto from "node:crypto";

/**
 * The cards the site is built from. Source, in order: `CARDS_EXPORT_URL` (the web project's GET /api/v1/cards/public, which reads
 * only the `public_cards` view), else the sample fixtures. A production build refuses the fixtures.
 * Every record is checked field by field against the export contract; one bad record fails the build rather than publishing it.
 */

export interface Card {
  slug: string;
  species: string;
  family: "fox" | "moth" | "beetle" | "koi";
  rarity: "common" | "uncommon" | "rare";
  traits: string[];
  hatched_on: string;
  image: { url: string; sha256: string; width: number; height: number } | null;
  indexable: boolean;
  published_at: string;
}

/** Mirrors EXPORT_KEYS in packages/api/src/publish/export.ts. A key outside this list fails the build. */
export const CARD_KEYS = ["slug", "species", "family", "rarity", "traits", "hatched_on", "image", "indexable", "published_at"] as const;
const SPECIES = new Set(["Ember Fox", "Lantern Moth", "Tinkerbeetle", "Clockwork Koi"]);
const FAMILIES = new Set(["fox", "moth", "beetle", "koi"]);
const RARITIES = new Set(["common", "uncommon", "rare"]);
export const SLUG_RE = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** The only phrases a trait can be: computed on the server from the name, never typed by anyone. */
export const TRAIT_RE = /^(?:(?:common|uncommon|rare) coat|(?:long|short) (?:ears|tail)|\d spots?)$/;

export class CardDataError extends Error {}

export function validateCard(raw: unknown, i: number): Card {
  const bad = (what: string) => new CardDataError(`card ${i}: ${what}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("not an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!(CARD_KEYS as readonly string[]).includes(k)) throw bad(`unexpected key ${k}`);
  if (typeof r.slug !== "string" || !SLUG_RE.test(r.slug)) throw bad("slug");
  if (typeof r.species !== "string" || !SPECIES.has(r.species)) throw bad("species");
  if (typeof r.family !== "string" || !FAMILIES.has(r.family)) throw bad("family");
  if (typeof r.rarity !== "string" || !RARITIES.has(r.rarity)) throw bad("rarity");
  if (!Array.isArray(r.traits) || r.traits.length < 1 || r.traits.length > 8 || !r.traits.every((t) => typeof t === "string" && TRAIT_RE.test(t))) throw bad("traits");
  if (typeof r.hatched_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.hatched_on)) throw bad("hatched_on");
  if (typeof r.indexable !== "boolean") throw bad("indexable");
  if (typeof r.published_at !== "string" || Number.isNaN(Date.parse(r.published_at))) throw bad("published_at");
  let image: Card["image"] = null;
  if (r.image !== null) {
    const im = r.image as Record<string, unknown>;
    if (!im || typeof im !== "object") throw bad("image");
    for (const k of Object.keys(im)) if (!["url", "sha256", "width", "height"].includes(k)) throw bad(`unexpected image key ${k}`);
    if (typeof im.url !== "string" || !im.url.startsWith("https://")) throw bad("image url");
    if (typeof im.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(im.sha256)) throw bad("image sha256");
    if (!((im.width === 512 && im.height === 640) || (im.width === 256 && im.height === 320))) throw bad("image size");
    image = { url: im.url, sha256: im.sha256, width: im.width as number, height: im.height as number };
  }
  return { slug: r.slug, species: r.species, family: r.family as Card["family"], rarity: r.rarity as Card["rarity"], traits: r.traits as string[], hatched_on: r.hatched_on, image, indexable: r.indexable, published_at: r.published_at };
}

export function validateExport(raw: unknown): Card[] {
  const r = raw as { version?: unknown; cards?: unknown };
  if (!r || r.version !== 1 || !Array.isArray(r.cards)) throw new CardDataError("export: bad envelope");
  const cards = r.cards.map(validateCard);
  const seen = new Set<string>();
  for (const c of cards) { if (seen.has(c.slug)) throw new CardDataError(`duplicate slug`); seen.add(c.slug); }
  return cards;
}

export const MAX_IMAGE_BYTES = 400_000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Download one portrait and check it is the PNG the export promised (hash, signature, size). */
export async function fetchPortrait(card: Card, f: typeof fetch = fetch): Promise<Buffer> {
  if (!card.image) throw new CardDataError("no image");
  const res = await f(card.image.url, { redirect: "error" });
  if (!res.ok) throw new CardDataError(`portrait ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES || !buf.subarray(0, 8).equals(PNG_SIG)) throw new CardDataError("portrait is not a PNG within the size cap");
  if (crypto.createHash("sha256").update(buf).digest("hex") !== card.image.sha256) throw new CardDataError("portrait hash mismatch");
  return buf;
}
