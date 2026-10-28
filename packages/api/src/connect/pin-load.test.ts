import { beforeEach, describe, expect, it } from "vitest";
import { hashOf } from "../util/bytes.ts";
import { buildConnectPlan } from "./plan.ts";
import { installPin, loadPinList, pullPin, reviewTemplate } from "./pin-load.ts";
import { PRODUCTION_PINS } from "./pins.ts";
import { intentFrom } from "./sync.ts";
import { clearPinnedTemplates, pinnedTemplate } from "./templates.ts";

const base = {
  providerId: "example.com", providerName: "Example", serviceId: "site", version: 1,
  syncPubKeyDomain: "example.com", syncRedirectDomain: "example.com",
  records: [{ type: "TXT", host: "status", data: "%token%" }],
};

const pinFor = (body: unknown, version = 1) => ({
  providerId: "example.com", serviceId: "site", version, hash: hashOf(body).toString("hex"),
});

const fetched = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

describe("DC-09: template pins", () => {
  beforeEach(() => { clearPinnedTemplates(); });

  it("ships no production pins", () => {
    expect(PRODUCTION_PINS).toEqual([]);
    expect(loadPinList(PRODUCTION_PINS)).toEqual({ loaded: [], refused: [] });
  });

  it("loads a fetched body only when the hash and the version both match, and the records are the plan", async () => {
    expect(await pullPin({ ...pinFor(base), url: "https://templates.example/site.json" }, fetched(base))).toBe("loaded");
    expect(pinnedTemplate("example.com", "site")).toEqual(base);
    const intent = intentFrom(base, new URLSearchParams("token=hello"));
    expect(intent).toBeTruthy();
    const plan = buildConnectPlan({
      source: "domainconnect", source_id: "example.com/site", source_version: 1,
      domain_id: "00000000-0000-7000-8000-0000000000d9", fqdn: "pin.dev", hosted: true, live: [],
      add: intent!.add, remove: [], replace_addresses: [], spf: intent!.spf, alias: intent!.alias, warnings: intent!.warnings,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.dns.add).toEqual([{ type: "TXT", name: "status", value: "hello" }]);
  });

  it("refuses a fetched body whose hash or version does not match the pin", async () => {
    const moved = { ...base, version: 2 };
    expect(await pullPin({ ...pinFor(base), url: "https://templates.example/site.json" }, fetched(moved))).toBe("refused");
    expect(await pullPin({ ...pinFor(moved), version: 1, url: "https://templates.example/site.json" }, fetched(moved))).toBe("refused");
    expect(pinnedTemplate("example.com", "site")).toBeNull();
  });

  it("refuses an NS record and an apex CNAME, and does not serve either", () => {
    const ns = { ...base, records: [{ type: "NS", host: "@", pointsTo: "ns.example.com" }] };
    const apex = { ...base, records: [{ type: "CNAME", host: "@", pointsTo: "elsewhere.example" }] };
    expect(reviewTemplate(ns).ok).toBe(false);
    expect(reviewTemplate(apex).ok).toBe(false);
    expect(installPin({ ...pinFor(ns), body: ns })).toBe("refused");
    expect(installPin({ ...pinFor(apex), body: apex })).toBe("refused");
    expect(pinnedTemplate("example.com", "site")).toBeNull();
  });
});
