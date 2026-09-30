import type { Pool, PoolClient } from "@mosshatch/db";

/** One card as the `cards` build receives it. Every field comes from the `public_cards` view. */
export interface ExportedCard {
  slug: string;
  species: string;
  family: string;
  rarity: string;
  traits: string[];
  hatched_on: string;
  image: { url: string; sha256: string; width: number; height: number };
  indexable: boolean;
  published_at: string;
}
/** One page of the export. `next` is the cursor for the following page (`?after=`), null on the last one. */
export interface CardsExport { version: 1; generated_at: string; origin: string; cards: ExportedCard[]; next: string | null }

/** The keys an exported card may have. The cards build and ST-145 both check against this list. */
export const EXPORT_KEYS = ["slug", "species", "family", "rarity", "traits", "hatched_on", "image", "indexable", "published_at"] as const;
/** The header that carries the cards build's key (mirrored in apps/cards/src/data.ts). Not `Authorization`, which the router reserves for binding tokens. */
export const CARDS_KEY_HEADER = "x-mh-cards-key";
/** Cards per page. The build follows `next` until it is null, so no card is ever cut off by a limit. */
export const EXPORT_PAGE = 1000;
/** A cursor is a slug: the same shape as `cards.slug`. */
export const CURSOR_RE = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** One page of `public_cards`, keyset-paged by slug (unique among live cards), so pages never overlap or skip a card. */
export async function exportPublicCards(q: Pick<Pool | PoolClient, "query">, origin: string, now: Date, o: { after?: string | null; limit?: number } = {}): Promise<CardsExport> {
  const limit = o.limit ?? EXPORT_PAGE;
  const rows = (await q.query(
    `select slug, species, family, rarity, traits, hatched_on::text as hatched_on, snapshot_url, image_sha256, image_width, image_height, indexable, published_at
     from public_cards where ($1::text is null or slug > $1 collate "C") order by slug collate "C" limit $2`, [o.after ?? null, limit])).rows;
  return {
    version: 1, generated_at: now.toISOString(), origin,
    cards: rows.map((r) => ({
      slug: r.slug, species: r.species, family: r.family, rarity: r.rarity, traits: r.traits, hatched_on: r.hatched_on,
      image: { url: r.snapshot_url, sha256: r.image_sha256, width: r.image_width, height: r.image_height },
      indexable: r.indexable, published_at: new Date(r.published_at).toISOString(),
    })),
    next: rows.length === limit ? (rows[rows.length - 1]!.slug as string) : null,
  };
}
