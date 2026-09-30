import { describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { FakeEmail, sendMail } from "../email.ts";
import { mintToken } from "../util/token.ts";
import { FakeDns, type FakeZone } from "./dns.ts";
import { GatedEmail, MailGateError, verifyMailDomain, type MailDomainExpectation } from "./gate.ts";
import { assertMailSafe, buildMail, EMAIL_ACTION_PURPOSES, MAIL_KINDS, MailRenderError, renderMail, TEMPLATES, type MailKind } from "./templates.ts";
import { createEmailTransport, LogOnlyEmail, ResendTransport } from "./transport.ts";

const EXP: MailDomainExpectation = { spfInclude: "amazonses.com", dkimSelectors: ["resend"] };
const GOOD: FakeZone = {
  txt: {
    "send.mosshatch.com": [["v=spf1 include:amazonses.com ~all"]],
    "resend._domainkey.send.mosshatch.com": [["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN"]],
    "_dmarc.send.mosshatch.com": [["v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:d@mosshatch.com"]],
  },
};
const zone = (patch: (z: FakeZone) => void) => { const z: FakeZone = JSON.parse(JSON.stringify(GOOD)); patch(z); return new FakeDns(z); };
const DOMAIN = "send.mosshatch.com";

describe("ST-146 SPF, DKIM and DMARC gate", () => {
  it("ST-146: a correctly configured sending domain passes", async () => {
    expect(await verifyMailDomain(zone(() => undefined), DOMAIN, EXP)).toMatchObject({ ok: true, spf: true, dkim: true, dmarc: true, failures: [] });
  });
  it("ST-146: every weakening fails with a named reason", async () => {
    const cases: [string, (z: FakeZone) => void, string][] = [
      ["no spf", (z) => { delete z.txt![DOMAIN]; }, "spf_missing"],
      ["two spf", (z) => { z.txt![DOMAIN] = [["v=spf1 include:amazonses.com -all"], ["v=spf1 include:other.example -all"]]; }, "spf_multiple"],
      ["provider missing", (z) => { z.txt![DOMAIN] = [["v=spf1 include:other.example -all"]]; }, "spf_provider_missing"],
      ["open spf", (z) => { z.txt![DOMAIN] = [["v=spf1 include:amazonses.com +all"]]; }, "spf_not_closed"],
      ["no dkim", (z) => { delete z.txt!["resend._domainkey.send.mosshatch.com"]; }, "dkim_missing:resend"],
      ["revoked dkim", (z) => { z.txt!["resend._domainkey.send.mosshatch.com"] = [["v=DKIM1; k=rsa; p="]]; }, "dkim_revoked:resend"],
      ["no dmarc", (z) => { delete z.txt!["_dmarc.send.mosshatch.com"]; }, "dmarc_missing"],
      ["dmarc none", (z) => { z.txt!["_dmarc.send.mosshatch.com"] = [["v=DMARC1; p=none; adkim=s; aspf=s"]]; }, "dmarc_policy"],
      ["dmarc relaxed", (z) => { z.txt!["_dmarc.send.mosshatch.com"] = [["v=DMARC1; p=reject"]]; }, "dmarc_not_strict"],
      ["dmarc pct", (z) => { z.txt!["_dmarc.send.mosshatch.com"] = [["v=DMARC1; p=reject; adkim=s; aspf=s; pct=50"]]; }, "dmarc_pct"],
      ["servfail", (z) => { z.fail = [DOMAIN]; }, "dns_error"],
    ];
    for (const [name, patch, want] of cases) {
      const r = await verifyMailDomain(zone(patch), DOMAIN, EXP);
      expect(r.ok, name).toBe(false);
      expect(r.failures, name).toContain(want);
    }
  });

  const receipt = { kind: "receipt", dedupeKey: "r1", to: ["a@example.com"], subject: "s", text: "t" };
  it("ST-146: in production a receipt is refused until the gate passes; other mail is not held", async () => {
    let t = 0; const inner = new FakeEmail();
    const dns = zone((z) => { delete z.txt!["_dmarc.send.mosshatch.com"]; });
    const g = new GatedEmail(inner, { config: { mode: "production" }, resolver: dns, domain: DOMAIN, expectation: EXP, now: () => t, ttlMs: 1000 });
    await expect(g.send(receipt)).rejects.toMatchObject({ name: "MailGateError", failures: ["dmarc_missing"] });
    await expect(g.send({ ...receipt, kind: "void_notice", dedupeKey: "v1" })).rejects.toBeInstanceOf(MailGateError);
    expect(inner.sent).toHaveLength(0);
    await g.send({ ...receipt, kind: "signup_code", dedupeKey: "c1" });                // not a money mail
    expect(inner.sent).toHaveLength(1);
    // DNS is fixed; the verdict is reused until its TTL runs out, then re-checked.
    dns.zone.txt!["_dmarc.send.mosshatch.com"] = [["v=DMARC1; p=reject; adkim=s; aspf=s"]];
    await expect(g.send(receipt)).rejects.toBeInstanceOf(MailGateError);
    t = 1500;
    await g.send(receipt);
    expect(inner.sent.map((m) => m.kind)).toEqual(["signup_code", "receipt"]);
    // DNS breaks again: the gate closes after the TTL.
    delete dns.zone.txt![DOMAIN]; t = 3000;
    await expect(g.send({ ...receipt, dedupeKey: "r2" })).rejects.toBeInstanceOf(MailGateError);
  });
  it("ST-146: staging is gated like production; local and preview use a log-only transport and are not gated", async () => {
    const bad = zone((z) => { z.txt = {}; });
    for (const mode of ["production", "staging"] as const) {
      const g = new GatedEmail(new FakeEmail(), { config: { mode }, resolver: bad, domain: DOMAIN, expectation: EXP, now: () => 0 });
      await expect(g.send(receipt)).rejects.toBeInstanceOf(MailGateError);
    }
    const lines: string[] = [];
    for (const mode of ["local", "preview"] as const) {
      const t = createEmailTransport({ mode }, { log: (l) => lines.push(l) });
      expect(t).toBeInstanceOf(LogOnlyEmail);
      await t.send({ ...receipt, dedupeKey: "k-" + mode });
    }
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("example.com");                             // no address in the log
    expect(() => createEmailTransport({ mode: "production" }, {})).toThrow("resend_not_configured");
  });
  it("ST-146: through sendMail a refused receipt leaves no email_log row and sends after the gate opens", async () => {
    const app: TestApp = await createTestApp();
    try {
      let t = 0; const inner = new FakeEmail();
      const dns = zone((z) => { delete z.txt!["_dmarc.send.mosshatch.com"]; });
      const g = new GatedEmail(inner, { config: { mode: "production" }, resolver: dns, domain: DOMAIN, expectation: EXP, now: () => t, ttlMs: 10 });
      await expect(tx(app.ctx.cron, (c) => sendMail(c, g, receipt))).rejects.toBeInstanceOf(MailGateError);
      expect((await app.db.owner.query("select count(*)::int as n from email_log")).rows[0].n).toBe(0);
      dns.zone.txt!["_dmarc.send.mosshatch.com"] = [["v=DMARC1; p=reject; adkim=s; aspf=s"]]; t = 100;
      expect(await tx(app.ctx.cron, (c) => sendMail(c, g, receipt))).toEqual({ sent: true });
      expect(inner.sent).toHaveLength(1);
    } finally { await app.drop(); }
  }, 60_000);
});

describe("Resend transport (request shape only: the network is not reachable from the build container)", () => {
  it("posts to /emails with the key, an idempotency key and a plain-text body, and returns the id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const t = new ResendTransport({ apiKey: "re_test_key", from: "Mosshatch <no-reply@send.mosshatch.com>", fetch: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }); }) as typeof fetch });
    expect(await t.send({ kind: "receipt", dedupeKey: "dk-1", to: ["a@example.com"], subject: "S", text: "T" })).toEqual({ id: "msg_1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_test_key"); expect(h["Idempotency-Key"]).toBe("dk-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: "Mosshatch <no-reply@send.mosshatch.com>", to: ["a@example.com"], subject: "S", text: "T" });
  });
  it("fails with a status code only (no response body, which may echo the address) and refuses an empty key", async () => {
    const t = new ResendTransport({ apiKey: "k", from: "f", fetch: (async () => new Response('{"message":"bad address a@example.com"}', { status: 429 })) as typeof fetch });
    const err = await t.send({ kind: "x", dedupeKey: "d", to: ["a@example.com"], subject: "", text: "" }).catch((e) => e);
    expect(err.code).toBe("http_429"); expect(err.retryable).toBe(true); expect(String(err.message) + JSON.stringify(err)).not.toContain("example.com");
    expect(() => new ResendTransport({ apiKey: "", from: "f" })).toThrow();
  });
});

// ------------------------------------------------------------------------------------------------------------------

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";     // 43 chars base64url, 256 bits
const SAMPLE: { [K in MailKind]: Record<string, unknown> } = {
  signup_code: { code: "K7Q2MZ", ttlMinutes: 15 },
  recovery_started: { coolingOffUntil: "2026-10-03T12:00:00.000Z", cancelToken: TOKEN },
  recovery_completed: { holdUntil: "2026-10-05T12:00:00.000Z" },
  recovery_cancelled: {},
  credential_added: { credentialRef: "a1b2c3d4", at: "2026-10-01T12:00:00.000Z", freezeToken: TOKEN },
  credential_removed: { credentialRef: "a1b2c3d4", at: "2026-10-01T12:00:00.000Z" },
  address_changed: { change: "added", addressKind: "second", at: "2026-10-01T12:00:00.000Z", freezeToken: TOKEN },
  freeze_link: { freezeToken: TOKEN, expiresInHours: 72 },
  receipt: { orderId: "0199f0a0-1111-7222-8333-444455556666", fqdn: "example-name.com", years: 2, totalMinor: "2198", taxMinor: "0", paidAt: "2026-10-01T12:00:00.000Z" },
  void_notice: { orderId: "0199f0a0-1111-7222-8333-444455556666", fqdn: "example-name.com" },
};
const ORIGIN = "https://mosshatch.com";
const urls = (s: string) => s.match(/https?:\/\/[^\s)>"'<]+/g) ?? [];

describe("ST-149 mail contains no vault secret, bearer token or approval link", () => {
  it("every template has a sample here and renders", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...MAIL_KINDS].sort());
    for (const k of MAIL_KINDS) { const r = renderMail(k, SAMPLE[k] as never); expect(r.subject.length).toBeGreaterThan(5); expect(r.text.length).toBeGreaterThan(20); }
  });
  it("ST-149: the only links are the site origin and /api/v1/email-actions/<token>, for a protective purpose, built from the token field", () => {
    const linkPurposes = new Set<string>();
    for (const k of MAIL_KINDS) {
      const r = renderMail(k, SAMPLE[k] as never, { origin: ORIGIN });
      const def = TEMPLATES[k] as { link?: { purpose: string; field: string } };
      const found = [...urls(r.text), ...urls(r.subject)].map((u) => u.replace(/[.,;:]+$/, ""));
      for (const u of found) {
        if (u === ORIGIN || u === ORIGIN + "/") continue;
        expect(u, k).toBe(`${ORIGIN}/api/v1/email-actions/${TOKEN}`);
        expect(def.link, k).toBeTruthy();
        expect(u.endsWith((SAMPLE[k] as any)[def.link!.field]), k).toBe(true);
      }
      if (def.link) { linkPurposes.add(def.link.purpose); expect(EMAIL_ACTION_PURPOSES as readonly string[]).toContain(def.link.purpose); }
    }
    expect([...linkPurposes].sort()).toEqual(["freeze", "recovery_cancel"]);          // auto_renew_off is allowed but no Phase 2 mail uses it
    expect([...EMAIL_ACTION_PURPOSES].sort()).toEqual(["auto_renew_off", "freeze", "recovery_cancel"]);
  });
  it("ST-149: a link is built only when the token is a well-formed 128-bit-plus base64url string", () => {
    for (const bad of ["short", "has spaces in it 0123456789012345", "mh_live_" + "A".repeat(32) + "+deadbeef", "a".repeat(200), TOKEN + "/../../approve"]) {
      expect(() => renderMail("freeze_link", { freezeToken: bad, expiresInHours: 72 }), bad).toThrow(MailRenderError);
    }
  });
  it("ST-149: no string field accepts a bearer token, an approval link, an arbitrary URL or free text", () => {
    const probes = [
      mintToken("live").token, mintToken("cli").token, mintToken("clr").token,
      "https://mosshatch.com/approve/0199f0a0", "https://mosshatch.com/approvals/x?t=1", "http://evil.example/pay/abc", "javascript:alert(1)",
      "sk_live_abc def ghijklmnop", "hunter2 hunter2", "line\nbreak", "",
    ];
    let checked = 0;
    for (const k of MAIL_KINDS) {
      for (const [field, value] of Object.entries(SAMPLE[k])) {
        if (typeof value !== "string") continue;
        for (const p of probes) {
          checked++;
          expect(() => renderMail(k, { ...SAMPLE[k], [field]: p } as never), `${k}.${field} <- ${p.slice(0, 20)}`).toThrow(MailRenderError);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
  it("ST-149: no template accepts an extra field, so a caller cannot pass a secret, token or link through a new variable", () => {
    for (const k of MAIL_KINDS) {
      for (const extra of ["secret", "vaultSecret", "value", "bearer", "approvalLink", "url", "note"]) {
        expect(() => renderMail(k, { ...SAMPLE[k], [extra]: "x" } as never), `${k}+${extra}`).toThrow(MailRenderError);
      }
    }
  });
  it("ST-149: template field names never name a secret, and the only token-like fields are the two protective action tokens", () => {
    const names = new Set<string>();
    for (const k of MAIL_KINDS) for (const f of Object.keys((TEMPLATES[k].schema as any).shape)) names.add(f);
    for (const n of names) expect(n).not.toMatch(/secret|bearer|approval|password|apikey|authcode|pay/i);
    expect([...names].filter((n) => /token/i.test(n)).sort()).toEqual(["cancelToken", "freezeToken"]);
    expect(MAIL_KINDS.some((k) => /pay|approve|approval|secret|reveal/i.test(k))).toBe(false);   // no pay-link mail for agent flows
  });
  it("ST-149: the output scan is a second wall, independent of the schemas", () => {
    const ok = { subject: "Fine", text: `Sign in at ${ORIGIN}\n` };
    expect(() => assertMailSafe(ok, ORIGIN, null)).not.toThrow();
    for (const text of [
      "see https://evil.example/x", `${ORIGIN}/approve/123`, `${ORIGIN}/api/v1/email-actions/${TOKEN}`,       // no link allowed here
      `token ${mintToken("live").token}`, "mh_cli_abcdefghijklmnopqrstuvwxyz012345+deadbeef", `${ORIGIN}.evil.example/`,
    ]) expect(() => assertMailSafe({ subject: "Fine", text }, ORIGIN, null), text).toThrow(MailRenderError);
    expect(() => assertMailSafe({ subject: "Fine", text: `${ORIGIN}/api/v1/email-actions/${TOKEN}` }, ORIGIN, `${ORIGIN}/api/v1/email-actions/${TOKEN}`)).not.toThrow();
    expect(() => assertMailSafe({ subject: "Fine", text: `${ORIGIN}/api/v1/email-actions/OTHERtoken0123456789012` }, ORIGIN, `${ORIGIN}/api/v1/email-actions/${TOKEN}`)).toThrow();
    expect(() => assertMailSafe({ subject: "Bearer mh_live_x", text: "" }, ORIGIN, null)).toThrow();
  });
  it("origins other than a bare http(s) origin are refused", () => {
    for (const o of ["https://mosshatch.com/path", "javascript:x", "https://user@evil.example", "mosshatch.com", "https://a.com?x=1"]) expect(() => renderMail("recovery_cancelled", {}, { origin: o }), o).toThrow(MailRenderError);
    expect(renderMail("signup_code", SAMPLE.signup_code as never, { origin: "http://localhost:5173" }).text).toContain("K7Q2MZ");
  });
  it("plain text, sentence case, active voice, no apologies or exclamations", () => {
    for (const k of MAIL_KINDS) {
      const r = renderMail(k, SAMPLE[k] as never);
      const s = r.subject.replace(/Mosshatch/g, "").replace(/\S+\.com/g, "");
      expect(r.subject.charAt(0), k).toMatch(/[A-Z]/);
      expect(s.split(/\s+/).slice(1).filter((w) => /^[A-Z]/.test(w)), `${k} subject case`).toEqual([]);
      expect(r.text, k).not.toMatch(/<[a-z][^>]*>|&nbsp;|!/i);
      expect(r.text + r.subject, k).not.toMatch(/\b(sorry|apolog\w+|unfortunately|please|kindly|oops)\b/i);
      expect(r.text, k).not.toMatch(/\b(was|were|is|are|been)\s+\w+(ed|en)\s+by\b/i);
      expect(r.subject, k).not.toContain("\n");
    }
  });
  it("buildMail produces an EmailMessage with the class and no address in the template output", () => {
    const m = buildMail("freeze_link", SAMPLE.freeze_link as never, { to: ["a@example.com"], dedupeKey: "d1", userId: "u1" });
    expect(m).toMatchObject({ kind: "freeze_link", klass: "B", to: ["a@example.com"], dedupeKey: "d1" });
    expect(m.text).not.toContain("a@example.com");
    expect(buildMail("signup_code", SAMPLE.signup_code as never, { to: ["x@example.com"], dedupeKey: "d2" }).klass).toBe("A");
    expect(buildMail("receipt", SAMPLE.receipt as never, { to: ["x@example.com"], dedupeKey: "d3" }).klass).toBe("C");
  });
  it("the receipt formats money from minor units", () => {
    expect(renderMail("receipt", { ...SAMPLE.receipt, totalMinor: "5", taxMinor: "0" } as never).text).toContain("USD 0.05");
    expect(renderMail("receipt", SAMPLE.receipt as never).text).toContain("USD 21.98");
  });
});

