import { z } from "zod";
import type { DnsRecord } from "@mosshatch/registrar/port";
import { normalizeRecord } from "@mosshatch/registrar/dns";
import { HttpError } from "../http/router.ts";
import { normalizeOwner } from "../domain-mgmt/classify.ts";
import type { VercelTarget } from "./providers.ts";

/**
 * The recipe registry: versioned, code-reviewed, declarative. A recipe turns (the domain, its live zone, the non-secret
 * facts its connections' last check read from the provider, the person's input) into plan parts. It never reads a
 * credential or a value: variable values are fetched at apply time by the `recipe.apply` job and go straight to the vault
 * or the host. Changing a recipe means a new version; a plan records the version it was made with.
 */

export type Service = "vercel" | "neon" | "resend";
export type Env = "dev" | "preview" | "prod";
export const VERCEL_ENV: Record<VercelTarget, Env> = { production: "prod", preview: "preview", development: "dev" };

export interface ConnFacts { id: string; service: Service; externalRef: string | null; facts: Record<string, unknown>; checkedAt: string | null }
export interface PlanInputs { fqdn: string; domainId: string; live: DnsRecord[] | null; conns: ReadonlyMap<Service, ConnFacts> }

export type VarTarget = { kind: "nest"; env: Env } | { kind: "vercel"; target: VercelTarget; env: Env };
export type VarSource = "neon.pooled" | "neon.direct" | "resend.sending_key";
export interface PlanVariable { name: string; source: VarSource; targets: VarTarget[] }
export type Cost = "free" | "billable" | "unknown";
export interface PlanStep { service: Service; op: string; target: string; creates_resource: boolean; cost: Cost }
export interface PendingRecord { type: string; name: string; fidelity: "pending_provider_create" }

export interface PlanParts {
  dns: { add: DnsRecord[]; remove: DnsRecord[] };
  pending_records: PendingRecord[];
  variables: PlanVariable[];
  steps: PlanStep[];
  services: Service[];
}

export interface Recipe<I = any> {
  id: string;
  version: number;
  title: string;
  summary: string;
  services: Service[];
  touchesDns: boolean;
  input: z.ZodType<I>;
  build(p: PlanInputs, input: I): PlanParts;
}

const envs = z.array(z.enum(["dev", "preview", "prod"])).min(1).max(3);
const targets = z.array(z.enum(["production", "preview", "development"])).max(3);

function need(p: PlanInputs, s: Service): ConnFacts {
  const c = p.conns.get(s);
  if (!c) throw new HttpError(409, "connection_missing", undefined, undefined, { service: s });
  return c;
}
const factsOf = (c: ConnFacts, keys: string[]) => {
  for (const k of keys) if (c.facts[k] === undefined || c.facts[k] === null || c.facts[k] === "") throw new HttpError(409, "connection_unchecked", undefined, undefined, { service: c.service });
  return c.facts;
};
function hosted(p: PlanInputs): DnsRecord[] {
  if (!p.live) throw new HttpError(409, "dns_not_hosted");
  return p.live;
}
const rec = (type: DnsRecord["type"], name: string, value: string, priority?: number): DnsRecord => normalizeRecord({ type, name, value, ...(priority !== undefined ? { priority } : {}) });
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// ---- hosting: Vercel ------------------------------------------------------------------------------------------------------

const vercelInput = z.strictObject({ include_www: z.boolean().default(true) });
export const hostingVercel: Recipe<z.infer<typeof vercelInput>> = {
  id: "hosting-vercel", version: 1, title: "Host on Vercel", summary: "Points the domain (and www) at your Vercel project and attaches both names to it.",
  services: ["vercel"], touchesDns: true, input: vercelInput,
  build(p, input) {
    const live = hosted(p);
    const c = need(p, "vercel");
    const f = factsOf(c, ["a", "cname"]);
    const a = String((f.a as string[])[0] ?? ""), cname = String(f.cname).toLowerCase().replace(/\.$/, "");
    if (!IPV4.test(a) || !HOST.test(cname)) throw new HttpError(409, "connection_unchecked", undefined, undefined, { service: "vercel" });
    const add = [rec("A", "", a)];
    // Vercel does not take AAAA for external DNS, and any other apex address would split traffic.
    const remove = live.filter((r) => r.name === "" && (r.type === "AAAA" || (r.type === "A" && r.value !== a)));
    const steps: PlanStep[] = [{ service: "vercel", op: "project.domain.add", target: p.fqdn, creates_resource: false, cost: "free" }];
    if (input.include_www) {
      add.push(rec("CNAME", "www", cname));
      // A CNAME is exclusive at its name: everything else at www goes, named one by one.
      remove.push(...live.filter((r) => r.name === "www" && !(r.type === "CNAME" && r.value === cname)));
      steps.push({ service: "vercel", op: "project.domain.add", target: `www.${p.fqdn}`, creates_resource: false, cost: "free" });
    }
    return { dns: { add, remove }, pending_records: [], variables: [], steps, services: ["vercel"] };
  },
};

