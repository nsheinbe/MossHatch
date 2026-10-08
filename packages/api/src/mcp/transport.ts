import type { AppContext } from "../ports.ts";
import { json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { isRpcRequest, LATEST, RPC, SUPPORTED, type CallMeta, type RpcRequest } from "./server.ts";

/** Browsers send Origin; server-side MCP clients usually do not. A present Origin must be the app's own. */
export function originAllowed(ctx: AppContext, origin: string | null): boolean {
  if (origin === null) return true;
  return ctx.config.allowedOrigins.includes(origin) || origin === ctx.config.origin;
}

export const deny = (status: number, code: string, headers?: Record<string, string>): HandlerResult => ({ status, json: { error: { code } }, headers });

/**
 * The checks every MCP POST passes after its own authentication, in order: no token in the query string, a supported protocol
 * version, one JSON-RPC message (no batch) with an id unless it is a notification, and method headers that agree with the body.
 */
export function readRpc(req: HandlerReq): { ok: true; msg: RpcRequest; meta: CallMeta } | { ok: false; res: HandlerResult } {
  // The token is never read from the query string (MCP authorization: header only).
  if (req.url.searchParams.has("access_token")) return { ok: false, res: deny(400, "token_in_query") };
  const pv = req.request.headers.get("mcp-protocol-version");
  if (pv !== null && !(SUPPORTED as readonly string[]).includes(pv)) return { ok: false, res: deny(400, "unsupported_protocol_version") };
  const meta: CallMeta = pv === LATEST ? { era: "2026", version: LATEST } : { era: "legacy", version: pv ?? SUPPORTED[1] };
  const msg = req.body;
  const bad = (message: string, id: RpcRequest["id"] = null) => ({ ok: false as const, res: json({ jsonrpc: "2.0", id: id ?? null, error: { code: RPC.invalidRequest, message } }, 400) });
  if (Array.isArray(msg)) return bad("Batches are not supported");
  if (!isRpcRequest(msg)) return bad("Invalid request");
  // A request's id is never null (MCP), and a message without an id is a notification: only `notifications/*` methods are
  // accepted as one, so a tool never runs from a message the protocol says gets no answer.
  if (msg.id === null || (msg.id === undefined && !msg.method.startsWith("notifications/"))) return bad("Invalid request");
  // 2026-07-28 method headers, when sent, must agree with the body (a proxy may route on them).
  const hm = req.request.headers.get("mcp-method"), hn = req.request.headers.get("mcp-name");
  if (hm !== null && hm !== msg.method) return bad("Mcp-Method does not match", msg.id);
  if (hn !== null && msg.method === "tools/call" && hn !== msg.params?.name) return bad("Mcp-Name does not match", msg.id);
  return { ok: true, msg, meta };
}
