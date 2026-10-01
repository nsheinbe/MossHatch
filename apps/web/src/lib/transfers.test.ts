import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./api";
import { ENDED, explainTransfer, headline, isDone, LIVE, steps, TransferError, transferYears, type TransferState } from "./transfers";
import { keepHandoff, takeHandoff } from "./handoff";

const ALL: TransferState[] = ["awaiting_confirmation", ...LIVE, ...ENDED];

describe("the transfer status never says complete before the server does", () => {
  it("only state 'completed' with completed=true reads as moved", () => {
    for (const state of ALL) for (const completed of [false, true]) {
      const v = { state, completed: state === "completed" ? completed : false };
      const done = isDone(v);
      expect(done).toBe(state === "completed" && completed);
      const h = headline(v);
      const last = steps(v).at(-1)!;
      if (done) { expect(h).toMatch(/Moved/); expect(last.status).toBe("done"); }
      else { expect(h, `${state}/${completed}`).not.toMatch(/moved|complete/i); expect(last.status, state).not.toBe("done"); }
    }
  });
  it("a live transfer is Traveling and has exactly one current step", () => {
    for (const state of ["submitting", "submitted", "pending_owner_approval", "pending_registry"] as const) {
      expect(headline({ state, completed: false })).toMatch(/^Traveling\./);
      expect(steps({ state, completed: false }).filter((s) => s.status === "now")).toHaveLength(1);
    }
  });
  it("an ended transfer shows no step as current", () => {
    for (const state of ["failed", "nacked", "cancelled", "expired"] as const) expect(steps({ state, completed: false }).some((s) => s.status === "now" || s.status === "done")).toBe(false);
  });
});

describe("pre-check reasons (ST-126, C-06)", () => {
  it("mirror the server's sentences and add the day a 60-day rule lifts", () => {
    const policy = fs.readFileSync(path.resolve(__dirname, "../../../../packages/api/src/transfers/policy.ts"), "utf8");
    const block = policy.slice(policy.indexOf("export const BLOCK_TEXT"), policy.indexOf("export const blockMessage"));
    const pairs = [...block.matchAll(/^\s+([a-z_]+): "([^"]+)",$/gm)].map((m) => [m[1]!, m[2]!] as const);
    expect(pairs.length).toBeGreaterThan(10);
    for (const [reason, text] of pairs) {
      const base = text.replace(/ You can transfer it from \{date\}\./, "");
      expect(explainTransfer(new TransferError(409, "not_transferable", { reason })), reason).toBe(base);
    }
    const dated = explainTransfer(new TransferError(409, "not_transferable", { reason: "too_new", transferable_from: "2026-12-01T00:00:00.000Z" }));
    expect(dated).toBe("A name can move only 60 days after it was registered. You can transfer it from December 1, 2026.");
  });
  it("say how many tries are left on a wrong confirmation code, and never echo server text", () => {
    expect(explainTransfer(new TransferError(422, "invalid_code", { attempts_left: 2, message: "server words" }))).toBe("That code did not work. 2 tries left.");
    expect(explainTransfer(new TransferError(422, "invalid_code", { attempts_left: 1 }))).toBe("That code did not work. 1 try left.");
    expect(explainTransfer(new ApiError(409, "something_new", "x"))).not.toContain("something_new");
  });
  it("send the registry's term", () => {
    expect(transferYears("example.com")).toBe(1);
    expect(transferYears("example.ai")).toBe(2);
  });
});

describe("the auth code is never kept", () => {
  const rescue = fs.readFileSync(path.resolve(__dirname, "../ui/Rescue.tsx"), "utf8");
  it("is a password field with autocomplete off, read from the field once and cleared, never in state", () => {
    expect(rescue).toMatch(/id="rescue-code" ref=\{codeRef\}[^>]*type="password" autoComplete="off"/);
    expect(rescue).toMatch(/if \(field\) field\.value = "";/);
    expect(rescue).toMatch(/finally \{ if \(codeRef\.current\) codeRef\.current\.value = "";/);
    expect(rescue).not.toMatch(/useState[^;]*(auth|Auth)Code|setAuthCode|value=\{code\}/);
  });
  it("the Checkout hand-off keeps only the two opaque ids, for one read", () => {
    const mem = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const order = "0190f0f0-0000-7000-8000-00000000000a", transfer = "0190f0f0-0000-7000-8000-00000000000b";
    keepHandoff(order, transfer);
    expect(JSON.parse(mem.get("mh.transfer")!)).toEqual({ order, transfer });
    expect(takeHandoff("0190f0f0-0000-7000-8000-00000000000c")).toBeNull();
    expect(takeHandoff(order)).toBe(transfer);
    expect(takeHandoff(order)).toBeNull();
    mem.set("mh.transfer", JSON.stringify({ order, transfer: "not-an-id" }));
    expect(takeHandoff(order)).toBeNull();
  });
  afterEach(() => { delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });
});
