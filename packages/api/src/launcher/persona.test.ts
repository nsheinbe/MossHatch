import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveCreatureSpec } from "@mosshatch/core";
import { buildPersona, OPENING_TURN, PROMPT_VERSION, SYSTEM_RULES, TOOLS, systemBlocks } from "./persona.ts";
import { buildParams, DEFAULT_MODEL, echoable } from "./claude.ts";
import { launcherConfigFromEnv, priceWithMarkup } from "./config.ts";

/**
 * Prompt-cache stability (docs/LAUNCHER.md "Prompt caching"): the tools, the shared rules and a conversation's persona are the same
 * bytes on every request, nothing volatile is in them, the breakpoints sit where the plan says, and the request carries only the
 * parameters Claude Opus 5.5 accepts (no thinking config, no budget_tokens, no temperature, tool_choice auto).
 */

const sha = (x: unknown) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");

describe("the frozen prefix", () => {
  it("has no dates, times, ids or per-user values in the shared rules", () => {
    expect(SYSTEM_RULES).not.toMatch(/\b20\d\d\b|\d{1,2}:\d\d|[0-9a-f]{8}-[0-9a-f]{4}|today|yesterday|@/i);
    expect(SYSTEM_RULES.length).toBeGreaterThan(1500);
  });

  it("is pinned: changing the rules or the tools is a deliberate change (update the hash with PROMPT_VERSION)", () => {
    expect(PROMPT_VERSION).toBe("launcher-v1");
    expect(sha({ SYSTEM_RULES, TOOLS, OPENING_TURN }).slice(0, 16)).toMatchInlineSnapshot(`"8106b4bf9ff023c9"`);
  });

  it("builds the same persona for the same name every time, from the spec and the domain only", () => {
    const a = buildPersona(deriveCreatureSpec("moonfern.com"), "moonfern.com");
    const b = buildPersona(deriveCreatureSpec("moonfern.com"), "moonfern.com");
    expect(a).toBe(b);
    expect(a).toContain("moonfern.com");
    expect(a).toMatch(/^Your name is [A-Za-z ]+\. You are a /);
    expect(a).toMatch(/primary #[0-9a-f]{6}, accent #[0-9a-f]{6}, background #[0-9a-f]{6}, text #[0-9a-f]{6}/);
    expect(buildPersona(deriveCreatureSpec("tinkerdeep.dev"), "tinkerdeep.dev")).not.toBe(a);
  });

  it("places cache breakpoints on the rules and the persona, and automatic caching on the newest turn", () => {
    const persona = buildPersona(deriveCreatureSpec("moonfern.com"), "moonfern.com");
    const sys = systemBlocks(persona);
    expect(sys.map((b) => b.cache_control)).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }]);
    expect(sys[0]!.text).toBe(SYSTEM_RULES);
    const p = buildParams({ model: DEFAULT_MODEL, persona, messages: [{ role: "user", content: OPENING_TURN }] }, true);
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    // At most 4 breakpoints per request: 2 in system + 1 automatic.
    expect(JSON.stringify(p).match(/"cache_control"/g)!.length).toBe(3);
  });

  it("keeps tools, system and earlier messages byte-identical from turn to turn (append-only)", () => {
    const persona = buildPersona(deriveCreatureSpec("moonfern.com"), "moonfern.com");
    const t1 = [{ role: "user" as const, content: [{ type: "text" as const, text: OPENING_TURN }] }];
    const a1 = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello." }] };
    const t2 = [...t1, a1, { role: "user" as const, content: [{ type: "text" as const, text: "a tea shop" }] }];
    const p1 = buildParams({ model: DEFAULT_MODEL, persona, messages: t1 }, true);
    const p2 = buildParams({ model: DEFAULT_MODEL, persona, messages: t2 }, true);
    expect(JSON.stringify(p2.tools)).toBe(JSON.stringify(p1.tools));
    expect(JSON.stringify(p2.system)).toBe(JSON.stringify(p1.system));
    expect(JSON.stringify(p2.messages.slice(0, 1))).toBe(JSON.stringify(p1.messages));
  });

  it("sends only what Claude Opus 5.5 accepts: effort low, auto tool choice, no thinking config, no sampling, strict tools", () => {
    const p = buildParams({ model: DEFAULT_MODEL, persona: "x", messages: [{ role: "user", content: "hi" }] }, true) as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
    expect(JSON.stringify(p)).not.toContain("budget_tokens");
    expect(p.stream).toBe(true);
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(TOOLS.map((t) => (t as { name: string }).name)).toEqual(["propose_brief", "revise_site"]);
    for (const t of TOOLS as { strict?: boolean; input_schema: { additionalProperties?: boolean; required?: string[]; properties: Record<string, unknown> } }[]) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(new Set(t.input_schema.required)).toEqual(new Set(Object.keys(t.input_schema.properties)));
      // The API's strict schemas reject length and pattern constraints; the server checks them instead.
      expect(JSON.stringify(t.input_schema)).not.toMatch(/maxLength|minLength|pattern|maxItems|minimum/);
    }
    const off = buildParams({ model: DEFAULT_MODEL, persona: "x", messages: [{ role: "user", content: "hi" }] }, false) as unknown as Record<string, unknown>;
    expect(off).not.toHaveProperty("fallbacks");
    expect(off).not.toHaveProperty("betas");
  });

  it("echoes a turn unchanged unless a fallback happened, then drops what the fallback model cannot read before the marker", () => {
    const plain = [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "hi", citations: null }] as never;
    expect(echoable(plain)).toBe(plain);
    const fell = [
      { type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "par", citations: null },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } }, { type: "text", text: "tial", citations: null },
    ] as never;
    expect((echoable(fell) as { type: string }[]).map((b) => b.type)).toEqual(["text", "text"]);
  });
});

