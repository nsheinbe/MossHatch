import { z } from "zod";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { HttpError } from "../http/router.ts";
import { screenName } from "./screen.ts";
import { ownedLiveDomain, publishBlocked, takedownHeld } from "./service.ts";

/**
 * `card.publish` (PLAN 4.5: "domain, card hash", class H; held after recovery). The person supplies the hash of the portrait
 * their browser rendered and the search-listing choice (D-035); the domain comes from server state. The upload must then carry a
 * file with exactly that hash, so the passkey signs the very image that goes public.
 */
export const publishInput = z.object({
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  indexable: z.boolean(),
}).strict();

export const cardPublishSpec: ActionSpec<z.infer<typeof publishInput>> = {
  type: "card.publish", held: true, userInput: publishInput,
  async derive(_ctx, c, userId, targetId, input) {
    const d = await ownedLiveDomain(c, userId, targetId);
    if (!d.registeredAt) throw new HttpError(409, "card_not_eligible");
    if (await publishBlocked(c, userId)) throw new HttpError(403, "card_publish_blocked");
    if (await takedownHeld(c, d.id)) throw new HttpError(409, "card_taken_down");
    const screen = screenName(d.fqdn);
    if (!screen.ok) throw new HttpError(422, "card_screen_refused", undefined, undefined, { reason: screen.reason });
    return { params: { op: "card.publish", domain_id: d.id, fqdn: d.fqdn, image_sha256: input.image_sha256, indexable: input.indexable }, resourceId: d.id };
  },
  summary: (p) => `Publish a public card for ${String(p.fqdn)} on hatchkind.com. ${p.indexable ? "Search engines may list it." : "Search engines are asked not to list it."}`,
};

export function installCardSpec(): void { registerActionSpec(cardPublishSpec); }
