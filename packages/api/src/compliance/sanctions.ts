import type { PoolClient } from "@mosshatch/db";

/**
 * Sanctions screening (PLAN.md 4.6 row 35 and 37, C-25). NOT PROVEN: no real OFAC SDN or other list is ingested here. The only
 * implementation in this repository is `LocalFixtureSanctions`, a tiny fictional list used by tests. Real list ingestion, its update
 * cadence, the fuzzy-match policy and the jurisdiction question (lawyer question 10 in PLAN.md 4.7) are all still open.
 */
export type ScreeningResult = "clear" | "match" | "review";
export interface SanctionsSubject {
  kind: "user" | "contact" | "registrant";
  /** Opaque id of the account or contact. The name and country below are used for matching and never stored. */
  ref: string;
  name?: string;
  organization?: string;
  country?: string;
}
export interface SanctionsPort {
  listVersion(): string;
  screen(subject: Omit<SanctionsSubject, "ref" | "kind">): Promise<ScreeningResult>;
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function lev1(a: string, b: string): boolean { // edit distance <= 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

export class LocalFixtureSanctions implements SanctionsPort {
  /** Fictional entries. Countries are ISO codes under comprehensive embargo programmes as commonly listed; treat as a fixture, not as legal advice. */
  constructor(
    private names: string[] = ["Test Sanctioned Person", "Blocked Trading Company Ltd", "Aldo Fixture Entity"],
    private countries: string[] = ["CU", "IR", "KP", "SY"],
    private version = "fixture-2026-09-29",
  ) {}
  listVersion() { return this.version; }
  async screen(s: { name?: string; organization?: string; country?: string }): Promise<ScreeningResult> {
    if (s.country && this.countries.includes(s.country.toUpperCase())) return "match";
    const listed = this.names.map(norm);
    let review = false;
    for (const raw of [s.name, s.organization]) {
      if (!raw) continue;
      const n = norm(raw);
      if (!n) continue;
      for (const l of listed) {
        if (n === l || ` ${n} `.includes(` ${l} `)) return "match";
        if (lev1(n, l)) review = true;
      }
    }
    return review ? "review" : "clear";
  }
}

/** Screen and record the outcome. The log row holds the opaque ref, the list version and the result: no name, no country. */
export async function screenSanctions(port: SanctionsPort, c: PoolClient, subject: SanctionsSubject, now?: Date): Promise<{ result: ScreeningResult; listVersion: string; id: string }> {
  const result = await port.screen({ name: subject.name, organization: subject.organization, country: subject.country });
  const r = await c.query(
    "insert into sanctions_screenings (subject_kind, subject_ref, list_version, result, checked_at) values ($1,$2,$3,$4,coalesce($5, now())) returning id",
    [subject.kind, subject.ref, port.listVersion(), result, now ?? null],
  );
  return { result, listVersion: port.listVersion(), id: r.rows[0].id as string };
}

/** A registration proceeds only on a clear screening; `review` waits for a person. */
export const screeningBlocks = (r: ScreeningResult) => r !== "clear";
