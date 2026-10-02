import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import {
  beginTurn, cancelBuild, confirmBuild, exportBuild, getConversation, openConversation, quoteProposal, refreshBuild, requireLauncher, runTurn, status,
  type TurnEvent,
} from "./service.ts";

/**
 * /api/v1/launcher: session-only routes (cookie, CSRF-guarded mutations). Every one checks the flag, the configuration and the invite
 * (`requireLauncher`) before it touches the model, Slate or money; demo visitors only ever get `status` (access false) and the teaser.
 */

const uid = (r: HandlerReq) => { if (!r.principal.userId) throw new HttpError(401, "unauthorized"); return r.principal.userId; };
const body = (r: HandlerReq) => (r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {});

/** One SSE frame. Event names are fixed; data is JSON (no newlines can break the frame). */
export function sseFrame(e: TurnEvent): Uint8Array {
  const { type, ...data } = e;
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerLauncher(router: Router): Router {
  router.add(
    {
      method: "GET", path: "/api/v1/launcher/status", principals: ["anonymous", "session"], tag: "launcher",
      async handler(r) { return json(await status(r.ctx, r.principal.kind === "session" ? r.principal.userId : undefined)); },
    },
    {
      method: "POST", path: "/api/v1/launcher/conversations", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        return json({ conversation: await openConversation(r.ctx, svc, uid(r), { domain: body(r).domain, source: body(r).source }) });
      },
    },
    {
      method: "GET", path: "/api/v1/launcher/conversations/:id", principals: ["session"], tag: "launcher",
      async handler(r) {
        await requireLauncher(r.ctx, uid(r));
        return json({ conversation: await getConversation(r.ctx, uid(r), r.params.id!) });
      },
    },
    {
      // The creature's turn, streamed as Server-Sent Events over a same-origin fetch (CSP connect-src 'self'). Everything that can
      // refuse (caps, the lease, validation) refuses with a JSON error before the stream opens.
      method: "POST", path: "/api/v1/launcher/conversations/:id/turn", principals: ["session"], tag: "launcher", maxBodyBytes: 8_192,
      async handler(r) {
        const userId = uid(r);
        const svc = await requireLauncher(r.ctx, userId);
        const { row, text } = await beginTurn(r.ctx, svc, userId, r.params.id!, body(r).text ?? "");
        const ctx = r.ctx;
        const sse = new ReadableStream<Uint8Array>({
          async start(controller) {
            let open = true;
            const emit = (e: TurnEvent) => { if (!open) return; try { controller.enqueue(sseFrame(e)); } catch { open = false; } };
            try { await runTurn(ctx, svc, userId, row as never, text, emit); }
            catch (e) { console.error("launcher_turn", (e as Error)?.name); emit({ type: "error", code: "internal" }); }
            finally { if (open) { open = false; try { controller.close(); } catch { /* reader gone */ } } }
          },
        });
        return { status: 200, sse };
      },
    },
    {
      method: "POST", path: "/api/v1/launcher/quotes", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        return json(await quoteProposal(r.ctx, svc, uid(r), { proposal_id: body(r).proposal_id, base_build_id: body(r).base_build_id }));
      },
    },
    {
      method: "POST", path: "/api/v1/launcher/builds", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        const b = body(r);
        return json(await confirmBuild(r.ctx, svc, uid(r), { quote_id: b.quote_id, idempotency_key: b.idempotency_key, confirm: b.confirm }), 202);
      },
    },
    {
      method: "GET", path: "/api/v1/launcher/builds/:id", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        return json(await refreshBuild(r.ctx, svc, uid(r), r.params.id!));
      },
    },
    {
      method: "POST", path: "/api/v1/launcher/builds/:id/cancel", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        return json(await cancelBuild(r.ctx, svc, uid(r), r.params.id!));
      },
    },
    {
      method: "GET", path: "/api/v1/launcher/builds/:id/export", principals: ["session"], tag: "launcher",
      async handler(r) {
        const svc = await requireLauncher(r.ctx, uid(r));
        return { status: 200, download: await exportBuild(r.ctx, svc, uid(r), r.params.id!) };
      },
    },
  );
  return router;
}
