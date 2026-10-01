import crypto from "node:crypto";
import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { Router } from "../http/router.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { enqueue } from "../jobs/registry.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { safeEqual, sha256 } from "../util/bytes.ts";
import { MAX_UPLOAD_BYTES, PngError, sanitizePng } from "./png.ts";
import { portraitKey } from "./storage.ts";
import { cardFacts, cardView, cardsOriginOf, countLookup, ownedLiveDomain, publishBlocked, publishSvc, takedownHeld } from "./service.ts";
import { installCardSpec } from "./spec.ts";
import { registerPublishJobs, installCardReleaseHook, purgeUnpublished } from "./jobs.ts";
import { CARDS_KEY_HEADER, CURSOR_RE, exportPublicCards } from "./export.ts";

const P = "/api/v1/domains/:id/card";

/** The upload: the portrait as standard base64 and the listing choice. Nothing else: a card has no free-text field (threat row 42). */
const PublishBody = z.object({
  png: z.string().min(16).max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  indexable: z.boolean(),
}).strict();

const uid = (r: HandlerReq) => r.principal.userId!;

async function getCard(r: HandlerReq): Promise<HandlerResult> {
  const userId = uid(r);
  const origin = cardsOriginOf(r.ctx);
  return withUser(r.ctx.runtime, userId, async (c) => {
    const d = await ownedLiveDomain(c, userId, r.params.id!);
    const row = (await c.query("select slug, species, family, rarity, traits, hatched_on::text as hatched_on, indexable, published_at, takedown_state from cards where domain_id = $1 and unpublished_at is null", [d.id])).rows[0];
    const blocked = await publishBlocked(c, userId) || await takedownHeld(c, d.id);
    return json({ card: row ? cardView(row, origin) : null, eligible: !!d.registeredAt && !blocked, address: `${origin}/${d.fqdn}/` });
  });
}

async function publish(r: HandlerReq): Promise<HandlerResult> {
  const action = requireAction(r, "card.publish");
  const params = action.params as { domain_id: string; fqdn: string; image_sha256: string; indexable: boolean };
  const userId = uid(r);
  const svc = publishSvc(r.ctx);
  // The action names its domain; a path naming another is the same 404 as an unowned id.
  if (params.domain_id !== r.params.id) throw new HttpError(404, "not_found");
  const body = PublishBody.safeParse(r.body);
  if (!body.success) throw new HttpError(422, "invalid_card");
  const upload = Buffer.from(body.data.png, "base64");
  // The passkey signed this hash and this listing choice. Anything else is a different card.
  if (sha256(upload).toString("hex") !== params.image_sha256 || body.data.indexable !== params.indexable) throw new HttpError(409, "card_mismatch");
  let clean: ReturnType<typeof sanitizePng>;
  try { clean = sanitizePng(upload); } catch (e) {
    if (e instanceof PngError) throw new HttpError(422, "invalid_image", undefined, undefined, { reason: e.code });
    throw e;
  }
  const now = r.ctx.clock.now();
  const facts = cardFacts(params.fqdn);
  // Web Risk before anything is stored. The verdict is used and dropped; only the count is kept (C-68).
  let flagged: boolean;
  try { flagged = await svc.webRisk.isFlagged(`http://${params.fqdn}/`); } catch { throw new HttpError(503, "screen_unavailable"); }
  await countLookup(r.ctx.runtime, now);
  if (flagged) throw new HttpError(422, "card_screen_refused", undefined, undefined, { reason: "web_risk_flagged" });

  const storedSha = sha256(clean.png).toString("hex");
  // A fresh key per upload: two requests replaying one action never share a file, so the loser's clean-up cannot touch the winner's.
  const stored = await svc.storage.put(portraitKey(crypto.randomUUID(), storedSha), clean.png);
  try {
    const card = await withUser(r.ctx.runtime, userId, async (c) => {
      const d = await ownedLiveDomain(c, userId, params.domain_id);
      if (!d.registeredAt) throw new HttpError(409, "card_not_eligible");
      // One publish or take-down of this domain's card at a time (jobs.ts takeDownCard takes the same lock).
      await c.query("select pg_advisory_xact_lock(hashtextextended('card:' || $1::text, 0))", [d.id]);
      if (await publishBlocked(c, userId)) throw new HttpError(403, "card_publish_blocked");
      // A take-down that landed after the step-up still holds (C-66).
      if (await takedownHeld(c, d.id)) throw new HttpError(409, "card_taken_down");
      await markExecuted(c, action);
      const prev = await c.query("update cards set unpublished_at = $2, unpublish_reason = 'republished' where domain_id = $1 and unpublished_at is null returning id", [d.id, now]);
      const row = (await c.query(
        `insert into cards (user_id, domain_id, slug, species, family, rarity, traits, hatched_on, snapshot_ref, snapshot_url, image_sha256, image_width, image_height, image_bytes, indexable, published_at, action_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning id, slug, species, family, rarity, traits, hatched_on::text as hatched_on, indexable, published_at`,
        [userId, d.id, facts.slug, facts.species, facts.family, facts.rarity, JSON.stringify(facts.traits), d.registeredAt!.toISOString().slice(0, 10),
          stored.ref, stored.url, storedSha, clean.width, clean.height, clean.png.length, params.indexable, now, action.id])).rows[0];
      await appendAudit(r.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "card.published", resourceKind: "card", resourceId: row.id, detail: { domain_id: d.id, indexable: params.indexable, replaced: prev.rowCount ?? 0 } });
      await enqueue(c, { kind: "cards.rebuild", payload: {}, dedupeKey: `cards.rebuild:${Math.floor(now.getTime() / 60_000)}` });
      if ((prev.rowCount ?? 0) > 0) await enqueue(c, { kind: "card.purge", payload: {}, dedupeKey: `card.purge:${row.id}` });
      return row;
    });
    return json({ card: cardView(card, cardsOriginOf(r.ctx)) }, 201);
  } catch (e) {
    // The file went up but the card did not: take it down again (best effort; an orphan holds no owner data and is unlinked).
    // Never while a card row names it (defence in depth: the key is already unique to this request).
    const referenced = await withUser(r.ctx.runtime, userId, async (c) => ((await c.query("select 1 from cards where snapshot_ref = $1 limit 1", [stored.ref])).rowCount ?? 0) > 0).catch(() => true);
    if (!referenced) await svc.storage.delete(stored.ref).catch(() => undefined);
    throw e;
  }
}

