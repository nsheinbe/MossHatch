import fs from "node:fs";
import path from "node:path";
import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN, verifyChain } from "../audit.ts";
import { canonicalJson } from "../util/bytes.ts";
import { raiseAlert } from "./alerts.ts";

export interface AnchorHead { chain_id: string; seq: number; head_mac: string /* hex */ }
export interface AnchorRecord {
  v: 1;
  id: string;
  anchoredAt: string;
  heads: AnchorHead[];
  /** KMS HMAC over the canonical record body, hex. */
  anchorMac: string;
}

/**
 * Where anchors live outside the database. Production is a write-once bucket in the log-archive account
 * (S3ObjectLockAnchorSink, unproven here); tests and local use FileAnchorSink.
 * `put` must refuse to overwrite; `list` returns every anchor, oldest first.
 */
export interface AnchorSink {
  put(a: AnchorRecord): Promise<{ ref: string }>;
  list(): Promise<AnchorRecord[]>;
}

/** Write-once files: `wx` refuses to replace, and the file is made read-only. A local stand-in for the bucket, not a security boundary. */
export class FileAnchorSink implements AnchorSink {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async put(a: AnchorRecord) {
    const name = `${a.anchoredAt.replace(/[:.]/g, "-")}_${a.id}.json`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, JSON.stringify(a), { flag: "wx", mode: 0o444 });
    return { ref: "file:" + name };
  }
  async list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as AnchorRecord)
      .sort((x, y) => x.anchoredAt.localeCompare(y.anchoredAt));
  }
}

export class MemoryAnchorSink implements AnchorSink {
  items: AnchorRecord[] = [];
  async put(a: AnchorRecord) {
    if (this.items.some((x) => x.id === a.id)) throw new Error("anchor_exists");
    this.items.push(a);
    return { ref: "mem:" + a.id };
  }
  async list() { return [...this.items].sort((x, y) => x.anchoredAt.localeCompare(y.anchoredAt)); }
}

/**
 * S3 Object Lock implementation, NOT EXERCISED in this repository (no AWS account here). Deployment notes:
 *  - bucket in the log-archive account with Object Lock enabled, default retention COMPLIANCE for at least 35 days
 *    (anchors are tiny: keep them for years with a longer default), versioning on, no delete permission for the app role;
 *  - the app role may only s3:PutObject to `anchors/` and s3:ListBucket/GetObject for reads;
 *  - `put` sends `If-None-Match: *` so an existing key is never replaced, and Object Lock headers set the retention date.
 * The client is injected (any object with putObject/listObjects/getObject) so this file adds no dependency.
 */
export interface S3LikeClient {
  putObject(p: { Bucket: string; Key: string; Body: string; ContentType: string; IfNoneMatch: "*"; ObjectLockMode: "COMPLIANCE"; ObjectLockRetainUntilDate: Date }): Promise<void>;
  listKeys(p: { Bucket: string; Prefix: string }): Promise<string[]>;
  getObject(p: { Bucket: string; Key: string }): Promise<string>;
}
export class S3ObjectLockAnchorSink implements AnchorSink {
  constructor(private s3: S3LikeClient, private bucket: string, private retainDays = 3650, private now: () => Date = () => new Date()) {}
  async put(a: AnchorRecord) {
    const Key = `anchors/${a.anchoredAt.replace(/[:.]/g, "-")}_${a.id}.json`;
    await this.s3.putObject({ Bucket: this.bucket, Key, Body: JSON.stringify(a), ContentType: "application/json", IfNoneMatch: "*", ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(this.now().getTime() + this.retainDays * 86_400_000) });
    return { ref: `s3://${this.bucket}/${Key}` };
  }
  async list() {
    const keys = (await this.s3.listKeys({ Bucket: this.bucket, Prefix: "anchors/" })).sort();
    const out: AnchorRecord[] = [];
    for (const Key of keys) out.push(JSON.parse(await this.s3.getObject({ Bucket: this.bucket, Key })) as AnchorRecord);
    return out.sort((x, y) => x.anchoredAt.localeCompare(y.anchoredAt));
  }
}

type AnchorCtx = Pick<AppContext, "cron" | "kms" | "clock" | "services">;

