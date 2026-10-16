import { describe, expect, it } from "vitest";
import { canSpend, describeScope, lines, minor } from "./scopes";

describe("the token form's helpers", () => {
  it("reads dollars typed by a person as cents, and anything else as nothing", () => {
    expect(minor("50")).toBe(5000);
    expect(minor("$1,234.50")).toBe(123450);
    expect(minor("0.015")).toBe(2);
    for (const bad of ["", "abc", "-5", "0", "Infinity"]) expect(minor(bad), bad).toBe(0);
  });

  it("asks for a spend cap only when the token could ask you to pay", () => {
    expect(canSpend(["register.propose:*"])).toBe(true);
    expect(canSpend(["renew.propose:fern.com"])).toBe(true);
    expect(canSpend(["domains.read:*", "dns.write:fern.com", "recipes.apply:fern.com:*"])).toBe(false);
  });

  it("says each scope in words, next to the raw scope", () => {
    expect(describeScope("domains.read:*")).toBe("See all names");
    expect(describeScope("dns.write:fern.com")).toBe("Change DNS on fern.com");
    expect(describeScope("secrets.write:fern.com:*")).toBe("Write secrets on fern.com, development and preview");
    expect(describeScope("secrets.read:fern.com:prod")).toBe("Read secrets on fern.com, production");
    expect(describeScope("register.propose:*")).toBe("Suggest names to buy");
    expect(describeScope("recipes.plan:*")).toBe("Plan recipes on all names");
  });

  it("splits typed scopes on lines, spaces and commas", () => {
    expect(lines("dns.read:fern.com\n dns.write:fern.com, domains.read:*  ")).toEqual(["dns.read:fern.com", "dns.write:fern.com", "domains.read:*"]);
    expect(lines("  \n ")).toEqual([]);
  });
});
