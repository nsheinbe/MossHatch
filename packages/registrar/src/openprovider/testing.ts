import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { expect, vi } from "vitest";
import { RegistrarError, type DnsRecord } from "../port.ts";
import { zoneHash } from "../dns.ts";
import { claimRegistration, registrantFingerprint } from "../claim.ts";
import type { ContractExclusion, ContractSubject } from "../contract.ts";
import { MemoryKillSwitch } from "../opensrs/guards.ts";
import { MemoryOpenproviderCredentials, OP_NAMESERVERS, OpenproviderAdapter } from "./adapter.ts";
import { dsFromDnskey, type Dnskey } from "./dnssec.ts";
import { RecordingTransport, ReplayTransport, fixtureText, loadFixture, type Fixture } from "./replay.ts";
import { SANDBOX_URL, fetchTransport, type OpHttpTransport } from "./transport.ts";

/**
 * Shared by the live sandbox run (sandbox.test.ts) and the offline replay (replay.test.ts). Both must make exactly the same calls in the same
 * order: names come from crypto when live and from the fixture on replay, and Math.random (used by makeRegisterRequest) is seeded in both.
 */
export const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
export const CONTRACT_FIXTURE = new URL("contract.recorded-sandbox.json", FIXTURE_DIR);
export const LIFECYCLE_FIXTURE = new URL("lifecycle.recorded-sandbox.json", FIXTURE_DIR);

/** Contract tests Openprovider cannot pass for a provider reason (docs/registrar-parity.md, Openprovider section). */
export const OPENPROVIDER_EXCLUSIONS: ContractExclusion[] = [
  { name: "capabilities say what OpenSRS cannot do", reason: "the restore map is OpenSRS's; Openprovider offers restore on all six (only .io observed)" },
  { name: "setNameservers changes them", reason: "the sandbox registry refuses hosts it does not know (399) and DS cannot be added by DS; covered by the Openprovider lifecycle" },
  { name: "DS records add (idempotently) and remove", reason: "Openprovider takes DNSKEYs, not DS; covered by the Openprovider lifecycle with addDnskey/removeDs" },
  { name: "issueAuthCode returns a fresh code each time", reason: "Openprovider generates 12-character codes with symbols; .io codes come from the API; covered by the lifecycle" },
  { name: "replaceZone refuses unsupported types", reason: "needs foreign nameservers the sandbox registry refuses; covered by the lifecycle with a mixed set" },
  { name: "updateContact reports a registrant change and does not apply it at once", reason: "Openprovider applies an owner change at once (observed); the lifecycle asserts that" },
];

/** .dev, .app and .studio registrations fail in the sandbox registry (contact errors, observed 2026-09-30), so the contract's names use .com instead. */
export const SANDBOX_TLD: Record<string, string> = { dev: "com", app: "com", studio: "com" };

export function seedRandom(seed = 20260930) {
  let s = seed >>> 0;
  return vi.spyOn(Math, "random").mockImplementation(() => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; });
}

export interface Rig { transport: OpHttpTransport; freshName(tld: string): string; names: string[]; finish(): void }

/** Live: a recording transport over fetch (writes the scrubbed fixture on finish when `record` is set). */
export function liveRig(fixture: URL, record: boolean, note: string): Rig {
  const rec = new RecordingTransport(fetchTransport(), SANDBOX_URL);
  const names: string[] = [];
  return {
    transport: record ? rec : fetchTransport(), names,
    freshName: (tld) => { const n = `mh-test-${randomBytes(5).toString("hex")}.${SANDBOX_TLD[tld] ?? tld}`; names.push(n); return n; },
    finish: () => { if (record) { fs.mkdirSync(FIXTURE_DIR, { recursive: true }); fs.writeFileSync(fixture, fixtureText(rec.fixture(names, note))); } },
  };
}
/** Offline: replays the fixture in order and moves the (faked) Date to each recorded exchange. */
export function replayRig(fixture: URL): Rig & { fixture: Fixture; replay: ReplayTransport } {
  const f = loadFixture(fs.readFileSync(fixture, "utf8"));
  const replay = new ReplayTransport(f, { onExchange: (at) => vi.setSystemTime(at) });
  const queue = [...f.names];
  return { transport: replay, replay, fixture: f, names: f.names, freshName: () => { const n = queue.shift(); if (!n) throw new Error("fixture has no more names"); return n; }, finish: () => undefined };
}