function macInput(a: Pick<AnchorRecord, "id" | "anchoredAt" | "heads">): Buffer {
  return Buffer.from("mh-anchor-v1:" + canonicalJson({ id: a.id, at: a.anchoredAt, heads: a.heads }));
}

/**
 * Daily: snapshot every chain head, MAC the set with the KMS audit key, write it to the external sink first
 * (write-once), then record it in `audit_anchors`. A row appended after this point is "unanchored" until the next run.
 */
export async function anchorAudit(ctx: AnchorCtx, sink: AnchorSink): Promise<AnchorRecord> {
  const heads = (await ctx.cron.query("select chain_id, seq, head_mac from audit_heads where seq > 0 order by chain_id")).rows
    .map((r) => ({ chain_id: r.chain_id as string, seq: Number(r.seq), head_mac: Buffer.from(r.head_mac).toString("hex") }));
  const id = (await ctx.cron.query("select uuidv7() as id")).rows[0].id as string;
  const body = { id, anchoredAt: ctx.clock.now().toISOString(), heads };
  const anchorMac = (await ctx.kms.hmac("audit", macInput(body))).toString("hex");
  const rec: AnchorRecord = { v: 1, ...body, anchorMac };
  const { ref } = await sink.put(rec);
  await tx(ctx.cron, async (c) => {
    await c.query("insert into audit_anchors (id, anchored_at, heads, anchor_mac, external_ref) values ($1,$2,$3,$4,$5)", [id, body.anchoredAt, JSON.stringify(heads), Buffer.from(anchorMac, "hex"), ref]);
    await appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "audit.anchor", resourceKind: "audit_anchor", resourceId: id, detail: { chains: heads.length } });
  });
  return rec;
}

export type Finding =
  | { kind: "anchor_mac"; anchorId: string }
  | { kind: "truncated"; anchorId: string; chainId: string; anchoredSeq: number; presentSeq: number }
  | { kind: "mac_mismatch"; anchorId: string; chainId: string; seq: number }
  | { kind: "chain_missing"; anchorId: string; chainId: string }
  | { kind: "head_mismatch"; chainId: string };

export interface AnchorVerification {
  ok: boolean;
  anchorsChecked: number;
  latestAnchorAt: string | null;
  /** Tampering: a discrepancy against an anchor taken at or before every acknowledged restore point. */
  tampered: Finding[];
  /** Discrepancies against anchors newer than an acknowledged restore point: the expected gap after a restore. */
  expectedGap: Finding[];
  /** Rows past the latest anchor's head (or in chains it does not know): normal, not an error. */
  unanchored: { chains: number; rows: number };
}

/** Restore points acknowledged in the chain itself: `restore` rows on the system chain carry `restored_to`. */
async function acknowledgedRestores(ctx: Pick<AppContext, "cron">): Promise<Date[]> {
  const r = await ctx.cron.query("select detail->>'restored_to' as t from audit_log where chain_id = $1 and action = 'restore' order by seq", [SYSTEM_CHAIN]);
  return r.rows.map((x) => new Date(x.t as string)).filter((d) => !Number.isNaN(d.getTime()));
}

/**
 * Compare the database with the anchors in the external sink. For each anchored head, the row at that seq must exist
 * with the anchored MAC. A missing tail is truncation. If a `restore` event on the system chain says the database
 * was restored to T, anchors taken after T are reported as the expected gap instead of tampering.
 */
