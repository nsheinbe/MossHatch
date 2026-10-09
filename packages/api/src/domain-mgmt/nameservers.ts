import { z } from "zod";
import { isIP } from "node:net";
import { withUser } from "@mosshatch/db";
import { canonicalZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import type { HandlerReq } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { hashOf } from "../util/bytes.ts";
import { ownedDomain, registrarOf, userIdOf, type DomainRow } from "./common.ts";

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const NameserverInput = z.strictObject({ nameservers: z.array(z.string().trim().toLowerCase().regex(HOSTNAME)).min(2).max(13) });

export function normalizeNameservers(fqdn: string, raw: unknown): string[] {
  const parsed = NameserverInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, "bad_nameservers");
  const ns = [...new Set(parsed.data.nameservers)].sort();
  if (ns.length < 2 || ns.some((name) => isIP(name) !== 0)) throw new HttpError(422, "bad_nameservers");
  if (ns.some((n) => n === fqdn || n.endsWith("." + fqdn))) throw new HttpError(422, "glue_unsupported");
  return ns;
}

/**
 * One plan for the owner and delegated agents. This is a registry delegation, not a zone NS RR.
 * Provider-reported DS is explicitly not a parent-zone observation. No public DNS scan can prove a full zone inventory.
 * There is intentionally no execution override: destination authorization, authenticated inventory and a supported
 * DNSSEC transition verifier have not been implemented. Source records are never deleted or copied by this path.
 */
export async function nameserverPlan(ctx: AppContext, d: DomainRow, raw: unknown) {
  const desired = normalizeNameservers(d.fqdn_ascii, raw);
  const port = registrarOf(ctx);
  const up = await port.getDomain(d.fqdn_ascii);
  if (!up || up.fqdn !== d.fqdn_ascii) throw new HttpError(409, "delegation_state_unknown");
  const before = [...up.nameservers].map((n) => n.toLowerCase().replace(/\.$/, "")).sort();
  if (JSON.stringify(before) === JSON.stringify(desired)) throw new HttpError(409, "unchanged");
  const [zone, ds] = await Promise.allSettled([port.getDns(d.fqdn_ascii), port.getDs(d.fqdn_ascii)]);
  const inventory = zone.status === "fulfilled" && zone.value.hosted ? canonicalZone(zone.value.records) : null;
  const providerDs = ds.status === "fulfilled" ? ds.value : null;
  const state = {
    nameservers: before,
    registrar_ds: providerDs,
    registrar_ds_present: up.dsPresent,
    source_zone_hash: inventory ? zoneHash(inventory) : null,
    source_inventory: inventory,
  };
  const blockers = ["destination_authorization_required", "delegation_verification_unavailable"];
  if (!inventory) blockers.push("source_inventory_required");
  if (providerDs === null || up.dsPresent || providerDs.length) blockers.push("dnssec_transition_unverified");
  const plan = {
    op: "nameservers" as const, domain_id: d.id, fqdn: d.fqdn_ascii,
    before_hash: hashOf(state).toString("hex"), before, nameservers: desired,
    state, executable: false as const, blockers,
    source_records_preserved: true,
    parent_ds: "unverified" as const,
    destination_dnskey_signatures: "unverified" as const,
    impact: ["web_and_mail_availability", "certificate_issuance", "ownership_verification", "dnssec_validation"],
  };
  return { ...plan, plan_hash: hashOf(plan).toString("hex") };
}

/** Neither a passkey nor target_signed is a substitute for missing migration safety evidence. */
export function assertDelegationExecutable(): never {
  throw new HttpError(409, "nameserver_migration_unavailable");
}

export async function nameserverPreviewHandler(req: HandlerReq) {
  const userId = userIdOf(req);
  const d = await withUser(req.ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  return json(await nameserverPlan(req.ctx, d, req.body));
}