describe("configuration", () => {
  it("defaults to claude-opus-5-5 with a 1.5x markup, and MH_LAUNCHER_MODEL overrides the model", () => {
    const f = launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1" }, "local").config!;
    expect([f.model, f.markupBps, f.fake, f.fallbacks, f.inviteOnly]).toEqual(["claude-opus-5-5", 15000, true, true, false]);
    expect(launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1", MH_LAUNCHER_MODEL: "claude-sonnet-5-5" }, "local").config!.model).toBe("claude-sonnet-5-5");
    expect(launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1", MH_LAUNCHER_FALLBACKS: "off" }, "local").config!.fallbacks).toBe(false);
  });
  it("refuses the fakes in production and names every missing variable as a code", () => {
    expect(launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1" }, "production")).toEqual({ config: null, reasons: ["launcher_fake_in_production"] });
    expect(launcherConfigFromEnv({}, "production").reasons).toEqual([
      "anthropic_api_key_missing", "slate_partner_url_missing", "slate_partner_id_missing", "slate_partner_secret_missing", "slate_partner_user_key_missing", "slate_preview_origin_missing",
    ]);
    const full = { ANTHROPIC_API_KEY: "k", SLATE_PARTNER_URL: "https://slate.example/api/partner/v1", SLATE_PARTNER_ID: "mosshatch", SLATE_PARTNER_SECRET: "s".repeat(40), SLATE_PARTNER_USER_KEY: "u".repeat(40) };
    const ok = launcherConfigFromEnv(full, "production");
    expect(ok.reasons).toEqual([]);
    // Previews are signed URLs under the partner API: same origin, `<base>/preview/`.
    expect(ok.config).toMatchObject({ inviteOnly: true, previewOrigin: "https://slate.example", previewPath: "/api/partner/v1/preview/" });
    expect(launcherConfigFromEnv({ ...full, SLATE_PREVIEW_ORIGIN: "https://preview.slate.example" }, "production").config).toMatchObject({ previewOrigin: "https://preview.slate.example", previewPath: "/" });
    expect(launcherConfigFromEnv({ ...full, SLATE_PARTNER_USER_KEY: "s".repeat(40) }, "production").reasons).toContain("slate_partner_user_key_reused");
    expect(launcherConfigFromEnv({ ...full, SLATE_PARTNER_URL: "http://slate.example/api" }, "production").reasons).toContain("slate_partner_url_missing");
  });
  it("prices Slate's quote with the markup, rounded up to a whole cent", () => {
    expect(priceWithMarkup(180, 15000)).toBe(270);
    expect(priceWithMarkup(61, 15000)).toBe(92);
    expect(priceWithMarkup(100, 10000)).toBe(100);
    expect(priceWithMarkup(0, 15000)).toBe(0);
  });
});
