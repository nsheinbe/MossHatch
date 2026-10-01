import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { CreaturePort, TurnRequest, TurnResult } from "./claude.ts";

/**
 * A scripted creature for tests, local development and e2e (MH_FAKE_LAUNCHER=1). It never calls the API. It follows the same
 * conversation rules the real prompt asks for (greets by name, asks two questions, proposes a brief with the propose_brief tool,
 * revises with revise_site after a build) and streams its text in small pieces so the glow and captions can be seen working.
 * Words that read as a phishing request produce `stop_reason: "refusal"`, to exercise the in-character refusal path.
 */

const QUESTIONS = ["Who is it for, and what should they do when they arrive?", "And how should it feel: playful, calm, bold, something else?"];

type Block = Anthropic.Beta.BetaContentBlockParam;
const textOf = (c: Anthropic.Beta.BetaMessageParam["content"]): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : (c as Block[]));

export class FakeCreature implements CreaturePort {
  readonly kind = "fake" as const;
  /** Requests seen (for the prompt-stability tests). */
  readonly requests: TurnRequest[] = [];
  constructor(private opts: { delayMs?: number } = {}) {}

  async turn(req: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    this.requests.push(structuredClone(req));
    const name = /Your name is ([A-Za-z ]+)\./.exec(req.persona)?.[1] ?? "your creature";
    const domain = /the creature of the domain ([a-z0-9.-]+)\./.exec(req.persona)?.[1] ?? "your domain";
    const palette = /primary (#[0-9a-f]{6}), accent (#[0-9a-f]{6}), background (#[0-9a-f]{6}), text (#[0-9a-f]{6})/.exec(req.persona);
    const users = req.messages.filter((m) => m.role === "user");
    const owner = (m: Anthropic.Beta.BetaMessageParam) => textOf(m.content).filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text" && !b.text.startsWith("[Mosshatch")).map((b) => b.text).join(" ").trim();
    const ownerTurns = users.map(owner).filter(Boolean);
    const last = users[users.length - 1]!;
    const lastOwner = owner(last);
    const toolNotes = req.messages.flatMap((m) => (m.role === "user" ? textOf(m.content) : [])).filter((b) => b.type === "tool_result")
      .map((b) => { const c = (b as Anthropic.Beta.BetaToolResultBlockParam).content; return typeof c === "string" ? c : (c ?? []).map((x) => ("text" in x ? x.text : "")).join(" "); });
    const built = toolNotes.some((t) => /built as version/i.test(t));
    const proposed = req.messages.some((m) => m.role === "assistant" && textOf(m.content).some((b) => b.type === "tool_use" && b.name === "propose_brief"));

    let say = "";
    let tool: { name: string; input: unknown } | null = null;
    if (/phish|steal (their )?password|fake (bank|login)|bank login/i.test(lastOwner)) {
      return this.finish(req, "", null, onText, "refusal");
    }
    if (!lastOwner && ownerTurns.length === 0) {
      say = `Oh! Hello. I'm ${name}, the creature of ${domain}. What would you like this little place on the web to be?`;
    } else if (built && lastOwner) {
      if (/\?\s*$/.test(lastOwner)) say = "Good question. I can only change what the builder makes, so tell me what you'd like different and I'll carry it to the scroll.";
      else { say = "Mm, I can feel it. Let me ask the builder."; tool = { name: "revise_site", input: { instruction: lastOwner.slice(0, 300) } }; }
    } else if (!proposed && ownerTurns.length <= QUESTIONS.length) {
      say = QUESTIONS[ownerTurns.length - 1] ?? QUESTIONS[0]!;
    } else if (lastOwner) {
      const [what, who, feel] = [ownerTurns[0] ?? "", ownerTurns[1] ?? "people who will love it", ownerTurns[2] ?? "warm and clear"];
      const title = domain.split(".")[0]!.replace(/(^|-)([a-z])/g, (_m, s, c: string) => (s ? " " : "") + c.toUpperCase());
      say = proposed ? "I see what you mean. Here it is again, changed." : "I can see it now. Here's what I heard.";
      tool = {
        name: "propose_brief",
        input: {
          name: title, oneLiner: what.slice(0, 190) || `A home for ${domain}.`, audience: who.slice(0, 290), goal: `Get visitors to understand ${title} and get in touch.`,
          pages: ["Home"], sections: ["Hero", "What we do", "Get in touch"], tone: feel.slice(0, 110),
          palette: palette ? { primary: palette[1], accent: palette[2], background: palette[3], text: palette[4] } : { primary: "#5b3fa0", accent: "#e0b04a", background: "#14121c", text: "#f4efe4" },
          notes: proposed ? lastOwner.slice(0, 500) : "",
        },
      };
    } else {
      say = "I'm listening.";
    }
    return this.finish(req, say, tool, onText, tool ? "tool_use" : "end_turn");
  }

  private async finish(req: TurnRequest, say: string, tool: { name: string; input: unknown } | null, onText: (d: string) => void, stop: Anthropic.Beta.BetaStopReason): Promise<TurnResult> {
    for (const piece of say.match(/\S+\s*/g) ?? []) {
      onText(piece);
      if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
    const content = [
      ...(say ? [{ type: "text", text: say, citations: null }] : []),
      ...(tool ? [{ type: "tool_use", id: "toolu_fake_" + crypto.randomBytes(8).toString("hex"), name: tool.name, input: tool.input, caller: { type: "direct" } }] : []),
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    const prefix = JSON.stringify(req.persona).length + JSON.stringify(req.messages).length;
    return { content, stopReason: stop, model: req.model, usage: { input: Math.ceil(prefix / 4), output: Math.ceil(say.length / 4) + (tool ? 120 : 0), cacheRead: 0, cacheWrite: 0 }, fellBack: false };
  }
}
