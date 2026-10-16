import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, type Kit } from "./testkit.ts";
import { makeUser } from "../stepup/testkit.ts";

describe("DC-01: dns_hosted_here follows the nameservers already stored", () => {
  let k: Kit;
  beforeAll(async () => { k = await makeKit(); }, 120_000);

  it("corrects a stale column from the stored nameservers and does not ask the registrar", async () => {
    const user = await makeUser(k.app, "hosted-sync@example.org");
    const insert = async (fqdn: string, ns: string[], hosted: boolean) =>
      (await k.app.db.owner.query(
        `insert into domains (user_id, fqdn_ascii, tld, registrar, state, nameservers, dns_hosted_here, livemode)
         values ($1,$2,'dev','mock','registered',$3,$4,false) returning id`,
        [user.userId, fqdn, ns, hosted])).rows[0].id as string;

    const op = await insert("op-hosted.example.dev", ["NS1.Openprovider.NL.", "ns2.openprovider.be", "ns3.openprovider.eu"], false);
    const sys = await insert("sys-hosted.example.dev", ["ns1.systemdns.com", "ns2.systemdns.com"], false);
    const foreign = await insert("foreign-hosted.example.dev", ["ns1.example.net", "ns2.example.net"], true);
    const mixed = await insert("mixed-hosted.example.dev", ["ns1.openprovider.nl", "ns1.example.net"], true);
    const empty = await insert("empty-hosted.example.dev", [], true);

    const calls = { ...k.registrar.calls };
    const changed = await k.app.db.owner.query("select sync_dns_hosted_here() as n");
    expect(Number(changed.rows[0].n)).toBe(5);

    const flag = async (id: string) =>
      (await k.app.db.owner.query("select dns_hosted_here from domains where id = $1", [id])).rows[0].dns_hosted_here as boolean;
    expect(await flag(op)).toBe(true);
    expect(await flag(sys)).toBe(true);
    expect(await flag(foreign)).toBe(false);
    expect(await flag(mixed)).toBe(false);
    expect(await flag(empty)).toBe(false);
    expect(k.registrar.calls).toEqual(calls);

    const again = await k.app.db.owner.query("select sync_dns_hosted_here() as n");
    expect(Number(again.rows[0].n)).toBe(0);
  });
});
