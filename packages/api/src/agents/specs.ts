import { z } from "zod";
import { HttpError } from "../http/router.ts";
import type { ActionType } from "../http/types.ts";
import { getActionSpec, registerActionSpec, type ActionSpec } from "../stepup/specs.ts";

/**
 * One registry entry per step-up id (the thirteen are fixed). Two ids gate more than one kind of target: `dns.sensitive.approve`
 * gates a recipe plan (recipes module) and an agent's DNS request (here); `agent.token.create` gates a token made in the
 * Bindings tab (bindings module) and an OAuth grant (oauth module). A routed spec sends a prepare or commit to the right
 * derivation by the shape of the target id and never changes the other module's behaviour. Its params carry a `route`
 * marker, which is part of the signed hash, so a summary or an executor can never be taken from the wrong side.
 */

const ROUTED = Symbol("mh.routed-spec");
interface Routed { [ROUTED]: { inner: ActionSpec | undefined; mine: ActionSpec; marker: string } }

export function registerRoutedSpec(type: ActionType, owns: (targetId: string) => boolean, marker: string, mine: ActionSpec): void {
  let inner = getActionSpec(type);
  // Registering twice (a second router in one process) wraps the original, not our own wrapper.
  while (inner && (inner as Partial<Routed>)[ROUTED] && (inner as unknown as Routed)[ROUTED].marker === marker) inner = (inner as unknown as Routed)[ROUTED].inner;
  const isMine = (p: Record<string, unknown>) => p.route === marker;
  const spec: ActionSpec & Routed = {
    type, held: true,
    userInput: z.unknown(),
    async derive(ctx, c, userId, targetId, input) {
      const s = owns(targetId) ? mine : inner;
      if (!s) throw new HttpError(409, "action_unavailable");
      const parsed = s.userInput.safeParse(input ?? {});
      if (!parsed.success) throw new HttpError(400, "invalid_request");
      const d = await s.derive(ctx, c, userId, targetId, parsed.data);
      if (s === mine && d.params.route !== marker) throw new Error("routed spec params must carry their marker");
      if (s !== mine && isMine(d.params)) throw new HttpError(409, "action_unavailable");
      return d;
    },
    summary: (p) => (isMine(p) ? mine.summary(p) : inner ? inner.summary(p) : ""),
    ...(inner?.execute ? { execute: async (ctx, c, a) => { if (!isMine(a.params)) await inner!.execute!(ctx, c, a); } } as Pick<ActionSpec, "execute"> : {}),
    [ROUTED]: { inner, mine, marker },
  };
  registerActionSpec(spec);
}
