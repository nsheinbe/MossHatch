import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runRegistrarContract } from "../contract.ts";
import { CONTRACT_FIXTURE, LIFECYCLE_FIXTURE, OPENPROVIDER_EXCLUSIONS, liveRig, makeAdapter, runLifecycle, seedRandom, subject } from "./testing.ts";

/**
 * LIVE run against api.sandbox.openprovider.nl (play money; nothing reaches a registry). Skipped unless OPENPROVIDER_PASSWORD is set, so CI never
 * runs it. OPENPROVIDER_RECORD=1 also rewrites the scrubbed replay fixtures that replay.test.ts plays back offline.
 *   OPENPROVIDER_PASSWORD=... [OPENPROVIDER_USERNAME=...] [OPENPROVIDER_RECORD=1] npx vitest run packages/registrar/src/openprovider/sandbox.test.ts
 */
const password = process.env.OPENPROVIDER_PASSWORD ?? "";
const record = process.env.OPENPROVIDER_RECORD === "1";
const live = password !== "" && !process.env.CI;
vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

describe.skipIf(!live)("Openprovider sandbox (live)", () => {
  describe("shared contract", () => {
    const rig = liveRig(CONTRACT_FIXTURE, record, "runRegistrarContract tags both + sandbox-only, Openprovider exclusions");
    let restore: { mockRestore(): void } | undefined;
    beforeAll(() => { restore = seedRandom(); });
    afterAll(() => { restore?.mockRestore(); rig.finish(); });
    runRegistrarContract(() => subject(rig, password), { tags: ["both", "sandbox-only"], label: "OpenproviderAdapter (live sandbox)", exclude: OPENPROVIDER_EXCLUSIONS });
  });

  describe("lifecycle", () => {
    const rig = liveRig(LIFECYCLE_FIXTURE, record, "runLifecycle: register, lock, codes, DNS, DNSSEC, nameservers, contacts, renew, transfers");
    afterAll(() => rig.finish());
    it("register, lock/unlock, auth codes, DNS replace-all, DNSSEC keys, nameservers, contacts, renew, transfer refusals", async () => {
      const obs = await runLifecycle(makeAdapter(rig.transport, password), rig.freshName);
      console.info("openprovider sandbox observations", JSON.stringify(obs));
      expect(obs.debit).toBe(obs.quoteCom1y);
    });
  });
});
