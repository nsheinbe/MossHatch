import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeDomain, makeKit, makePerson, resetFuse, tick, type Kit, type Person } from "../domain-mgmt/testkit.ts";
import { answersMatch, storedProviderBlocks, type ConnectVerifyProbe, type VerifyAnswer } from "./verify.ts";

const NEW: VerifyAnswer = { type: "A", name: "cdn", value: "192.0.2.9" };
const OLD: VerifyAnswer = { type: "A", name: "cdn", value: "192.0.2.1" };

describe("DC-12: provider facts already on the connection", () => {
  it("blocks on a Vercel misconfigured flag and on a Resend record that is not verified", () => {
    expect(storedProviderBlocks([])).toBe(false);
    expect(storedProviderBlocks([{ service: "vercel", provider_facts: { misconfigured: false } }])).toBe(false);
    expect(storedProviderBlocks([{ service: "vercel", provider_facts: { misconfigured: true } }])).toBe(true);
    expect(storedProviderBlocks([{ service: "resend", provider_facts: { records: [{ type: "TXT", status: "verified" }] } }])).toBe(false);
    expect(storedProviderBlocks([{ service: "resend", provider_facts: { records: [{ type: "TXT", status: "pending" }] } }])).toBe(true);
    expect(answersMatch([NEW], [NEW])).toBe(true);
    expect(answersMatch([OLD], [NEW])).toBe(false);
  });
});

describe("DC-12: propagation", () => {
  let k: Kit;
  let p: Person;
  let calls: { resolver: string[]; tls: string[] };
  let auth: VerifyAnswer[];
  let pub: VerifyAnswer[];
  let tlsOk: boolean;
  beforeAll(async () => { k = await makeKit(); p = await makePerson(k, "verify"); }, 120_000);
  beforeEach(async () => {
    await resetFuse(k);
    calls = { resolver: [], tls: [] };
    auth = [NEW];
    pub = [NEW];
    tlsOk = true;
    const probe: ConnectVerifyProbe = {
      authoritative: async () => [auth],
      resolver: async (_which, fqdn) => { calls.resolver.push(fqdn); return pub; },
      tls: async (fqdn) => { calls.tls.push(fqdn); return tlsOk; },
    };
    (k.app.ctx.services as { connectVerify: ConnectVerifyProbe }).connectVerify = probe;
    await k.app.db.owner.query("update flags set value = 'true'::jsonb where name in ('connect.apply','connect.verify')");
  });
  const state = async (id: string) => (await k.app.db.owner.query("select verify_state from connect_plans where id = $1", [id])).rows[0].verify_state as string | null;
  const jobs = async (id: string) => (await k.app.db.owner.query("select count(*)::int n from jobs where kind = 'dns.verify' and payload->>'plan_id' = $1", [id])).rows[0].n as number;
  const planA = async (fqdn: string) => {
    const planned = await call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans`, { source: "pasted", records: [{ type: "A", name: "cdn", value: "192.0.2.9" }] });
    expect(planned.status, JSON.stringify(planned.json)).toBe(200);
    const done = await call(k, p, "POST", `/api/v1/domains/${fqdn}/connect/plans/${planned.json.plan_id}/apply`, { plan_hash: planned.json.plan_hash });
    expect(done.status, JSON.stringify(done.json)).toBe(202);
    return planned.json.plan_id as string;
  };

  it("does not enqueue while connect.verify is off", async () => {
    await k.app.db.owner.query("update flags set value = 'false'::jsonb where name = 'connect.verify'");
    const d = await makeDomain(k, p, "quiet.dev");
    const id = await planA(d.fqdn);
    expect(await jobs(id)).toBe(0);
    expect(await state(id)).toBeNull();
    expect(calls.resolver).toEqual([]);
  });

  it("keeps shedding while an authoritative server still has the old A, and does not ask a public resolver", async () => {
    auth = [OLD];
    const d = await makeDomain(k, p, "shed.dev");
    const id = await planA(d.fqdn);
    await tick(k);
    expect(await state(id)).toBe("shedding");
    expect(calls.resolver.filter((n) => n === d.fqdn)).toEqual([]);
  });

  it("reaches spread only after three matching public samples", async () => {
    const d = await makeDomain(k, p, "spread.com");
    const id = await planA(d.fqdn);
    await tick(k);
    expect(await state(id)).toBe("pending");
    expect(calls.resolver.filter((n) => n === d.fqdn)).toHaveLength(2);
    k.app.clock.advance(30_000);
    await tick(k);
    expect(await state(id)).toBe("pending");
    k.app.clock.advance(30_000);
    await tick(k);
    expect(await state(id)).toBe("spread");
    expect(calls.tls.filter((n) => n === d.fqdn)).toEqual([]);
  });

  it("stays short of spread on a .dev name when the certificate check fails", async () => {
    tlsOk = false;
    const d = await makeDomain(k, p, "tls.dev");
    const id = await planA(d.fqdn);
    await tick(k);
    expect(await state(id)).not.toBe("spread");
    expect(calls.tls.filter((n) => n === d.fqdn)).toEqual([d.fqdn]);
    expect(calls.resolver.filter((n) => n === d.fqdn)).toHaveLength(2);
  });
});
