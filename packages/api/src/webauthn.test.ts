import { describe, expect, it } from "vitest";
import { assertionOptions, challengeOf, registrationOptions, verifyAssertion, verifyRegistration } from "./webauthn.ts";
import { VirtualAuthenticator } from "./testing/authenticator.ts";
import { LocalKms, LocalPii } from "./kms.ts";
import { FakeEmail } from "./email.ts";
import type { AppContext } from "./ports.ts";
import { randomBytes } from "./util/bytes.ts";

const ctx = { config: { rpId: "mosshatch.test", allowedOrigins: ["https://mosshatch.test"], origin: "https://mosshatch.test" }, kms: new LocalKms(), pii: new LocalPii(), email: new FakeEmail() } as unknown as AppContext;
const auth = (o = {}) => new VirtualAuthenticator({ origin: "https://mosshatch.test", rpId: "mosshatch.test", ...o });

describe("webauthn helpers with a virtual authenticator", () => {
  for (const alg of [-7, -257] as const) {
    it(`registers and asserts (alg ${alg})`, async () => {
      const a = auth({ alg });
      const opts = await registrationOptions(ctx, { userHandle: randomBytes(32), email: "u@example.com" });
      const reg = await verifyRegistration(ctx, a.create(opts) as never, opts.challenge);
      expect(reg.alg).toBe(alg); expect(reg.backupEligible).toBe(false);
      const ao = await assertionOptions(ctx, { allowCredentialIds: [reg.credentialId] });
      const resp = a.get(ao) as never;
      expect(challengeOf(resp)).toBe(ao.challenge);
      const v = await verifyAssertion(ctx, resp, ao.challenge, { credentialId: reg.credentialId, publicKey: reg.publicKey, signCount: reg.signCount, backupEligible: false });
      expect(v.userVerified).toBe(true);
    });
  }
  it("ST-41: a wrong origin fails registration and login", async () => {
    const bad = auth({ origin: "https://evil.example" });
    const opts = await registrationOptions(ctx, { userHandle: randomBytes(32), email: "u@example.com" });
    await expect(verifyRegistration(ctx, bad.create(opts) as never, opts.challenge)).rejects.toThrow();
    const good = auth();
    const reg = await verifyRegistration(ctx, good.create(opts) as never, opts.challenge);
    const ao = await assertionOptions(ctx, {});
    await expect(verifyAssertion(ctx, good.get(ao, { origin: "https://evil.example" }) as never, ao.challenge, { credentialId: reg.credentialId, publicKey: reg.publicKey, signCount: 0, backupEligible: false })).rejects.toThrow();
  });
  it("requires user verification", async () => {
    const a = auth({ userVerified: false });
    const opts = await registrationOptions(ctx, { userHandle: randomBytes(32), email: "u@example.com" });
    await expect(verifyRegistration(ctx, a.create(opts) as never, opts.challenge)).rejects.toThrow();
  });
  it("surfaces backup-eligible and backup-state bits", async () => {
    const a = auth({ backupEligible: true, backupState: true });
    const opts = await registrationOptions(ctx, { userHandle: randomBytes(32), email: "u@example.com" });
    const reg = await verifyRegistration(ctx, a.create(opts) as never, opts.challenge);
    expect(reg).toMatchObject({ backupEligible: true, backupState: true });
    a.backupState = false;
    const ao = await assertionOptions(ctx, {});
    const v = await verifyAssertion(ctx, a.get(ao) as never, ao.challenge, { credentialId: reg.credentialId, publicKey: reg.publicKey, signCount: 0, backupEligible: true });
    expect(v).toMatchObject({ backupEligible: true, backupState: false });
  });
});
