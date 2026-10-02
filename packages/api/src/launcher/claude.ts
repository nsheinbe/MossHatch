import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, systemBlocks } from "./persona.ts";

/**
 * The creature's model, behind a port so tests, local development and e2e run a scripted fake (MH_FAKE_LAUNCHER=1) and never call
 * the API. The real adapter streams one turn with the official SDK (`client.beta.messages.stream` + `finalMessage()`), following the
 * claude-api guidance for Claude Opus 5.5:
 *   - model `claude-opus-5-5` unless MH_LAUNCHER_MODEL says otherwise; `output_config.effort: "low"` for chat turns;
 *   - no `thinking` parameter (thinking is always on and cannot be disabled on this model), no `budget_tokens`, no `temperature`;
 *   - `tool_choice` left at auto (forced tool use 400s on this model); tools are `strict`;
 *   - the system prompt and the persona carry cache breakpoints, and top-level automatic caching places the last one on the newest turn;
 *   - server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) unless MH_LAUNCHER_FALLBACKS=off.
 * `eager_input_streaming` is deliberately left off: the tool inputs are a few hundred tokens, and buffered input keeps the API's own
 * strict-schema validation, which eager streaming would give up.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Generous for a chat turn; the creature is told to be brief, and a brief is a few hundred tokens. Streaming keeps timeouts away. */
export const MAX_TOKENS = 16_000;

/** One turn's request: the frozen prefix parts and the append-only history. */
export interface TurnRequest {
  model: string;
  persona: string;
  messages: Anthropic.Beta.BetaMessageParam[];
}

/** What the service needs back from a turn. `content` is kept exactly as returned and appended to the history. */
export interface TurnResult {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: Anthropic.Beta.BetaStopReason | null;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** True when a fallback model served (or tried to serve) the turn. */
  fellBack: boolean;
}

export interface CreaturePort {
  readonly kind: "anthropic" | "fake";
  turn(req: TurnRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<TurnResult>;
}

/** A failure the owner sees as an in-character "I can't hear you right now"; the code is ours, never the API's message. */
export class CreatureError extends Error {
  override name = "CreatureError";
  constructor(readonly code: "model_rate_limited" | "model_overloaded" | "model_unavailable" | "model_bad_request" | "model_auth" | "model_aborted") { super(code); }
}

export function buildParams(req: TurnRequest, fallbacks: boolean): Anthropic.Beta.MessageCreateParamsStreaming {
  return {
    model: req.model,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(req.persona),
    tools: TOOLS,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: req.messages,
    output_config: { effort: "low" },
    cache_control: { type: "ephemeral" },
    stream: true,
    ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

export class AnthropicCreature implements CreaturePort {
  readonly kind = "anthropic" as const;
  private client: Anthropic;
  private readonly fallbacks: boolean;
  constructor(opts: { apiKey: string; fallbacks: boolean; timeoutMs?: number }) {
    this.fallbacks = opts.fallbacks;
    // Two retries (the SDK default) cover 429, 5xx and connection errors before the stream opens.
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  async turn(req: TurnRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const { stream: _s, ...params } = buildParams(req, this.fallbacks);
    void _s;
    const stream = this.client.beta.messages.stream(params, { signal });
    stream.on("text", (delta) => onText(delta));
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      // Most specific first; never pass the API's message text on.
      if (e instanceof Anthropic.APIUserAbortError) throw new CreatureError("model_aborted");
      if (e instanceof Anthropic.RateLimitError) throw new CreatureError("model_rate_limited");
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new CreatureError("model_auth");
      if (e instanceof Anthropic.BadRequestError) throw new CreatureError("model_bad_request");
      if (e instanceof Anthropic.InternalServerError) throw new CreatureError("model_overloaded");
      if (e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIError) throw new CreatureError("model_unavailable");
      throw e;
    }
    const u = msg.usage;
    return {
      content: msg.content,
      stopReason: msg.stop_reason,
      model: msg.model,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      fellBack: msg.content.some((b) => (b as { type: string }).type === "fallback") || ((u as { iterations?: { type: string }[] | null }).iterations ?? []).some((i) => i.type === "fallback_message"),
    };
  }
}

/**
 * Make an assistant turn safe to send back (append-only history): after a mid-output fallback, blocks before the last `fallback`
 * marker that the fallback model cannot read are dropped (thinking, redacted thinking, an unpaired tool use), as the API's echo rules
 * say; without a fallback the content is returned unchanged, byte for byte, which keeps thinking blocks valid and the cache warm.
 */
export function echoable(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  const last = content.map((b) => (b as { type: string }).type).lastIndexOf("fallback");
  if (last < 0) return content as unknown as Anthropic.Beta.BetaContentBlockParam[];
  return content.filter((b, i) => {
    const t = (b as { type: string }).type;
    if (i > last) return true;
    return t === "text";
  }) as unknown as Anthropic.Beta.BetaContentBlockParam[];
}
