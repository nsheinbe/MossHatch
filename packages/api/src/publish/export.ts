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
export interface CardsExport { version: 1; generated_at: string; origin: string; cards: ExportedCard[] }

/** The keys an exported card may have. The cards build and ST-145 both check against this list. */
export const EXPORT_KEYS = ["slug", "species", "family", "rarity", "traits", "hatched_on", "image", "indexable", "published_at"] as const;

export async function exportPublicCards(q: Pick<Pool | PoolClient, "query">, origin: string, now: Date): Promise<CardsExport> {
  const rows = (await q.query(
    `select slug, species, family, rarity, traits, hatched_on::text as hatched_on, snapshot_url, image_sha256, image_width, image_height, indexable, published_at
     from public_cards order by published_at desc, slug limit 5000`)).rows;
  return {
    version: 1, generated_at: now.toISOString(), origin,
    cards: rows.map((r) => ({
      slug: r.slug, species: r.species, family: r.family, rarity: r.rarity, traits: r.traits, hatched_on: r.hatched_on,
      image: { url: r.snapshot_url, sha256: r.image_sha256, width: r.image_width, height: r.image_height },
      indexable: r.indexable, published_at: new Date(r.published_at).toISOString(),
    })),
  };
}
