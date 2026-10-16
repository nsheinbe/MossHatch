import { describe, expect, it } from "vitest";
import { isProviderDns, OPENPROVIDER_NAMESERVERS } from "./dns.ts";
import { OP_NAMESERVERS } from "./openprovider/adapter.ts";

describe("AUD-O8: one rule says whether a name's DNS is ours", () => {
  it("Openprovider's three nameservers and OpenSRS SystemDNS are ours, in any case or with a trailing dot; anything mixed or empty is not", () => {
    expect(OP_NAMESERVERS).toBe(OPENPROVIDER_NAMESERVERS);
    expect(isProviderDns(OPENPROVIDER_NAMESERVERS)).toBe(true);
    expect(isProviderDns(["NS1.openprovider.nl.", "ns2.openprovider.be"])).toBe(true);
    expect(isProviderDns(["ns1.systemdns.com", "ns2.systemdns.com", "ns3.systemdns.com"])).toBe(true);
    expect(isProviderDns(["ns1.openprovider.nl", "ns1.systemdns.com"])).toBe(false);
    expect(isProviderDns(["ns1.openprovider.nl", "dana.ns.cloudflare.com"])).toBe(false);
    expect(isProviderDns(["dana.ns.cloudflare.com", "rob.ns.cloudflare.com"])).toBe(false);
    expect(isProviderDns([])).toBe(false);
  });
});