// ---- Postgres: Neon -------------------------------------------------------------------------------------------------------

const neonInput = z.strictObject({
  envs: envs.default(["dev"]),
  vercel_targets: targets.default([]),
  prefix: z.string().max(40).default(""),
  create_project: z.boolean().default(false),
});
export const postgresNeon: Recipe<z.infer<typeof neonInput>> = {
  id: "postgres-neon", version: 1, title: "Postgres on Neon", summary: "Stores the pooled DATABASE_URL and the direct DATABASE_URL_UNPOOLED for your Neon project in the Nest, and optionally in your Vercel project.",
  services: ["neon"], touchesDns: false, input: neonInput,
  build(p, input) {
    const c = need(p, "neon");
    const steps: PlanStep[] = [];
    if (input.create_project) steps.push({ service: "neon", op: "project.create", target: p.fqdn, creates_resource: true, cost: "unknown" });
    else factsOf(c, ["project_id"]);
    const services: Service[] = ["neon"];
    const tg: VarTarget[] = [...new Set(input.envs)].sort().map((env) => ({ kind: "nest" as const, env }));
    if (input.vercel_targets.length) {
      const v = need(p, "vercel");
      if (!v.externalRef) throw new HttpError(409, "connection_unchecked", undefined, undefined, { service: "vercel" });
      services.push("vercel");
      for (const t of [...new Set(input.vercel_targets)].sort()) tg.push({ kind: "vercel", target: t, env: VERCEL_ENV[t] });
      steps.push({ service: "vercel", op: "env.upsert", target: input.vercel_targets.slice().sort().join(","), creates_resource: false, cost: "free" });
    }
    const pre = input.prefix;
    return {
      dns: { add: [], remove: [] }, pending_records: [], steps, services,
      variables: [{ name: `${pre}DATABASE_URL`, source: "neon.pooled", targets: tg }, { name: `${pre}DATABASE_URL_UNPOOLED`, source: "neon.direct", targets: tg }],
    };
  },
};

// ---- email: Resend --------------------------------------------------------------------------------------------------------

const resendInput = z.strictObject({ envs: envs.default(["dev"]), region: z.enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"]).default("us-east-1") });
/** Resend names records relative in one answer and as full names in another, and quotes SPF values: canonicalise both. */
export function resendRecordToDns(fqdn: string, r: { type: string; name: string; value: string; priority?: number }): DnsRecord {
  const name = normalizeOwner(r.name, fqdn);
  const value = r.type === "TXT" ? r.value.trim().replace(/^"(.*)"$/, "$1") : r.value.trim().toLowerCase().replace(/\.$/, "");
  return rec(r.type as DnsRecord["type"], name, value, r.type === "MX" ? (r.priority ?? 10) : undefined);
}
export const emailResend: Recipe<z.infer<typeof resendInput>> = {
  id: "email-resend", version: 1, title: "Email with Resend", summary: "Adds your domain at Resend, writes its DKIM, return-path MX and SPF records, and stores a send-only RESEND_API_KEY in the Nest.",
  services: ["resend"], touchesDns: true, input: resendInput,
  build(p, input) {
    const live = hosted(p);
    const c = need(p, "resend");
    const steps: PlanStep[] = [];
    const add: DnsRecord[] = [], remove: DnsRecord[] = [], pending: PendingRecord[] = [];
    const recs = Array.isArray(c.facts.records) ? c.facts.records as { type: string; name: string; value: string; priority?: number }[] : null;
    if (typeof c.facts.domain_id === "string" && recs && recs.length) {
      for (const r of recs) {
        const d = resendRecordToDns(p.fqdn, r);
        add.push(d);
        // Only the records Resend owns at these names are replaced; each is named, never a blanket delete.
        remove.push(...live.filter((x) => x.name === d.name && x.type === d.type && x.value !== d.value && (d.type !== "TXT" || /^v=spf1|^p=/.test(x.value))));
      }
    } else {
      steps.push({ service: "resend", op: "domain.create", target: p.fqdn, creates_resource: true, cost: "free" });
      pending.push({ type: "TXT", name: "resend._domainkey", fidelity: "pending_provider_create" }, { type: "MX", name: "send", fidelity: "pending_provider_create" }, { type: "TXT", name: "send", fidelity: "pending_provider_create" });
    }
    const variables: PlanVariable[] = [];
    if (typeof c.facts.sending_key_id !== "string") {
      steps.push({ service: "resend", op: "api_key.create", target: p.fqdn, creates_resource: true, cost: "free" });
      variables.push({ name: "RESEND_API_KEY", source: "resend.sending_key", targets: [...new Set(input.envs)].sort().map((env) => ({ kind: "nest" as const, env })) });
    }
    void input.region;
    return { dns: { add, remove }, pending_records: pending, variables, steps, services: ["resend"] };
  },
};

export const RECIPES: readonly Recipe[] = [hostingVercel, postgresNeon, emailResend];
export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
