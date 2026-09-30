import { deriveTraits } from "@mosshatch/core";
import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import type { CardStoragePort, CardsSitePort } from "./storage.ts";
import type { WebRiskPort } from "./screen.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublishServices {
  storage: CardStoragePort;
  webRisk: WebRiskPort;
  site: CardsSitePort;
  /** The share host is configuration, so a rename is a redirect, not a rewrite (PLAN 4.8). */
  cardsOrigin: string;
}

export function installPublish(ctx: AppContext, s: PublishServices): PublishServices {
  (ctx.services as Record<string, unknown>).publish = s;
  return s;
}
export function publishSvc(ctx: Pick<AppContext, "services">): PublishServices {
  const s = (ctx.services as { publish?: PublishServices }).publish;
  if (!s) throw new HttpError(503, "publish_not_configured");
  return s;
}
export const cardsOriginOf = (ctx: Pick<AppContext, "services">) => (ctx.services as { publish?: PublishServices }).publish?.cardsOrigin ?? "https://hatchkind.com";

/** What a card shows besides its portrait: computed from the name alone. No field here can carry text the owner typed. */
export interface CardFacts { slug: string; species: string; family: string; rarity: string; traits: string[] }
export function cardFacts(fqdnAscii: string): CardFacts {
  const t = deriveTraits(fqdnAscii);
  return {
    slug: t.domain, species: t.speciesName, family: t.family, rarity: t.rarity,
    traits: [`${t.rarity} coat`, `${t.earLength > 1.1 ? "long" : "short"} ears`, `${t.tailLength > 1.15 ? "long" : "short"} tail`, `${t.spots} ${t.spots === 1 ? "spot" : "spots"}`],
  };
}

export interface OwnedDomain { id: string; userId: string; fqdn: string; registeredAt: Date | null; releasedAt: Date | null }

/** The caller's own live domain, or 404. Unowned and nonexistent ids share this one path (rule 3). Runs under `withUser`. */
export async function ownedLiveDomain(c: PoolClient, userId: string, domainId: string): Promise<OwnedDomain> {
  if (!UUID_RE.test(domainId)) throw new HttpError(404, "not_found");
  const r = (await c.query("select id, user_id, fqdn_ascii, registered_at, released_at from domains where id = $1 and user_id = $2", [domainId, userId])).rows[0];
  if (!r || r.released_at) throw new HttpError(404, "not_found");
  return { id: r.id, userId: r.user_id, fqdn: r.fqdn_ascii, registeredAt: r.registered_at ? new Date(r.registered_at) : null, releasedAt: null };
}

export async function publishBlocked(c: PoolClient, userId: string): Promise<boolean> {
  return ((await c.query("select 1 from card_publish_blocks where user_id = $1", [userId])).rowCount ?? 0) > 0;
}

/** Public shape of one card, identical in the owner's view and the export. */
export function cardView(r: Record<string, any>, origin: string) {
  return {
    slug: r.slug as string,
    url: `${origin}/${r.slug}/`,
    species: r.species as string, family: r.family as string, rarity: r.rarity as string, traits: r.traits as string[],
    hatched_on: typeof r.hatched_on === "string" ? r.hatched_on : new Date(r.hatched_on).toISOString().slice(0, 10),
    indexable: !!r.indexable,
    published_at: new Date(r.published_at).toISOString(),
  };
}

/** Count one Web Risk lookup against the month (C-68 quota record). */
export async function countLookup(q: Pick<PoolClient, "query">, now: Date): Promise<void> {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  await q.query("insert into card_screen_counts (month, lookups) values ($1, 1) on conflict (month) do update set lookups = card_screen_counts.lookups + 1", [month]);
}
