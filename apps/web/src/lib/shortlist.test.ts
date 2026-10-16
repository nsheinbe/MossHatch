import { describe, expect, it } from "vitest";
import { cleanShortlist, loadShortlist, saveShortlist, SHORTLIST_MAX, toggleShortlist } from "./shortlist";

class MemoryStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

describe("AUD-D3: the shortlist keeps a few names in this tab only", () => {
  it("keeps only valid, unique domain names, at most six, in order", () => {
    expect(cleanShortlist(["Moonfern.com", "moonfern.com", "bad name.com", 7, "x.y", "-a.com", "tinybrush.studio"])).toEqual(["moonfern.com", "tinybrush.studio"]);
    expect(cleanShortlist(Array.from({ length: 10 }, (_, i) => `name${i}.com`))).toHaveLength(SHORTLIST_MAX);
    expect(cleanShortlist({ evil: true })).toEqual([]);
  });

  it("round-trips through storage and ignores anything malformed it finds there", () => {
    const s = new MemoryStorage();
    saveShortlist(["a1.com", "b2.dev"], s);
    expect(loadShortlist(s)).toEqual(["a1.com", "b2.dev"]);
    s.setItem("mh.shortlist", "{not json");
    expect(loadShortlist(s)).toEqual([]);
    s.setItem("mh.shortlist", JSON.stringify(["<img src=x>.com", "ok.app"]));
    expect(loadShortlist(s)).toEqual(["ok.app"]);
    saveShortlist([], s);
    expect(s.getItem("mh.shortlist")).toBeNull();
    expect(loadShortlist(null)).toEqual([]);
  });

  it("toggles a name in and out, and refuses a seventh", () => {
    let l: string[] = [];
    for (let i = 0; i < SHORTLIST_MAX; i++) l = toggleShortlist(l, `n${i}.com`).list;
    expect(toggleShortlist(l, "seven.com")).toEqual({ list: l, full: true });
    expect(toggleShortlist(l, "n0.com").list).not.toContain("n0.com");
  });
});
