import fs from "node:fs";

/**
 * The PLAN 4.3a response-header set, read from docs/PLAN.md itself so the header tests and the plan cannot drift apart.
 * Shared by headers.prod.spec.ts (web) and headers.cards.spec.ts (cards). Not a spec file.
 */
const plan = () => fs.readFileSync("docs/PLAN.md", "utf8");

/** The rows of the table under "**Response headers.**" in 4.3a: header name, Value cell and Note cell as written. */
export function planHeaderTable(): { name: string; value: string; note: string }[] {
  const text = plan();
  const start = text.indexOf("| Header | Value | Note |", text.indexOf("**Response headers.**"));
  if (start < 0) throw new Error("PLAN 4.3a has no response-header table");
  const rows: { name: string; value: string; note: string }[] = [];
  for (const line of text.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split(" | ").map((c) => c.replace(/^\|\s*|\s*\|$/g, "").trim());
    const name = /^`([^`]+)`$/.exec(cells[0] ?? "")?.[1];
    if (!name) throw new Error(`unreadable header row: ${line}`);
    rows.push({ name, value: cells[1] ?? "", note: cells[2] ?? "" });
  }
  return rows;
}

/** The first code span of one row's Value cell (the header value, or the part of it the row names). */
export function planHeader(name: string): string {
  const row = planHeaderTable().find((r) => r.name === name);
  const v = row && /`([^`]+)`/.exec(row.value)?.[1];
  if (!v) throw new Error(`PLAN 4.3a has no ${name} value`);
  return v;
}

/** The enforced policy in the "Strict CSP, no third-party scripts" row of the 4.3a verdict table. */
export function planCsp(): string {
  const row = plan().split("\n").find((l) => l.startsWith("| Strict CSP"));
  const v = row && /`(default-src [^`]+)`/.exec(row)?.[1];
  if (!v) throw new Error("PLAN 4.3a has no Strict CSP policy");
  return v;
}

const directives = (policy: string) => policy.split(";").map((d) => d.trim()).filter(Boolean);
const directiveName = (d: string) => d.split(/\s+/)[0]!;

/**
 * The single enforced policy the plan asks for once the Nest has shipped: the Content-Security-Policy-Report-Only row is
 * "Enforced (merged into the policy above) before the Nest ships", so its Trusted Types directives join the CSP row's
 * policy just before the report directives both rows share.
 */
export function planMergedCsp(): string[] {
  const base = directives(planCsp());
  const tt = directives(planHeader("Content-Security-Policy-Report-Only")).filter((d) => !/^report-(uri|to)\b/.test(d));
  const at = base.findIndex((d) => /^report-uri\b/.test(d));
  if (at < 0 || tt.length === 0) throw new Error("PLAN 4.3a CSP rows changed shape");
  return [...base.slice(0, at), ...tt, ...base.slice(at)];
}

/**
 * The served policy: the merged plan policy with the recorded departures applied (directive name to its served form, or
 * null for a directive the host leaves out). Each departure must change a directive the plan has, so a stale one fails.
 */
export function expectedCsp(departures: Record<string, string | null>, additions: readonly CspAddition[] = []): string {
  const merged = planMergedCsp();
  for (const name of Object.keys(departures)) {
    const d = merged.find((x) => directiveName(x) === name);
    if (!d) throw new Error(`departure for ${name}, which the plan does not have`);
    if (d === departures[name]) throw new Error(`departure for ${name} equals the plan; remove it`);
  }
  for (const a of additions) {
    if (merged.some((x) => directiveName(x) === directiveName(a.directive))) throw new Error(`addition of ${directiveName(a.directive)}, which the plan already has; make it a departure`);
    if (!merged.some((x) => directiveName(x) === a.after)) throw new Error(`addition after ${a.after}, which the plan does not have`);
  }
  return merged.flatMap((d) => {
    const name = directiveName(d);
    const added = additions.filter((a) => a.after === name).map((a) => a.directive);
    if (!(name in departures)) return [d, ...added];
    const v = departures[name];
    return [...(v === null || v === undefined ? [] : [v]), ...added];
  }).join("; ");
}

/** A directive the plan's policy does not have, served right after the named one. */
export interface CspAddition { after: string; directive: string }

/**
 * Where a host departs from the plan's policy, and why (DECISIONS D-051). Nothing else may differ.
 * web: the hatch card portrait is a PNG data URL (engine snapshot, CardPanel <img>), and the app creates its one
 * Trusted Types policy, `mosshatch`, at start (lib/trusted.ts); the plan's empty `trusted-types` refuses every policy.
 * cards: hatchkind.com runs no script at all (ST-145 build gate in scripts/check-cards.mjs, D-049), so `script-src` is
 * left out and falls back to `default-src 'none'`.
 */
export const WEB_CSP_DEPARTURES: Record<string, string | null> = {
  "img-src": "img-src 'self' data: blob:",
  "trusted-types": "trusted-types mosshatch",
};
export const CARDS_CSP_DEPARTURES: Record<string, string | null> = { "script-src": null };
/**
 * Directives the plan lacks (DECISIONS D-061). web: `frame-src` names the only origin the launcher's preview may be framed from
 * (Slate's preview host). It is `'none'` until that host is known (the same as the default it replaces); the page then links out
 * instead of framing. `node scripts/launcher-frame-src.mjs <origin>` sets it here and in vercel.json together.
 */
export const WEB_CSP_ADDITIONS: readonly CspAddition[] = [{ after: "frame-ancestors", directive: "frame-src 'none'" }];

/** Every header row of the plan table, so a row added to the plan fails the coverage test until it is asserted. */
export const ASSERTED_ROWS = [
  "Content-Security-Policy", "Content-Security-Policy-Report-Only", "Reporting-Endpoints", "Strict-Transport-Security",
  "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy", "X-Frame-Options", "Cache-Control", "Clear-Site-Data",
];

/** The headers every route of both hosts sends with exactly the plan's value (the first code span of the row). */
export const EXACT_ROWS = [
  "Reporting-Endpoints", "Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy",
  "Cross-Origin-Opener-Policy", "X-Frame-Options",
];