/** Unpublish: free (no step-up), one action, and the portrait is deleted from storage after the commit (C-66, C-70). */
async function unpublish(r: HandlerReq): Promise<HandlerResult> {
  const userId = uid(r);
  const now = r.ctx.clock.now();
  await withUser(r.ctx.runtime, userId, async (c) => {
    const d = await ownedLiveDomain(c, userId, r.params.id!);
    const u = await c.query("update cards set unpublished_at = $2, unpublish_reason = 'owner' where domain_id = $1 and user_id = $3 and unpublished_at is null returning id", [d.id, now, userId]);
    // No live card, or another request unpublished it first: the same 404 as an unknown domain.
    if (u.rowCount !== 1) throw new HttpError(404, "not_found");
    await appendAudit(r.ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "card.unpublished", resourceKind: "card", resourceId: u.rows[0].id, detail: { cause: "owner" } });
    await enqueue(c, { kind: "card.purge", payload: {}, dedupeKey: `card.purge:${u.rows[0].id}` });
    await enqueue(c, { kind: "cards.rebuild", payload: {}, dedupeKey: `cards.rebuild:${Math.floor(now.getTime() / 60_000)}` });
  });
  // Purge at once when storage answers; the job retries when it does not.
  await purgeUnpublished(r.ctx).catch(() => undefined);
  return json({ unpublished: true });
}

/**
 * The JSON the `cards` build reads: the public view and nothing else (threat row 42), one page at a time. It lists unlisted cards
 * too, so only the build may read it: the key in `X-MH-Cards-Key`, compared in constant time; no key configured means closed.
 * Anonymous by router principal only because the key is not a binding token; every caller without the key gets one 401.
 */
async function exportCards(r: HandlerReq): Promise<HandlerResult> {
  const want = (r.ctx.services as { publish?: { exportKey?: string } }).publish?.exportKey;
  const got = r.request.headers.get(CARDS_KEY_HEADER) ?? "";
  if (!want || !safeEqual(sha256(want), sha256(got))) throw new HttpError(401, "unauthorized");
  const after = r.url.searchParams.get("after");
  if (after !== null && !CURSOR_RE.test(after)) throw new HttpError(422, "invalid_cursor");
  const data = await exportPublicCards(r.ctx.runtime, cardsOriginOf(r.ctx), r.ctx.clock.now(), { after });
  return json(data, 200, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

const base = { tag: "publish" };
export const publishRoutes: Route[] = [
  { ...base, method: "GET", path: P, principals: ["session"], handler: getCard },
  { ...base, method: "POST", path: P, principals: ["session"], stepUp: "card.publish", handler: publish },
  { ...base, method: "DELETE", path: P, principals: ["session"], handler: unpublish },
  { ...base, method: "GET", path: "/api/v1/cards/public", principals: ["anonymous"], handler: exportCards },
];

/** One registration line in `routes.ts`. Installs the step-up spec, the jobs and the release hook too. */
export function registerPublish(router: Router): Router {
  installCardSpec();
  registerPublishJobs();
  installCardReleaseHook();
  router.add(...publishRoutes);
  return router;
}

/** Support's take-down and reinstatement, for the abuse runbook (C-66). Exported from the module index. */
export { takeDownCard, reinstateCard } from "./jobs.ts";