export function makeAdapter(transport: OpHttpTransport, password: string, logs?: unknown[]): OpenproviderAdapter {
  return new OpenproviderAdapter({
    // Observed 2026-09-30: a sandbox renew took longer than 30 s to answer and had been applied (the client saw an unknown outcome), so the
    // recorded runs wait longer; production keeps the adapter default and reconciles.
    mode: "sandbox", deployment: "staging", transport, killSwitch: new MemoryKillSwitch(), timeoutMs: 120_000,
    credentials: new MemoryOpenproviderCredentials({ username: process.env.OPENPROVIDER_USERNAME ?? "sandbox-user@example.com", password }),
    ...(logs ? { log: (e) => logs.push(e), onAlert: (a) => logs.push(a) } : {}),
  });
}
export function subject(rig: Rig, password: string): ContractSubject { return { adapter: makeAdapter(rig.transport, password), freshName: (t) => rig.freshName(t) }; }

/** RFC 6605 section 6.1 example key (ECDSA P-256), accepted by the sandbox as a domain DNSKEY on 2026-09-30. */
export const TEST_DNSKEY: Dnskey = { flags: 257, protocol: 3, algorithm: 13, publicKey: "GojIhhXUN/u4v54ZQqGSnyhWJwaubCvTmeexv7bR6edbkrSqQpF64cYbcB7wNcP+e+MAnLr+Wi9xMWyQLc8NAA==" };
export const REGISTRANT = { name: "Test Person", email: "person@example.test", phone: "+1.5555550100", street: "1 Test St", city: "Portland", region: "OR", postalCode: "97201", country: "US" };

/**
 * The whole lifecycle against one throwaway .com, asserting what the sandbox actually did on 2026-09-30. Returns observations for the report.
 */
