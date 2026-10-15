import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runRegistrarContract } from "../contract.ts";
import { CONTRACT_FIXTURE, LIFECYCLE_FIXTURE, OPENPROVIDER_EXCLUSIONS, makeAdapter, replayRig, runLifecycle, seedRandom, subject } from "./testing.ts";

/**
 * Offline: the shared contract and the lifecycle replayed from responses RECORDED from the Openprovider sandbox on 2026-09-30
 * (fixtures/*.recorded-sandbox.json, scrubbed). Every request must match the recording in order, so this also proves the adapter still sends
 * exactly what the sandbox accepted. Re-record with sandbox.test.ts (OPENPROVIDER_RECORD=1) after changing what the adapter sends.
 */
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); });

describe("Openprovider replay: shared contract (source: recorded-sandbox)", () => {
  const rig = replayRig(CONTRACT_FIXTURE);
  let restore: { mockRestore(): void } | undefined;
  beforeAll(() => { restore = seedRandom(); vi.setSystemTime(new Date(rig.fixture.exchanges[0]!.at)); });
  afterAll(() => { restore?.mockRestore(); });
  it("the fixture is labelled recorded-sandbox with its date and carries no token, password or handle", () => {
    expect(rig.fixture).toMatchObject({ source: "recorded-sandbox", recordedOn: "2026-09-30", baseUrl: "https://api.sandbox.openprovider.nl/v1" });
    const text = JSON.stringify(rig.fixture);
    expect(text).not.toMatch(/\b[A-Z]{2}\d{6}-[A-Z]{2}\b/);
    for (const x of rig.fixture.exchanges.filter((e) => e.path === "/auth/login")) {
      expect(x.body).toEqual({ username: "<redacted>", password: "<redacted>", ip: "0.0.0.0" });
      expect(JSON.stringify(x.response)).toContain("<redacted-token>");
    }
  });
  runRegistrarContract(() => subject(rig, "replay-password"), { tags: ["both", "sandbox-only"], label: "OpenproviderAdapter over recorded sandbox responses", exclude: OPENPROVIDER_EXCLUSIONS });
  it("consumed every recorded exchange", () => { expect(rig.replay.remaining).toBe(0); });
});

describe("Openprovider replay: lifecycle (source: recorded-sandbox)", () => {
  it("replays the safe lifecycle prefix and blocks the historical unverified signed nameserver bypass", async () => {
    const rig = replayRig(LIFECYCLE_FIXTURE);
    vi.setSystemTime(new Date(rig.fixture.exchanges[0]!.at));
    const obs = await runLifecycle(makeAdapter(rig.transport, "replay-password"), rig.freshName, { safePrefixOnly: true });
    expect(obs).toMatchObject({ quoteCom1y: "1198", debit: "1198", managedKeyAlgorithm: 8, stoppedAt: "unverified_signed_delegation" });
    // Untouched historical fixture: unsafe delegation and later steps are not represented as current integration proof.
    expect(rig.replay.remaining).toBeGreaterThan(0);
  });
});
