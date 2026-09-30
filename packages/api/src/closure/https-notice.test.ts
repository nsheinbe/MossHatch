import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REGISTRANT } from "../orders/testkit.ts";
import { makePerson as makeVaultPerson } from "../vault/testkit.ts";
import { connect, makeRecipeKit, plan, type RecipeKit } from "../recipes/testkit.ts";
import { HSTS_PRELOADED_TLDS, httpsRequired, tldNotices } from "./tld-https.ts";

/**
 * C-58: .dev and .app are HSTS-preloaded, so registrars must tell registrants at checkout that every site and subdomain needs HTTPS.
 * The notice travels with the quote (every client, the web checkout included, shows it before paying) and with a recipe's plan, which
 * is what the person or agent sees before a recipe writes DNS for the name.
 */

let k: RecipeKit;
beforeAll(async () => {
  k = await makeRecipeKit();
  (k.app.ctx.services as Record<string, unknown>).registrar = k.registrar;
}, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await k.app.db.owner.query("delete from rate_counters"); });

let n = 0;
async function personWith(tld: string) {
  const fqdn = `https-${++n}-${Date.now().toString(36)}.${tld}`;
  k.registrar.setKind(fqdn, "available");
  await k.registrar.register({ fqdn, years: 1, regUsername: `u${n}https`, regPassword: `pw-${Math.random().toString(36).slice(2, 14)}`, registrant: REGISTRANT } as never);
  const p = await makeVaultPerson(k, `https${n}`, fqdn);
  await k.app.db.owner.query("update domains set tld = $2, registrar = 'mock', dns_hosted_here = true where id = $1", [p.domain.id, tld]);
  return p;
}

describe("C-58: the HTTPS notice for .dev and .app", () => {
  it("names exactly the HSTS-preloaded launch extensions", () => {
    expect([...HSTS_PRELOADED_TLDS].sort()).toEqual(["app", "dev"]);
    for (const f of ["moonfern.dev", "MOONFERN.APP", "a.b.dev."]) expect(httpsRequired(f), f).toBe(true);
    for (const f of ["moonfern.com", "moonfern.studio", "moonfern.io", "moonfern.ai", "dev.com", "app.io"]) expect(httpsRequired(f), f).toBe(false);
    expect(tldNotices("moonfern.dev")[0]).toMatchObject({ code: "https_required" });
    expect(tldNotices("moonfern.dev")[0]!.text).toMatch(/^\.dev names work only over HTTPS/);
  });

  it("the quote for a .dev or .app name carries it; a .com quote does not", async () => {
    for (const [tld, want] of [["dev", 1], ["app", 1], ["com", 0]] as const) {
      const r = await k.app.call("GET", `/api/v1/quote?domain=quote-notice-${tld}-${Date.now().toString(36)}.${tld}&years=1`);
      expect(r.status, r.text).toBe(200);
      expect(r.json.notices, tld).toHaveLength(want);
      if (want) expect(r.json.notices[0]).toMatchObject({ code: "https_required", text: expect.stringContaining(`.${tld} names work only over HTTPS`) });
    }
  });

  it("a recipe's plan for a .dev name shows it before any DNS is written; a .com plan does not", async () => {
    for (const [tld, want] of [["dev", 1], ["com", 0]] as const) {
      const p = await personWith(tld);
      const credential = `vcp_test_https_${n}_VERCELCREDENTIAL`;
      const project = `prj_https${n}`;
      k.fakes.vercel.addProject(project, credential, { ipv4: "216.198.79.1", cname: `c${n}abcdef.vercel-dns-017.com` });
      await connect(k, p, "vercel", credential, project);
      const r = await plan(k, p, "hosting-vercel");
      expect(r.status, r.text).toBe(201);
      expect(r.json.notices, tld).toHaveLength(want);
      if (want) expect(r.json.notices[0].code).toBe("https_required");
      // Planning wrote nothing to the zone.
      expect((await k.registrar.getDns(p.domain.fqdn)).records.filter((x) => x.value === "216.198.79.1")).toEqual([]);
    }
  });
});
