import dns from "node:dns/promises";

/** The subset of node:dns/promises that the checks use. Injected so tests never touch the network. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveNs(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<{ critical?: number; issue?: string; issuewild?: string; iodef?: string }[]>;
}

/** Real resolver (system DNS). Not used by any test: live values cannot be verified from the build container. */
export class NodeDnsResolver implements DnsResolver {
  private r = new dns.Resolver();
  constructor(servers?: string[]) { if (servers) this.r.setServers(servers); }
  resolveTxt(n: string) { return this.r.resolveTxt(n); }
  resolveMx(n: string) { return this.r.resolveMx(n); }
  resolveNs(n: string) { return this.r.resolveNs(n); }
  resolve4(n: string) { return this.r.resolve4(n); }
  resolveCaa(n: string) { return this.r.resolveCaa(n); }
}

/** A name with no such record type is an empty answer, not a failure. Other errors (timeouts, SERVFAIL) propagate. */
export async function soft<T>(p: Promise<T[]>): Promise<T[]> {
  try { return await p; } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw e;
  }
}

export const norm = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

export interface FakeZone {
  txt?: Record<string, string[][]>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
  ns?: Record<string, string[]>;
  a?: Record<string, string[]>;
  caa?: Record<string, { critical?: number; issue?: string; issuewild?: string; iodef?: string }[]>;
  /** Names that fail with a resolver error (SERVFAIL). */
  fail?: string[];
}
/** In-memory resolver for tests. Absent names answer like an empty (ENODATA) reply. */
export class FakeDns implements DnsResolver {
  constructor(public zone: FakeZone = {}) {}
  private get<T>(m: Record<string, T[]> | undefined, name: string): Promise<T[]> {
    const n = norm(name);
    if (this.zone.fail?.includes(n)) return Promise.reject(Object.assign(new Error("servfail"), { code: "ESERVFAIL" }));
    const v = m?.[n];
    return v ? Promise.resolve(v) : Promise.reject(Object.assign(new Error("nodata"), { code: "ENODATA" }));
  }
  resolveTxt(n: string) { return this.get(this.zone.txt, n); }
  resolveMx(n: string) { return this.get(this.zone.mx, n); }
  resolveNs(n: string) { return this.get(this.zone.ns, n); }
  resolve4(n: string) { return this.get(this.zone.a, n); }
  resolveCaa(n: string) { return this.get(this.zone.caa, n); }
}
