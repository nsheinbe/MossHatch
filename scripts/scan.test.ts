import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script
import { scanText } from "./scan-client-bundle.mjs";

const fakes: [string, string][] = [
  ["stripe", "const k='sk_live_" + "a1B2c3D4e5F6g7H8i9J0'"],
  ["stripe test", "x='rk_test_" + "abcdefghijklmnop1234'"],
  ["webhook", "s='whsec_" + "abcdefghijklmnop1234'"],
  ["aws", "id='AKIA" + "ABCDEFGHIJKLMNOP'"],
  ["pem", "-----BEGIN " + "PRIVATE KEY-----"],
  ["pg", "postgres://app:" + "hunter2hunter2@db.example.com/x"],
  ["bearer", "Authorization: Bearer " + "abcdefghijklmnopqrstuvwx1234"],
  ["github", "t='ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789'"],
  ["mosshatch", "t='mh_live_" + "abcdefghijklmnop1234'"],
];
describe("bundle secret scan", () => {
  for (const [name, text] of fakes) it(`catches ${name}`, () => expect(scanText(text).length).toBeGreaterThan(0));
  it("passes ordinary code", () => expect(scanText("function f(){return 'postgres is a database'} const a=1")).toEqual([]));
  it("catches a server variable's value", () => expect(scanText("x='s3cr3t-value-123'", { values: ["s3cr3t-value-123"] }).length).toBe(1));
  it("catches forbidden markers", () => expect(scanText("?debug=states", { forbid: ["debug=states"] }).length).toBe(1));
  it("ignores short values", () => expect(scanText("abc", { values: ["abc"] })).toEqual([]));
});
