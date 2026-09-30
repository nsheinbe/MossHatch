import { describe, expect, it } from "vitest";
import { normalizeSecretName, RESERVED_NAMES, RESERVED_PREFIXES } from "../../../../packages/api/src/vault/names.ts";
import { nameProblem, normalizeName, parseNest, WireError, type ReservedNames } from "./nest";

const served: ReservedNames = { version: 1, names: [...RESERVED_NAMES], prefixes: [...RESERVED_PREFIXES] };
const secret = (env: string, over: Record<string, unknown> = {}) => ({ id: "s1", env, name: "API_KEY", version: 2, updated_at: "2026-09-30T10:00:00.000Z", ...over });
const nest = (over: Record<string, unknown> = {}) => ({
  domain: "example.com",
  envs: { dev: { count: 1, secrets: [secret("dev")] }, preview: { count: 0, secrets: [] }, prod: { count: 0, secrets: [] } },
  connections: [], ...over,
});

describe("strict wire shape for the Nest list (store contract layer 1)", () => {
  it("accepts the server's shape", () => {
    const v = parseNest(nest());
    expect(v.envs.dev.secrets).toEqual([{ id: "s1", name: "API_KEY", version: 2, updated_at: "2026-09-30T10:00:00.000Z" }]);
  });
  it("refuses a list entry that carries a value or any unknown field", () => {
    for (const extra of [{ value: "x" }, { plaintext: "x" }, { secret: "x" }, { token: "x" }]) {
      expect(() => parseNest(nest({ envs: { dev: { count: 1, secrets: [secret("dev", extra)] }, preview: { count: 0, secrets: [] }, prod: { count: 0, secrets: [] } } }))).toThrow(WireError);
    }
    expect(() => parseNest(nest({ values: {} }))).toThrow(WireError);
    expect(() => parseNest({ ...nest(), connections: [{ id: "c", service: "vercel", status: "active", connected_at: "x", credential: "y" }] })).toThrow(WireError);
  });
  it("refuses a secret filed under the wrong environment", () => {
    expect(() => parseNest(nest({ envs: { dev: { count: 1, secrets: [secret("prod")] }, preview: { count: 0, secrets: [] }, prod: { count: 0, secrets: [] } } }))).toThrow(WireError);
  });
});

describe("secret names: plain reasons before the server's generic 422 (PLAN 4.6 row 22)", () => {
  it("normalises like the server", () => {
    for (const raw of ["api_key", "  Api_Key ", "ＡＰＩ_KEY", "db_url2"]) {
      const s = normalizeSecretName(raw);
      expect(s.ok).toBe(true);
      expect(normalizeName(raw)).toBe(s.ok ? s.name : "");
    }
  });
  it("names every reserved name and prefix the server refuses, in any case", () => {
    for (const n of RESERVED_NAMES) {
      // A reserved name that also breaks the grammar (like _JAVA_OPTIONS) is explained by the grammar; either way it is refused.
      const why = /^[A-Z]/.test(n) ? /is reserved/ : /Use capital letters/;
      expect(nameProblem(n, served), n).toMatch(why);
      expect(nameProblem(n.toLowerCase(), served), n).toMatch(why);
      expect(normalizeSecretName(n)).toMatchObject({ ok: false });
    }
    for (const p of RESERVED_PREFIXES) {
      expect(nameProblem(`${p}THING`, served), p).toMatch(new RegExp(`start with ${p}`));
      expect(normalizeSecretName(`${p}THING`)).toMatchObject({ ok: false });
    }
  });
  it("explains the grammar, and passes names the server accepts", () => {
    for (const bad of ["1ABC", "has-dash", "with space", "_LEAD", "A".repeat(129)]) {
      expect(nameProblem(bad, served), bad).not.toBeNull();
      expect(normalizeSecretName(bad).ok, bad).toBe(false);
    }
    for (const good of ["DATABASE_URL", "stripe_key", "A", "X1_Y2"]) {
      expect(nameProblem(good, served), good).toBeNull();
      expect(normalizeSecretName(good).ok, good).toBe(true);
    }
  });
});
