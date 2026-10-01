import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "./ports.ts";
import { canonicalJson } from "./util/bytes.ts";

export const SYSTEM_CHAIN = "00000000-0000-0000-0000-000000000000";

export interface AuditEntry {
  /** The user whose chain this row belongs to, or SYSTEM_CHAIN. */
  chainId: string;
  actorKind: "user" | "agent" | "cli" | "system" | "support";
  actorId?: string;
  action: string;
  resourceKind?: string;
  resourceId?: string;
  /** Opaque ids and counts only: never values, names or tokens. */
  detail?: Record<string, unknown>;
  pii?: unknown;
  retentionClass?: string;
}

/**
 * Append one row to a chain inside the caller's transaction. The chain-head row is locked (`FOR UPDATE`), so
 * concurrent appends serialise and `seq` has no gaps; the MAC covers the canonical row plus `prev_mac`.
 */
export async function appendAudit(ctx: Pick<AppContext, "kms" | "clock">, c: PoolClient, e: AuditEntry): Promise<{ seq: number }> {
  await c.query("insert into audit_heads (chain_id, seq, head_mac) values ($1, 0, '\\x') on conflict (chain_id) do nothing", [e.chainId]);
  const head = (await c.query("select seq, head_mac from audit_heads where chain_id = $1 for update", [e.chainId])).rows[0] as { seq: string; head_mac: Buffer };
  const seq = Number(head.seq) + 1;
  const at = ctx.clock.now();
  const row = {
    chain: e.chainId, seq, at: at.toISOString(), actor_kind: e.actorKind, actor_id: e.actorId ?? null, action: e.action,
    resource_kind: e.resourceKind ?? null, resource_id: e.resourceId ?? null, detail: e.detail ?? {}, pii: e.pii ?? null,
  };
  const mac = await ctx.kms.hmac("audit", Buffer.concat([Buffer.from(canonicalJson(row)), head.head_mac]));
  await c.query(
    `insert into audit_log (chain_id, seq, at, actor_kind, actor_id, action, resource_kind, resource_id, pii, detail, retention_class, prev_mac, mac)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [e.chainId, seq, at, e.actorKind, e.actorId ?? null, e.action, e.resourceKind ?? null, e.resourceId ?? null, e.pii ?? null, e.detail ?? {}, e.retentionClass ?? "standard", head.head_mac, mac],
  );
  await c.query("update audit_heads set seq = $2, head_mac = $3 where chain_id = $1", [e.chainId, seq, mac]);
  return { seq };
}

/** Recompute a chain from the first row. Returns the first bad seq, or null when the chain is intact. */
export async function verifyChain(ctx: Pick<AppContext, "kms">, c: PoolClient, chainId: string): Promise<{ ok: true; length: number } | { ok: false; badSeq: number; reason: string }> {
  const rows = (await c.query("select * from audit_log where chain_id = $1 order by seq", [chainId])).rows;
  let prev = Buffer.from("");
  let expectSeq = 1;
  for (const r of rows) {
    if (Number(r.seq) !== expectSeq) return { ok: false, badSeq: expectSeq, reason: "gap" };
    if (!Buffer.from(r.prev_mac).equals(prev)) return { ok: false, badSeq: Number(r.seq), reason: "prev_mac" };
    const row = {
      chain: r.chain_id, seq: Number(r.seq), at: new Date(r.at).toISOString(), actor_kind: r.actor_kind, actor_id: r.actor_id, action: r.action,
      resource_kind: r.resource_kind, resource_id: r.resource_id, detail: r.detail, pii: r.pii,
    };
    const mac = await ctx.kms.hmac("audit", Buffer.concat([Buffer.from(canonicalJson(row)), prev]));
    if (!mac.equals(Buffer.from(r.mac))) return { ok: false, badSeq: Number(r.seq), reason: "mac" };
    prev = Buffer.from(r.mac);
    expectSeq++;
  }
  return { ok: true, length: rows.length };
}