export async function runLifecycle(a: OpenproviderAdapter, freshName: (tld: string) => string): Promise<Record<string, unknown>> {
  const obs: Record<string, unknown> = {};
  const fqdn = freshName("com");
  const regUsername = "mhlifecycle01";
  const sentAt = new Date();
  const q = await a.quote(fqdn, 1);
  obs.quoteCom1y = q.wholesale.minor.toString();
  const before = await a.getBalance();
  const reg = await a.register({ fqdn, years: 1, regUsername, regPassword: "unused-by-openprovider", registrant: { ...REGISTRANT } });
  expect(reg.status).toBe("registered");
  const after = await a.getBalance();
  obs.debit = (before.available.minor - after.available.minor).toString();
  expect(before.available.minor - after.available.minor).toBe(q.wholesale.minor);
  expect(a.isExtensionPaused("com")).toBe(false);

  const d0 = (await a.getDomain(fqdn))!;
  expect(d0).toMatchObject({ state: "active", locked: true, autoRenew: false, dsPresent: true, profileUsername: regUsername, nameservers: OP_NAMESERVERS });
  expect(d0.registryStatuses).toContain("clientTransferProhibited");
  obs.newDomain = { locked: d0.locked, dsPresent: d0.dsPresent, registryStatuses: d0.registryStatuses };
  expect(await claimRegistration(a, { fqdn, regUsername, sentAt, registrantFingerprint: registrantFingerprint(REGISTRANT) })).toMatchObject({ ours: true, state: "registered" });

  // lock / unlock
  await a.setLock(fqdn, false);
  const unlocked = (await a.getDomain(fqdn))!;
  expect(unlocked.locked).toBe(false); expect(unlocked.registryStatuses).not.toContain("clientTransferProhibited");
  await a.setLock(fqdn, true);
  expect((await a.getDomain(fqdn))!.locked).toBe(true);

  // authorization codes: provider-generated, different each time
  const c1 = await a.issueAuthCode(fqdn), c2 = await a.issueAuthCode(fqdn);
  expect(c1.code.length).toBeGreaterThanOrEqual(8); expect(c2.code).not.toBe(c1.code);
  await a.rerandomizeAuthCode(fqdn);

  // DNS: replace-all over per-record operations, read back each time
  const rec = (type: DnsRecord["type"], name: string, value: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({ type, name, value, ...extra });
  expect(await a.getDns(fqdn)).toEqual({ hosted: true, records: [] });
  const full = [rec("A", "", "192.0.2.1"), rec("A", "www", "192.0.2.2"), rec("AAAA", "", "2001:db8::1"), rec("MX", "", "mail.example.net", { priority: 10 }),
    rec("TXT", "", "v=spf1 -all"), rec("CNAME", "app", "target.example.net"), rec("SRV", "_sip._tcp", "sip.example.net", { priority: 10, weight: 5, port: 5060 })];
  const z1 = await a.replaceZone(fqdn, full);
  expect(z1.hash).toBe(zoneHash(full));
  const z2 = await a.replaceZone(fqdn, [rec("A", "", "192.0.2.9"), rec("TXT", "", "v=spf1 -all")]);
  expect(z2.records).toEqual([rec("A", "", "192.0.2.9"), rec("TXT", "", "v=spf1 -all")]);
  await expect(a.replaceZone(fqdn, [{ type: "CAA" as never, name: "", value: "0 issue x" }])).rejects.toMatchObject({ code: "unsupported_record_type" });
  await expect(a.replaceZone(fqdn, [rec("TXT", "", "x".repeat(255))])).rejects.toMatchObject({ code: "txt_too_long" });
  await a.replaceZone(fqdn, []);
  expect((await a.getDns(fqdn)).records).toEqual([]);

  // DNSSEC: Openprovider's own (read-only) key is there from the start; while it is, an added key is silently dropped (observed)
  const ds0 = await a.getDs(fqdn);
  expect(ds0).toHaveLength(1);
  obs.managedKeyAlgorithm = ds0[0]!.algorithm;
  await expect(a.addDs(fqdn, ds0[0]!)).rejects.toMatchObject({ code: "dnssec_dnskey_required" });
  await expect(a.addDnskey(fqdn, TEST_DNSKEY)).rejects.toMatchObject({ code: "dnssec_key_not_applied" });

  // nameservers: a signed domain cannot move to unsigned DNS; with targetSigned it can, and the zone is then read-only here
  const away = ["a.iana-servers.net", "ns1.openprovider.nl"];
  await expect(a.setNameservers(fqdn, away)).rejects.toMatchObject({ code: "dnssec_would_break" });
  await expect(a.setNameservers(fqdn, ["ns1.example-dns.net", "ns2.example-dns.net"], { targetSigned: true })).rejects.toMatchObject({ kind: "rejected", code: "399" });
  await a.setNameservers(fqdn, away, { targetSigned: true });
  expect((await a.getDomain(fqdn))!.nameservers).toEqual(away);
  expect(await a.getDs(fqdn)).toEqual(ds0); // the key stays at the registry after the move (observed)
  expect(await a.getDns(fqdn)).toEqual({ hosted: false, records: [] });
  await expect(a.replaceZone(fqdn, [rec("A", "", "192.0.2.1")])).rejects.toMatchObject({ code: "dns_not_hosted" });

  // with external DNS: remove the managed key by its DS, then add and remove our own DNSKEY
  await a.removeDs(fqdn, ds0[0]!);
  expect(await a.getDs(fqdn)).toEqual([]);
  expect((await a.getDomain(fqdn))!.dsPresent).toBe(false);
  const added = await a.addDnskey(fqdn, TEST_DNSKEY);
  expect(added).toEqual(dsFromDnskey(fqdn, TEST_DNSKEY));
  expect(added.keyTag).toBe(55648); // RFC 6605 6.1
  await a.addDnskey(fqdn, TEST_DNSKEY); // idempotent
  expect(await a.getDs(fqdn)).toEqual([added]);
  await a.removeDs(fqdn, added);
  expect(await a.getDs(fqdn)).toEqual([]);

  // back to Openprovider DNS
  await a.setNameservers(fqdn, OP_NAMESERVERS);
  expect((await a.getDns(fqdn)).hosted).toBe(true);
  obs.dsAfterReturnToOpenproviderDns = (await a.getDs(fqdn)).length;

  // contacts: phone edits the handle; a new email applies at once and is reported as a registrant change
  const hash0 = (await a.getDomain(fqdn))!.ownerEmailHash;
  expect(await a.updateContact(fqdn, { ...REGISTRANT, phone: "+1.5555550199" })).toEqual({ status: "applied", registrantChange: false, verificationRequired: false, transferLock60d: false });
  expect(await a.updateContact(fqdn, { ...REGISTRANT, email: "new-owner@example.test" })).toEqual({ status: "applied", registrantChange: true, verificationRequired: true, transferLock60d: true });
  const hash1 = (await a.getDomain(fqdn))!.ownerEmailHash;
  expect(hash1).not.toBe(hash0);
  expect(await a.updateContact(fqdn, { ...REGISTRANT, name: "Other Owner", email: "new-owner@example.test" })).toMatchObject({ status: "applied", registrantChange: true });

  // renew: explicit period, expiry-year guard, debit equals the renewal quote
  const y = (await a.getDomain(fqdn))!.expiresAt!.getUTCFullYear();
  const rq = await a.quote(fqdn, 1, "renew");
  const b2 = await a.getBalance();
  const rn = await a.renew(fqdn, 1, y);
  if (rn.status !== "renewed") throw new Error("expected renewed");
  expect(rn.expiresAt!.getUTCFullYear()).toBe(y + 1);
  expect(b2.available.minor - (await a.getBalance()).available.minor).toBe(rq.wholesale.minor);
  await expect(a.renew(fqdn, 1, y)).rejects.toMatchObject({ code: "expiry_year_mismatch" });
  obs.renewQuote = rq.wholesale.minor.toString();

  // auto-renew, transfers
  await a.setAutoRenew(fqdn, true); expect((await a.getDomain(fqdn))!.autoRenew).toBe(true);
  await a.setAutoRenew(fqdn, false); expect((await a.getDomain(fqdn))!.autoRenew).toBe(false);
  expect(await a.cancelTransfer(fqdn)).toEqual({ cancelled: false });
  await expect(a.getTransfersAway()).rejects.toMatchObject({ code: "transfers_away_unsupported" });
  expect(await a.stopTransferAway(fqdn)).toEqual({ relocked: true, codeRerandomized: true, pendingTransferRemains: true });
  expect(await a.checkTransferIn(fqdn)).toMatchObject({ transferable: false, reason: "already_here" });
  const other = freshName("com");
  expect(await a.checkTransferIn(other)).toMatchObject({ transferable: false, reason: "not_registered" });
  await expect(a.startTransferIn({ fqdn: other, years: 1, authCode: "Bogus-Code-123", regUsername: "mhtransfer01", regPassword: "unused", registrant: { ...REGISTRANT } })).rejects.toMatchObject({ kind: "rejected", code: "invalid_auth_code" });
  expect(await a.getTransferInStatus(fqdn)).toBeNull(); // a NEW registration is not a transfer

  // .ai: one year is refused before sending; availability and a two-year quote work
  await expect(a.quote("mh-test-x.ai", 1)).rejects.toMatchObject({ code: "invalid_period" });
  const ai = await a.quote(freshName("ai"), 2);
  obs.quoteAi2y = ai.wholesale.minor.toString();
  const err = await a.checkAvailability("nothing.xyz").catch((e) => e);
  expect(err).toBeInstanceOf(RegistrarError);
  return obs;
}
