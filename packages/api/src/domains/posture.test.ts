import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commit, prepare } from "../stepup/testkit.ts";
import { expectedPrivacy, runPosture } from "./posture.ts";
import { installDomains } from "./wiring.ts";
import { alertRows, at, buyDomain, domainRow, findings, hygiene, makeDomainsHarness, makeOwner, relogin, settle, type DomainsHarness, type Owner } from "./testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { syncDomain } from "./sync.ts";

let h: DomainsHarness; let ada: Owner;
beforeAll(async () => { h = await makeDomainsHarness(); ada = await makeOwner(h, "posture@example.com"); }, 120_000);
afterAll(async () => { await h?.app.drop(); });

const mismatchFields = async (domainId: string) => (await findings(h, "mismatch")).filter((f) => f.domain_id === domainId).flatMap((f) => f.fields as string[]).sort();

describe("ST-113: the nightly posture job", () => {
  it("expects .ai and .io to show contacts and every other extension to redact", () => {
    expect(expectedPrivacy("ai")).toBe("not_available");
    expect(expectedPrivacy("io")).toBe("not_available");
    for (const t of ["com", "dev", "app", "studio"]) expect(expectedPrivacy(t)).toBe("redacted_default");
  });

  it("a clean registrar passes: auto_renew off, locked, the expected privacy, and the Horizon test profile's login redirects", async () => {
    await buyDomain(h, ada, "free-posture1.dev");
    await buyDomain(h, ada, "free-posture2.io");
    const r = await runPosture(h.app.ctx);
    expect(r).toMatchObject({ checked: 2, mismatches: 0, errors: 0, endUser: "redirects" });
    expect(h.probe.calls.length).toBeGreaterThanOrEqual(1);       // the engine may already have run tonight's job once
    expect(new Set(h.probe.calls)).toEqual(new Set(["horizon-test-profile"]));
    expect(await findings(h, "mismatch")).toHaveLength(0);
    expect(await alertRows(h, "end_user_interface_reachable")).toHaveLength(0);
  });

  it("auto_renew and let_expire switched on at the registrar are found and put back off at once", async () => {
    const d = await buyDomain(h, ada, "free-posture3.dev");
    h.registrar.oob.setAutoRenew(d.fqdn, true);
    h.registrar.oob.letExpire(d.fqdn, true);
    const before = h.registrar.calls.setAutoRenew;
    const r = await runPosture(h.app.ctx);
    expect(r.mismatches).toBe(1);
    expect(await mismatchFields(d.id)).toEqual(["auto_renew", "let_expire"]);
    expect(h.registrar.calls.setAutoRenew - before).toBe(1);
    const st = (await h.registrar.getDomain(d.fqdn))!;
    expect([st.autoRenew, st.letExpire]).toEqual([false, false]);
    // A second night finds it clean.
    expect((await runPosture(h.app.ctx)).mismatches).toBe(0);
  });

  it("an unlocked domain with no committed unlock is re-locked; one the person unlocked with a passkey is left alone", async () => {
    ada = await relogin(h, ada);
    const stray = await buyDomain(h, ada, "free-posture4.dev");
    const asked = await buyDomain(h, ada, "free-posture5.dev");
    const prep = await prepare(h.app, ada.user, { type: "domain.unlock", target_id: asked.fqdn, user_input: {} });
    expect((await commit(h.app, ada.user, prep.json.action_id, ada.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
    h.registrar.oob.setLock(stray.fqdn, false);
    h.registrar.oob.setLock(asked.fqdn, false);
    const r = await runPosture(h.app.ctx);
    expect(r.mismatches).toBe(1);
    expect(await mismatchFields(stray.id)).toEqual(["lock"]);
    expect(await mismatchFields(asked.id)).toEqual([]);
    expect((await h.registrar.getDomain(stray.fqdn))!.locked).toBe(true);
    expect((await h.registrar.getDomain(asked.fqdn))!.locked).toBe(false);
  });

  it("the paid privacy service switched on is a finding for a person (the product does not sell it)", async () => {
    const d = await buyDomain(h, ada, "free-posture6.dev");
    h.registrar.oob.setPrivacyService(d.fqdn, true);
    await runPosture(h.app.ctx);
    expect(await mismatchFields(d.id)).toEqual(["privacy"]);
  });

  it("an end-user interface that a test profile can reach pages; once it redirects again the page closes; an unconfigured probe is a warning, not silence", async () => {
    h.probe.verdict = "reachable";
    const bad = await runPosture(h.app.ctx);
    expect(bad.endUser).toBe("reachable");
    expect((await alertRows(h, "end_user_interface_reachable")).map((a) => a.severity)).toEqual(["page"]);
    expect((await findings(h, "mismatch")).some((f) => (f.fields as string[]).includes("end_user_interface"))).toBe(true);
    h.probe.verdict = "redirects";
    await runPosture(h.app.ctx);
    expect(await alertRows(h, "end_user_interface_reachable")).toHaveLength(0);
    installDomains(h.app.ctx, {});
    const none = await runPosture(h.app.ctx);
    expect(none.endUser).toBe("not_configured");
    expect((await alertRows(h, "posture_probe_not_configured")).map((a) => a.severity)).toEqual(["warn"]);
    installDomains(h.app.ctx, { endUserProbe: h.probe, probeProfile: "horizon-test-profile" });
  });

  it("review: the owner's passkey unlock is the expected lock state however long it lasts; a re-lock by posture is recorded, replaces the code and is not paged as unattributed", async () => {
    const h2 = await makeDomainsHarness();
    try {
      let o = await makeOwner(h2, "posture-review@example.com");
      const moving = await buyDomain(h2, o, "free-posture7.dev");
      const stray = await buyDomain(h2, o, "free-posture8.dev");
      const back = await buyDomain(h2, o, "free-posture9.dev");
      for (const d of [moving, stray, back]) await syncDomain(h2.app.ctx, d.id);
      const unlock = async (fqdn: string) => {
        await hygiene(h2);
        const prep = await prepare(h2.app, o.user, { type: "domain.unlock", target_id: fqdn, user_input: {} });
        expect((await commit(h2.app, o.user, prep.json.action_id, o.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
        const r = await h2.app.call("POST", `/api/v1/domains/${fqdn}/unlock`, { cookie: o.cookie, body: {}, headers: { [ACTION_HEADER]: prep.json.action_id } });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
      };
      // The owner unlocks one name and takes its code to move it (the gaining registrar starts the transfer), and unlocks then locks another again.
      await unlock(moving.fqdn);
      const prep = await prepare(h2.app, o.user, { type: "domain.transfer_out", target_id: moving.fqdn, user_input: {} });
      expect((await commit(h2.app, o.user, prep.json.action_id, o.key.auth.get(prep.json.webauthn_options))).status).toBe(200);
      expect((await h2.app.call("POST", `/api/v1/domains/${moving.fqdn}/transfer-out`, { cookie: o.cookie, body: {}, headers: { [ACTION_HEADER]: prep.json.action_id } })).status).toBe(200);
      h2.registrar.oob.startTransferAway(moving.fqdn, { gainingRegistrar: "Gaining Registrar Inc" });
      await syncDomain(h2.app.ctx, moving.id);
      await unlock(back.fqdn);
      expect((await h2.app.call("POST", `/api/v1/domains/${back.fqdn}/lock`, { cookie: o.cookie, body: {} })).status).toBe(200);
      // Eight days later the transfer is still pending; someone unlocks the other two names without a passkey.
      at(h2, new Date(h2.app.clock.now().getTime() + 8 * 86_400_000));
      o = await relogin(h2, o);
      h2.registrar.oob.setLock(stray.fqdn, false);
      h2.registrar.oob.setLock(back.fqdn, false);
      for (const d of [moving, stray, back]) await syncDomain(h2.app.ctx, d.id);
      const rr = h2.registrar.calls.rerandomizeAuthCode;
      const r = await runPosture(h2.app.ctx);
      expect(r.mismatches).toBe(2);
      // The owner's unlock stands: not re-locked, no finding.
      expect((await h2.registrar.getDomain(moving.fqdn))!.locked).toBe(false);
      const fieldsIn = async (id: string, kind: string) => (await findings(h2, kind)).filter((f) => f.domain_id === id).flatMap((f) => f.fields as string[]).sort();
      expect(await fieldsIn(moving.id, "mismatch")).toEqual([]);
      // The two unlocks nobody asked for are locked again at the registrar and in our row, and each code is replaced.
      for (const d of [stray, back]) {
        expect((await h2.registrar.getDomain(d.fqdn))!.locked, d.fqdn).toBe(true);
        expect((await domainRow(h2, d.id)).locked, d.fqdn).toBe(true);
        expect(await fieldsIn(d.id, "mismatch")).toEqual(["lock"]);
      }
      expect(h2.registrar.calls.rerandomizeAuthCode - rr).toBe(2);
      // The next sync does not page posture's own re-lock as an unattributed change (only the unlocks themselves were).
      const before = await findings(h2, "unexplained_change");
      for (const d of [moving, stray, back]) await syncDomain(h2.app.ctx, d.id);
      expect((await findings(h2, "unexplained_change")).length).toBe(before.length);
      expect(await fieldsIn(moving.id, "unexplained_change")).toEqual([]);
    } finally { await h2.app.drop(); }
  });

  it("registrar.posture runs nightly from the jobs table", async () => {
    at(h, new Date(h.app.clock.now().getTime() + 26 * 3600_000));
    await settle(h);
    const runs = (await h.app.db.owner.query("select finished_at from reconciliation_runs where kind = 'posture'")).rows;
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.finished_at)).toBe(true);
  });
});
