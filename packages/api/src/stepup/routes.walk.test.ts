import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRouter } from "../routes.ts";
import { ACTION_TYPES, type ActionType } from "../http/types.ts";

/** Ids whose gated route does not exist yet, with the phase that adds it. A deferred id that gains a route without the gate fails below. */
export const DEFERRED_UNTIL_PHASE: Partial<Record<ActionType, number>> = {
  "device.approve": 4,
  "dns.sensitive.approve": 4,
  "agent.purchase.approve": 5,
  "agent.token.create": 5,
  "agent.token.widen": 5,
};

/** Route path shapes that will carry each deferred id (from PLAN 4.5). A route matching one must declare the gate. */
const FUTURE_ROUTE_SHAPES: Partial<Record<ActionType, RegExp[]>> = {
  "domain.nameservers.change": [/\/domains\/:[a-z]+\/nameservers$/],
  "domain.contact.change": [/\/domains\/:[a-z]+\/contact$/],
  "mandate.sign": [/\/domains\/:[a-z]+\/mandate$/],
  "secret.reveal": [/\/secrets\/:[a-z]+\/reveal$/],
  "domain.transfer_out": [/\/domains\/:[a-z]+\/transfer-out$/],
  "agent.purchase.approve": [/\/approvals\/:[a-z]+\/decide$/],
  "agent.token.create": [/^\/api\/v1\/bindings$/],
  "device.approve": [/\/oauth\/device\/approve$/],
  "card.publish": [/\/cards?\b.*publish$/],
};

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const router = buildRouter();
const gated = router.routes.filter((r) => r.stepUp);

describe("ST-57: route walk over the step-up gate", () => {
  it("no route declares a step-up id outside the thirteen, and every step-up route is session-only", () => {
    for (const r of gated) {
      expect(ACTION_TYPES, `${r.method} ${r.path} declares ${String(r.stepUp)}`).toContain(r.stepUp);
      expect(r.principals, `${r.method} ${r.path}`).toEqual(["session"]);
    }
  });

  it("every /actions route is session-only", () => {
    const actions = router.routes.filter((r) => r.path.startsWith("/api/v1/actions"));
    expect(actions.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /api/v1/actions/:id", "POST /api/v1/actions/:id/commit", "POST /api/v1/actions/prepare"]);
    for (const r of actions) expect(r.principals).toEqual(["session"]);
  });

  it("the source scan finds no gate or requireAction call with a string literal outside the thirteen", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p); } };
    walk(srcRoot);
    expect(files.length).toBeGreaterThan(10);
    const bad: string[] = [];
    const patterns = [
      /\bstepUp\s*:\s*(["'`])([^"'`]*)\1/g,
      /\brequireAction\s*\(\s*[^,()]+,\s*(["'`])([^"'`]*)\1/g,
      /\b(?:stepUpGate|gate|createStepUpGate\(\))\s*\(\s*[^,()]+,\s*(["'`])([^"'`]*)\1/g,
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of patterns) for (const m of text.matchAll(re)) if (!(ACTION_TYPES as readonly string[]).includes(m[2]!)) bad.push(`${path.relative(srcRoot, f)}: ${m[2]}`);
    }
    expect(bad).toEqual([]);
  });

  it("the scan catches a bad literal (self-check of the patterns)", () => {
    const sample = `router.add({ stepUp: "secret.peek" }); requireAction(req, "nope"); gate(req, 'x.y');`;
    const hits: string[] = [];
    for (const re of [/\bstepUp\s*:\s*(["'`])([^"'`]*)\1/g, /\brequireAction\s*\(\s*[^,()]+,\s*(["'`])([^"'`]*)\1/g, /\b(?:stepUpGate|gate|createStepUpGate\(\))\s*\(\s*[^,()]+,\s*(["'`])([^"'`]*)\1/g]) for (const m of sample.matchAll(re)) hits.push(m[2]!);
    expect(hits.sort()).toEqual(["nope", "secret.peek", "x.y"]);
  });

  it("each of the thirteen ids has a gated route or is explicitly deferred to a phase", () => {
    const have = new Set(gated.map((r) => r.stepUp));
    const missing: string[] = [];
    for (const id of ACTION_TYPES) {
      const deferred = DEFERRED_UNTIL_PHASE[id];
      if (have.has(id)) expect(deferred, `${id} has a gated route; remove it from DEFERRED_UNTIL_PHASE`).toBeUndefined();
      else if (deferred === undefined) missing.push(id);
      else expect(deferred).toBeGreaterThanOrEqual(3);
    }
    expect(missing, "ids with neither a gated route nor a deferral").toEqual([]);
    for (const id of Object.keys(DEFERRED_UNTIL_PHASE)) expect(ACTION_TYPES as readonly string[]).toContain(id);
  });

  it("a deferred id whose route shape now exists must carry the gate", () => {
    for (const [id, shapes] of Object.entries(FUTURE_ROUTE_SHAPES) as [ActionType, RegExp[]][]) {
      if (DEFERRED_UNTIL_PHASE[id] === undefined) continue;
      for (const r of router.routes) {
        if (r.method === "GET" || r.method === "HEAD") continue;
        if (shapes.some((re) => re.test(r.path))) expect(r.stepUp, `${r.method} ${r.path} is the route for ${id} and must declare the gate`).toBe(id);
      }
    }
  });

  it("passkey.add is gated in Phase 2 (POST /passkeys, owned by the auth module)", () => {
    const r = gated.find((x) => x.stepUp === "passkey.add");
    expect(r, "no route declares stepUp: passkey.add").toBeDefined();
    expect(r!.method).toBe("POST"); expect(r!.path).toMatch(/\/passkeys$/);
  });
});
