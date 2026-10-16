import { describe, expect, it } from "vitest";
import { parseQuery } from "./find";

describe("AUD-P7: a typed extension we don't sell is reported, not silently dropped", () => {
  it("keeps a sold extension, flags an unsold one, and ignores a scheme, a path and a trailing dot", () => {
    expect(parseQuery("MoonFern.com")).toEqual({ label: "moonfern", tld: "com" });
    expect(parseQuery("moonfern.net")).toEqual({ label: "moonfern", tld: undefined, unsupported: "net" });
    expect(parseQuery("https://moonfern.co.uk/about")).toEqual({ label: "moonfern", tld: undefined, unsupported: "co.uk" });
    expect(parseQuery("moonfern.studio/x?y")).toEqual({ label: "moonfern", tld: "studio" });
    expect(parseQuery("moonfern")).toEqual({ label: "moonfern", tld: undefined });
    expect(parseQuery("moonfern.")).toEqual({ label: "moonfern", tld: undefined });
    expect(parseQuery("!!!")).toBeNull();
  });
});
