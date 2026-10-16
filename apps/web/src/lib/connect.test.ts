import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  ALIAS_DELEGATE, ALIAS_STAYS, APPLIED_NOTE, CHANGED_NOTE, blockedCopy, consentPath, explainConnect, planLines, presetsRequestsOn, presetsSectionOn, readPlanError,
  type ConnectCapabilities, type ConnectPlanView,
} from "./connect";

const caps = (over: Partial<ConnectCapabilities>): ConnectCapabilities => ({
  apply: false, presets: false, ui: false, discovery: false, domainconnect_apply: false, verify: false, delegate: false, ai: false, ...over,
});

const plan = (add: ConnectPlanView["dns"]["add"], remove: ConnectPlanView["dns"]["remove"] = []): ConnectPlanView => ({
  v: 1, source: "preset", source_id: "github-pages", source_version: 1, fqdn: "pages.dev", zone_before: "abc",
  dns: { add, remove }, warnings: [], blocked: null, sensitive: [],
});

describe("DC-06: the presets section stays quiet until its flags are on", () => {
  it("hides the section and makes no preset request when the UI flag is off", () => {
    expect(presetsSectionOn(null)).toBe(false);
    expect(presetsSectionOn(caps({}))).toBe(false);
    expect(presetsRequestsOn(caps({ presets: true }))).toBe(false);
    expect(presetsSectionOn(caps({ ui: true }))).toBe(true);
    expect(presetsRequestsOn(caps({ ui: true, presets: true }))).toBe(true);
    const tab = readFileSync(new URL("../ui/ConnectTab.tsx", import.meta.url), "utf8");
    const section = readFileSync(new URL("../ui/ConnectPresets.tsx", import.meta.url), "utf8");
    expect(tab).toContain("Point ");
    expect(tab).toContain("<ConnectPresets");
    expect(section).toContain("if (!presetsRequestsOn(c)) return;");
    expect(section).toContain("if (!presetsSectionOn(caps) || !caps) return null");
    expect(section).toMatch(/if \(!presetsRequestsOn\(c\)\) return;\s*const list = await listConnectPresets\(\)/);
  });

  it("shows every GitHub address before confirm, and a changed plan is not a success", () => {
    const lines = planLines(plan(
      ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"].map((value) => ({ type: "A", name: "", value })),
      [{ type: "A", name: "", value: "192.0.2.1" }],
    ));
    expect(lines.add).toEqual(["A @ 185.199.108.153", "A @ 185.199.109.153", "A @ 185.199.110.153", "A @ 185.199.111.153"]);
    expect(lines.remove).toEqual(["A @ 192.0.2.1"]);
    const next = plan([{ type: "TXT", name: "status", value: "hello" }]);
    const err = new ApiError(409, "plan_changed", undefined, { plan: next, plan_hash: "ab".repeat(32) });
    const fault = readPlanError(err);
    expect(fault).toEqual({ kind: "changed", plan: next, plan_hash: "ab".repeat(32) });
    expect(explainConnect(err)).toBe(CHANGED_NOTE);
    expect(CHANGED_NOTE).not.toContain(APPLIED_NOTE);
    expect(explainConnect(err)).not.toMatch(/^Applied/);
  });

  it("uses the delegation sentence only when that flag is on", () => {
    expect(blockedCopy("needs_alias", "server", false)).toBe(ALIAS_STAYS);
    expect(blockedCopy("needs_alias", "server", true)).toBe(ALIAS_DELEGATE);
    expect(blockedCopy("wildcard_refused", "A wildcard host is not added.", false)).toBe("A wildcard host is not added.");
    const blocked = new ApiError(422, "needs_alias", undefined, { plan: { ...plan([]), blocked: { code: "needs_alias", message: "alias" } } });
    expect(readPlanError(blocked)?.kind).toBe("blocked");
  });
});

describe("DC-08: the consent page is only the two-segment path", () => {
  it("reads the provider and service from the path and ignores other routes", () => {
    expect(consentPath("/domainconnect/consent/example.com/site")).toEqual({ providerId: "example.com", serviceId: "site" });
    expect(consentPath("/domainconnect/consent/example.com%2Fevil/site")).toBeNull();
    expect(consentPath("/device")).toBeNull();
    expect(consentPath("/domainconnect/consent/example.com")).toBeNull();
  });
});
