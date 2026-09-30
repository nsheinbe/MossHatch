import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Store contract, read side (ST-37): what comes back from localStorage is only calm, sound and rehideSeconds, each checked. Anything
 * else in the stored entry (a Rescue panel, an open domain, an account, a Visitors view) is ignored, and rehideSeconds stays within
 * the 5 to 100 seconds a revealed value or transfer code may stay up (PLAN 4.6 row 8, WCAG 2.2.1).
 */
const KEY = "mosshatch.prefs";

async function loadWith(stored: unknown) {
  vi.resetModules();
  const mem = new Map<string, string>();
  if (stored !== undefined) mem.set(KEY, typeof stored === "string" ? stored : JSON.stringify(stored));
  const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  (globalThis as { window?: unknown }).window = { localStorage };
  const { useUi } = await import("./index");
  return { s: useUi.getState(), useUi, mem };
}
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe("store hydration takes back only the three preferences (ST-37)", () => {
  it("ignores every other key in the stored entry", async () => {
    const { s } = await loadWith({ state: {
      calm: true, sound: true, rehideSeconds: 60,
      rescue: { fqdn: "planted.com", transferId: null }, domainPanel: { id: "0190f0f0-0000-7000-8000-0000000000ff", fqdn: "planted.com" },
      account: { user: { id: "u", email: "x@example.org" }, credentials: [], addresses: [] }, visitorsOpen: true, accountOpen: true, view: "ledger", orderId: "o", query: "mh_live_planted",
    }, version: 1 });
    expect({ calm: s.calm, sound: s.sound, rehideSeconds: s.rehideSeconds }).toEqual({ calm: true, sound: true, rehideSeconds: 60 });
    expect({ rescue: s.rescue, domainPanel: s.domainPanel, account: s.account, visitorsOpen: s.visitorsOpen, accountOpen: s.accountOpen, view: s.view, orderId: s.orderId, query: s.query })
      .toEqual({ rescue: null, domainPanel: null, account: null, visitorsOpen: false, accountOpen: false, view: "find", orderId: null, query: "" });
    expect(typeof s.set).toBe("function");
  });

  it("keeps rehideSeconds a whole number from 5 to 100, and falls back to 30 for anything that is not a number", async () => {
    const cases: [unknown, number][] = [[10, 10], [100, 100], [100000, 100], [1, 5], [-20, 5], [42.6, 43], ["soon", 30], [null, 30], [true, 30], [{}, 30]];
    for (const [stored, want] of cases) {
      const { s } = await loadWith({ state: { calm: false, sound: false, rehideSeconds: stored }, version: 1 });
      expect(s.rehideSeconds, JSON.stringify(stored)).toBe(want);
    }
  });

  it("keeps the defaults for calm and sound that are not booleans, and survives a broken entry", async () => {
    const { s } = await loadWith({ state: { calm: "yes", sound: 1 }, version: 1 });
    expect(s.sound).toBe(false);
    expect(typeof s.calm).toBe("boolean");
    for (const broken of ["{not json", JSON.stringify({ state: null, version: 1 }), JSON.stringify({ state: [1, 2], version: 1 })]) {
      const { s: t } = await loadWith(broken);
      expect(t.rehideSeconds).toBe(30);
      expect(t.rescue).toBeNull();
    }
  });

  it("still writes only the three preferences", async () => {
    const { useUi, mem } = await loadWith(undefined);
    useUi.getState().set({ calm: true, rescue: { fqdn: "a.com", transferId: null }, rehideSeconds: 10 });
    expect(Object.keys(JSON.parse(mem.get(KEY)!).state).sort()).toEqual(["calm", "rehideSeconds", "sound"]);
  });
});
