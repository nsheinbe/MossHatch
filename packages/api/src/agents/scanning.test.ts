import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN } from "../testing/app.ts";
import { mintToken } from "../util/token.ts";
import { bearer, createAgentToken, makeAgentKit, makeDomain, makeOwner, type AgentKit, type Owner } from "./testkit.ts";

let k: AgentKit; let ada: Owner;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "scan"); await makeDomain(k, ada, `scan-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });

const deliver = async (body: string, headers: Record<string, string>) => {
  const res = await k.app.router!.dispatch(k.app.ctx, new Request(`${TEST_ORIGIN}/api/v1/hooks/github-secret-scanning`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};
const signed = (body: string) => ({ "github-public-key-identifier": k.github.id, "github-public-key-signature": k.github.sign(body) });

describe("ST-68: the secret-scanning receiver revokes a reported token once and emails the owner", () => {
  it("verifies GitHub's signature, revokes, emails once, and answers with hashes only", async () => {
    const t = await createAgentToken(k, ada, ["domains.read:*"], { name: "Leaky bot" });
    expect((await bearer(k, t.token, "GET", "/api/v1/whoami")).status).toBe(200);
    const stranger = mintToken("live").token;
    const body = JSON.stringify([
      { token: t.token, type: "mosshatch_token", url: "https://github.com/someone/repo/blob/main/.env", source: "content" },
      { token: stranger, type: "mosshatch_token", url: "https://github.com/x/y", source: "content" },
      { token: "not even a token", type: "mosshatch_token", source: "content" },
    ]);
    k.app.email.clear();
    const r = await deliver(body, signed(body));
    expect(r.status, r.text).toBe(200);
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    expect(r.json).toEqual([
      { token_hash: sha(t.token), token_type: "mosshatch_token", label: "true_positive" },
      { token_hash: sha(stranger), token_type: "mosshatch_token", label: "false_positive" },
      { token_hash: sha("not even a token"), token_type: "mosshatch_token", label: "false_positive" },
    ]);
    expect((await bearer(k, t.token, "GET", "/api/v1/whoami")).status).toBe(401);
    const mails = k.app.email.sent.filter((m) => m.kind === "binding.leaked");
    expect(mails.length).toBe(2);                                     // login and second address, one event
    expect(mails[0]!.text).toContain("Leaky bot");
    // A redelivery (GitHub retries) changes nothing: one revocation, one email.
    const again = await deliver(body, signed(body));
    expect(again.status).toBe(200);
    expect(k.app.email.sent.filter((m) => m.kind === "binding.leaked").length).toBe(2);
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'binding.revoked' and resource_id = $1", [t.id])).rows[0].n).toBe(1);
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'binding.leak_reported' and resource_id = $1", [t.id])).rows[0].n).toBe(2);
    // Nothing stored the reported token or the leak's location.
    const stores = (await Promise.all(["audit_log", "webhook_events", "jobs", "alerts", "email_log"].map(async (x) => JSON.stringify((await k.app.db.owner.query(`select * from ${x}`)).rows)))).join("\n");
    for (const s of [t.token, stranger, "someone/repo"]) expect(stores.includes(s)).toBe(false);
    expect(JSON.stringify(k.app.email.sent).includes(t.token)).toBe(false);
  });

  it("refuses a missing, unknown or wrong signature before the handler runs", async () => {
    const t = await createAgentToken(k, ada, ["domains.read:*"], { name: "Safe bot" });
    const body = JSON.stringify([{ token: t.token, type: "mosshatch_token", source: "content" }]);
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    for (const h of [{}, { "github-public-key-identifier": k.github.id }, { "github-public-key-identifier": "unknown-key-id-000000", "github-public-key-signature": k.github.sign(body) },
      { "github-public-key-identifier": k.github.id, "github-public-key-signature": k.github.sign(body, other.privateKey) },
      { "github-public-key-identifier": k.github.id, "github-public-key-signature": k.github.sign(body + " ") }] as Record<string, string>[]) {
      const r = await deliver(body, h);
      expect(r.status).toBe(400);
    }
    expect((await bearer(k, t.token, "GET", "/api/v1/whoami")).status).toBe(200);
    // Keys are cached: the key document is not fetched on every delivery.
    const calls = k.github.calls;
    await deliver(body.replace("Safe", "x"), signed("[]"));
    expect(k.github.calls - calls).toBeLessThanOrEqual(1);
  });
});
