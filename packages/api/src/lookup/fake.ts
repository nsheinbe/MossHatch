import { fnv1a } from "@mosshatch/core";
import type { Fetch } from "./rdap.ts";

/**
 * A stand-in for the registries' RDAP services, for the local dev server and end-to-end runs (never the network). Deterministic:
 * `google`, `example` and `mosshatch` are registered everywhere, `moonfern` on .com and .studio (as in the real registries on
 * 2026-10-01), a label starting `nocheck` gets a 503 (so "couldn't check" can be seen), and otherwise about one name in four is
 * registered. The IANA bootstrap file answers 503, so the baked-in server map is used.
 */
const EVERYWHERE = new Set(["google", "example", "mosshatch"]);
const FIXED = new Set(["moonfern.com", "moonfern.studio"]);

export const fakeRdapFetch: Fetch = async (input) => {
  const m = /\/domain\/([a-z0-9-]+)\.([a-z]+)$/.exec(input);
  if (!m) return new Response(null, { status: 503 });
  const [, label, tld] = m as unknown as [string, string, string];
  const fqdn = `${label}.${tld}`;
  if (label.startsWith("nocheck")) return new Response(null, { status: 503 });
  const taken = EVERYWHERE.has(label) || FIXED.has(fqdn) || fnv1a("rdap:" + fqdn) % 4 === 0;
  return new Response(taken ? "{}" : null, { status: taken ? 200 : 404, headers: { "content-type": "application/rdap+json" } });
};
