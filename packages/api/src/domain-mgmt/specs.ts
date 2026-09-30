import { z } from "zod";
import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { isHostedNs, normalizeFqdn, ownedDomain, type DomainRow } from "./common.ts";

/**
 * The four step-up specs of domain management: `domain.unlock`, `domain.transfer_out` (code issue), `domain.nameservers.change`
 * (nameservers and DS records) and `domain.contact.change`. Every param is built from server state; the client supplies only
 * the low-risk inputs named in each schema. A hold after recovery refuses all four (`held: true`).
 */

export const HOSTNAME = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Why an outbound transfer cannot be prepared right now: dispute lock (C-23), the 60-day lock (C-07), a change awaiting approval. */
export async function assertTransferAllowed(ctx: Pick<AppContext, "clock">, c: PoolClient, d: DomainRow): Promise<void> {
  if (d.dispute_lock_state) throw new HttpError(423, "dispute_lock");
  const now = ctx.clock.now();
  const s = (await c.query("select transfer_lock_until from domain_security where domain_id = $1", [d.id])).rows[0];
  if (s?.transfer_lock_until && new Date(s.transfer_lock_until) > now) throw new HttpError(423, "transfer_locked", "transfer_locked", undefined, { until: new Date(s.transfer_lock_until).toISOString() });
  const p = await c.query("select 1 from contact_changes where domain_id = $1 and state = 'awaiting_approval' limit 1", [d.id]);
  if ((p.rowCount ?? 0) > 0) throw new HttpError(423, "contact_change_pending");
}

const empty = z.object({}).strict();

export const unlockSpec: ActionSpec<z.infer<typeof empty>> = {
  type: "domain.unlock", held: true, userInput: empty,
  async derive(ctx, c, userId, targetId) {
    const d = await ownedDomain(c, userId, targetId);
    await assertTransferAllowed(ctx, c, d);
    if (!d.locked) throw new HttpError(409, "already_unlocked");
    return { params: { op: "unlock", domain_id: d.id, fqdn: d.fqdn_ascii, locked: true }, resourceId: d.id };
  },
  summary: (p) => `Unlock ${String(p.fqdn)} so it can be transferred to another registrar.`,
};

export const transferOutSpec: ActionSpec<z.infer<typeof empty>> = {
  type: "domain.transfer_out", held: true, userInput: empty,
  async derive(ctx, c, userId, targetId) {
    const d = await ownedDomain(c, userId, targetId);
    await assertTransferAllowed(ctx, c, d);
    if (d.locked) throw new HttpError(409, "domain_locked");
    return { params: { op: "transfer_out", domain_id: d.id, fqdn: d.fqdn_ascii, locked: false }, resourceId: d.id };
  },
  summary: (p) => `Get a transfer authorization code for ${String(p.fqdn)}. It is shown once.`,
};

const dsShape = z.object({
  keyTag: z.number().int().min(0).max(65535), algorithm: z.number().int().min(0).max(255), digestType: z.number().int().min(0).max(255),
  digest: z.string().trim().regex(/^[0-9a-fA-F]{20,128}$/),
}).strict();
const nsInput = z.object({
  kind: z.enum(["nameservers", "ds_add", "ds_remove"]),
  nameservers: z.array(z.string().trim().toLowerCase().regex(HOSTNAME)).min(2).max(13).optional(),
  target_signed: z.boolean().optional(),
  ds: dsShape.optional(),
}).strict();

export const nameserversSpec: ActionSpec<z.infer<typeof nsInput>> = {
  type: "domain.nameservers.change", held: true, userInput: nsInput,
  async derive(_ctx, c, userId, targetId, input) {
    const d = await ownedDomain(c, userId, targetId);
    if (input.kind === "nameservers") {
      const ns = [...new Set(input.nameservers ?? [])];
      if (ns.length < 2) throw new HttpError(422, "bad_nameservers");
      // Glue (addresses for nameservers under the domain itself, IPv6 included) is not supported: say so plainly.
      if (ns.some((n) => n === d.fqdn_ascii || n.endsWith("." + d.fqdn_ascii))) throw new HttpError(422, "glue_unsupported");
      const signed = input.target_signed === true;
      if (signed && isHostedNs(ns)) throw new HttpError(422, "target_not_signed");
      // A signed domain moved to unsigned DNS stops resolving on validating resolvers (plan 4.3b DNSSEC, C-20).
      if (d.ds_present && !signed) throw new HttpError(409, "dnssec_would_break");
      if (ns.length === d.nameservers.length && ns.every((n) => d.nameservers.includes(n))) throw new HttpError(409, "unchanged");
      return { params: { op: "nameservers", domain_id: d.id, fqdn: d.fqdn_ascii, nameservers: ns, target_signed: signed }, resourceId: d.id };
    }
    if (!input.ds) throw new HttpError(422, "bad_ds");
    const ds = { ...input.ds, digest: input.ds.digest.toLowerCase() };
    return { params: { op: input.kind, domain_id: d.id, fqdn: d.fqdn_ascii, ds }, resourceId: d.id };
  },
  summary: (p) => p.op === "nameservers"
    ? `Change the nameservers of ${String(p.fqdn)} to ${(p.nameservers as string[]).join(", ")}.`
    : `${p.op === "ds_add" ? "Add" : "Remove"} a DNSSEC record on ${String(p.fqdn)}.`,
};

const contactInput = z.object({}).strict();
export const contactSpec: ActionSpec<z.infer<typeof contactInput>> = {
  type: "domain.contact.change", held: true, userInput: contactInput,
  async derive(ctx, c, userId, targetId) {
    // The target is a draft created by POST /domains/:fqdn/contact-drafts; the draft holds the encrypted values.
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new HttpError(404, "not_found");
    const ch = (await c.query("select id, domain_id, fields_hash, registrant_change, email_matches_login, state from contact_changes where id = $1 and user_id = $2", [targetId, userId])).rows[0];
    if (!ch || ch.state !== "draft") throw new HttpError(404, "not_found");
    const d = (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [ch.domain_id, userId])).rows[0] as DomainRow | undefined;
    if (!d) throw new HttpError(404, "not_found");
    if (d.dispute_lock_state) throw new HttpError(423, "dispute_lock");   // C-23: contact edits are frozen
    void ctx;
    return {
      params: { op: "contact", change_id: ch.id, domain_id: d.id, fqdn: d.fqdn_ascii, fields_hash: ch.fields_hash, registrant_change: ch.registrant_change, email_matches_login: ch.email_matches_login },
      resourceId: d.id,
    };
  },
  summary: (p) => p.registrant_change
    ? `Change the registrant of ${String(p.fqdn)}. This is a change of registrant: both the current and the new registrant must approve it, and the domain cannot be transferred to another registrar for 60 days afterwards.`
    : `Update the contact details of ${String(p.fqdn)}.`,
};

export function installDomainSpecs(): void {
  registerActionSpec(unlockSpec);
  registerActionSpec(transferOutSpec);
  registerActionSpec(nameserversSpec);
  registerActionSpec(contactSpec);
}

export { normalizeFqdn };