export async function verifyAnchors(ctx: AnchorCtx, sink: AnchorSink, opts: { last?: number } = {}): Promise<AnchorVerification> {
  const all = await sink.list();
  const anchors = all.slice(-(opts.last ?? 60));
  const restores = await acknowledgedRestores(ctx);
  const restoredAt = restores.length ? new Date(Math.min(...restores.map((d) => d.getTime()))) : null;
  const out: AnchorVerification = { ok: true, anchorsChecked: anchors.length, latestAnchorAt: all.at(-1)?.anchoredAt ?? null, tampered: [], expectedGap: [], unanchored: { chains: 0, rows: 0 } };
  const put = (a: AnchorRecord, f: Finding) => {
    // An anchor taken after the restore point describes rows the restored database never had.
    (restoredAt && new Date(a.anchoredAt) > restoredAt ? out.expectedGap : out.tampered).push(f);
  };
  for (const a of anchors) {
    const mac = await ctx.kms.hmac("audit", macInput(a));
    if (mac.toString("hex") !== a.anchorMac) { out.tampered.push({ kind: "anchor_mac", anchorId: a.id }); continue; }
    for (const h of a.heads) {
      const row = (await ctx.cron.query("select mac from audit_log where chain_id = $1 and seq = $2", [h.chain_id, h.seq])).rows[0];
      if (row) {
        if (Buffer.from(row.mac).toString("hex") !== h.head_mac) put(a, { kind: "mac_mismatch", anchorId: a.id, chainId: h.chain_id, seq: h.seq });
        continue;
      }
      const max = (await ctx.cron.query("select coalesce(max(seq), 0) as m from audit_log where chain_id = $1", [h.chain_id])).rows[0].m;
      if (Number(max) === 0) put(a, { kind: "chain_missing", anchorId: a.id, chainId: h.chain_id });
      else put(a, { kind: "truncated", anchorId: a.id, chainId: h.chain_id, anchoredSeq: h.seq, presentSeq: Number(max) });
    }
  }
  // Heads table and log must agree (a truncated log with an intact heads row, or the reverse).
  const heads = (await ctx.cron.query(
    `select h.chain_id, h.seq, h.head_mac, (select l.mac from audit_log l where l.chain_id = h.chain_id and l.seq = h.seq) as tail_mac,
            (select max(seq) from audit_log l where l.chain_id = h.chain_id) as max_seq
     from audit_heads h where h.seq > 0`)).rows;
  for (const h of heads) if (!h.tail_mac || !Buffer.from(h.tail_mac).equals(Buffer.from(h.head_mac)) || Number(h.max_seq) !== Number(h.seq)) out.tampered.push({ kind: "head_mismatch", chainId: h.chain_id });
  // Unanchored rows: past the latest anchor.
  const latest = all.at(-1);
  const anchored = new Map((latest?.heads ?? []).map((h) => [h.chain_id, h.seq]));
  for (const h of heads) {
    const past = Number(h.seq) - (anchored.get(h.chain_id) ?? 0);
    if (past > 0) { out.unanchored.chains++; out.unanchored.rows += past; }
  }
  out.ok = out.tampered.length === 0;
  return out;
}

export interface ChainVerification { chains: number; failures: { chainId: string; badSeq: number; reason: string }[] }
export async function verifyAllChains(ctx: Pick<AppContext, "cron" | "kms">): Promise<ChainVerification> {
  const ids = (await ctx.cron.query("select chain_id from audit_heads order by chain_id")).rows.map((r) => r.chain_id as string);
  const failures: ChainVerification["failures"] = [];
  for (const id of ids) {
    const r = await tx(ctx.cron, (c) => verifyChain(ctx, c, id));
    if (!r.ok) failures.push({ chainId: id, badSeq: r.badSeq, reason: r.reason });
  }
  return { chains: ids.length, failures };
}

export const ANCHOR_MAX_AGE_HOURS = 25;

/** audit.verify: recompute every chain, compare with the anchors, alert on any failure or a stale anchor. */
export async function auditVerifyJob(ctx: AnchorCtx, sink: AnchorSink): Promise<{ chains: ChainVerification; anchors: AnchorVerification }> {
  const chains = await verifyAllChains(ctx);
  const anchors = await verifyAnchors(ctx, sink);
  for (const f of chains.failures) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "audit.chain_broken", subject: f.chainId, detail: { bad_seq: f.badSeq, reason: f.reason } });
  if (!anchors.ok) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "audit.anchor_mismatch", subject: "anchors", detail: { findings: anchors.tampered.length, first: anchors.tampered[0]?.kind } });
  const ageMs = anchors.latestAnchorAt ? ctx.clock.now().getTime() - Date.parse(anchors.latestAnchorAt) : Infinity;
  if (ageMs > ANCHOR_MAX_AGE_HOURS * 3_600_000) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "audit.anchor_stale", subject: "anchors", detail: { latest: anchors.latestAnchorAt } });
  return { chains, anchors };
}
