import { describe, expect, it } from "vitest";
import { CHOICES, picksFrom, scopesFor } from "../../../../apps/web/src/lib/scopes.ts";
import { allows, parseScope, parseScopes, scopeString } from "./scopes.ts";

/**
 * The everyday choices on the token form and the consent screen (apps/web/src/lib/scopes.ts) against this module's grammar: every
 * ticked box must be a scope the server accepts and stores exactly as shown, for one owned name and for every name.
 */
const NAME = "fern-choice.com";
const DOMAIN = "0190f0f0-0000-7000-8000-00000000d0c1";
const owned = new Map([[NAME, DOMAIN]]);

describe("the web's everyday access choices are scopes the server accepts as shown", () => {
  it("each choice parses on one name and on every name, and round-trips to the same text", () => {
    for (const c of CHOICES) {
      for (const n of [NAME, "*"]) {
        for (const raw of c.scopes(n)) expect(scopeString(parseScope(raw, owned)), `${c.id} ${raw}`).toBe(raw);
      }
    }
    expect(() => parseScopes(scopesFor(CHOICES.map((c) => c.id), NAME), owned)).not.toThrow();
    expect(() => parseScopes(scopesFor(CHOICES.map((c) => c.id), "*"), owned)).not.toThrow();
  });

  it("the recipes choice can plan and apply on its name, writes development and preview only, never production", () => {
    const s = parseScopes(scopesFor(["recipes"], NAME), owned);
    expect(allows(s, "recipes.plan", DOMAIN, null)).toBe(true);
    expect(allows(s, "recipes.apply", DOMAIN, "dev")).toBe(true);
    expect(allows(s, "secrets.write", DOMAIN, "preview")).toBe(true);
    expect(allows(s, "recipes.apply", DOMAIN, "prod")).toBe(false);
    expect(allows(s, "secrets.write", DOMAIN, "prod")).toBe(false);
    expect(allows(s, "recipes.apply", "0190f0f0-0000-7000-8000-00000000d0c2", "dev")).toBe(false);
  });

  it("buying always covers every name (register.propose is star-only), even when the rest is for one name", () => {
    expect(scopesFor(["see", "buy"], NAME)).toEqual([`domains.read:${NAME}`, "register.propose:*"]);
    expect(() => parseScopes(scopesFor(["see", "buy"], NAME), owned)).not.toThrow();
  });

  it("the consent screen ticks exactly what a well-formed request asked for, and leaves the rest visible under Advanced", () => {
    for (const n of [NAME, "*"]) {
      const all = CHOICES.map((c) => c.id);
      expect(picksFrom(scopesFor(all, n))).toEqual({ picks: all, name: n, rest: [] });
    }
    expect(picksFrom(["domains.read:*", `secrets.read:${NAME}:prod`])).toEqual({ picks: [], name: NAME, rest: ["domains.read:*", `secrets.read:${NAME}:prod`] });
    expect(picksFrom([`dns.read:${NAME}`, "dns.read:other-name.com"])).toEqual({ picks: [], name: "*", rest: [`dns.read:${NAME}`, "dns.read:other-name.com"] });
  });
});
