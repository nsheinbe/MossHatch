import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBinding } from "../vault/testkit.ts";
import type { JobRow } from "../jobs/registry.ts";
import { recipeApplyJob } from "./apply.ts";
import { planHash, type Plan } from "./plan.ts";
import { appRow, applyReq, approvePlan, bearer, connect, makePerson, makeRecipeKit, tick, web, type RecipeKit } from "./testkit.ts";

let k: RecipeKit, sequence = 0;
beforeAll(async () => { k = await makeRecipeKit(); }, 120_000);
beforeEach(async () => { await k.app.db.owner.query("delete from rate_counters"); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await k?.drop(); });

async function queued(o: { create?: boolean; kind?: "agent" | "cli"; ownerApply?: boolean; planOnly?: boolean; distinctApplier?: boolean; oauth?: boolean } = {}) {
  const tag = `queue${++sequence}`;
  const p = await makePerson(k, tag);
  const credential = `fixture-neon-${tag}-NOT-A-LIVE-CREDENTIAL`;
  const project = `neon-${tag}`, vercelProject = `vercel-${tag}`;
  if (o.create) k.fakes.neon.setOrgCredential(credential); else k.fakes.neon.addProject(project, credential);
  const neonConnection = await connect(k, p, "neon", credential, o.create ? undefined : project);
  const vercelCredential = `fixture-vercel-${tag}-NOT-A-LIVE-CREDENTIAL`;
  k.fakes.vercel.addProject(vercelProject, vercelCredential);
  const vercelConnection = await connect(k, p, "vercel", vercelCredential, vercelProject);
  const scopes = ["dev", "preview"].flatMap((env) => [
    { capability: "recipes.apply", domain_id: p.domain.id, env },
    { capability: "secrets.write", domain_id: p.domain.id, env },
  ]);
  const t = await makeBinding(k, p, o.planOnly ? [{ capability: "recipes.plan", domain_id: p.domain.id, env: null }] : scopes, o.kind ?? "agent");
  if (o.oauth) await k.app.db.owner.query("update bindings set family_expires_at=expires_at, expires_at=$2 where id=$1", [t.id, new Date(k.app.clock.now().getTime() + 3600_000)]);
  const r = await bearer(k, t.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, {
    input: { create_project: !!o.create, envs: ["dev"], vercel_targets: ["preview"] },
  });
  expect(r.status, r.text).toBe(201);
  if (r.json.plan.needs_approval) await approvePlan(k, p, r.json.application_id);
  const applier = o.distinctApplier ? await makeBinding(k, p, scopes, "cli") : t;
  const applied = o.ownerApply || o.planOnly
    ? await applyReq(k, p, "postgres-neon", r.json.application_id, r.json.plan.plan_hash)
    : await bearer(k, applier.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash });
  expect(applied.status, applied.text).toBe(202);
  const job = (await k.app.db.owner.query("select * from jobs where kind='recipe.apply' and payload->>'application_id'=$1", [r.json.application_id])).rows[0] as JobRow;
  expect(job).toBeTruthy();
  k.fakes.neon.calls.length = 0; k.fakes.vercel.calls.length = 0;
  return { p, t, applier, job, appId: r.json.application_id as string, neonConnection, vercelConnection, vercelProject, credential, createdBefore: k.fakes.neon.created.length };
}
type Queued = Awaited<ReturnType<typeof queued>>;
const versions = async (x: Queued) => (await k.app.db.owner.query("select s.name,s.env,v.version from secrets s join secret_versions v on v.secret_id=s.id where s.user_id=$1 order by s.name,s.env,v.version", [x.p.user.userId])).rows;
const providerCalls = () => [...k.fakes.neon.calls, ...k.fakes.vercel.calls].filter((c) => ["createProject", "connectionUri", "upsertEnv"].includes(c.op));
async function noEffects(x: Queued) {
  expect(providerCalls()).toEqual([]);
  expect(await versions(x)).toEqual([]);
  expect(k.fakes.neon.created.length).toBe(x.createdBefore);
  expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(0);
}
async function failWithoutEffects(x: Queued) {
  await tick(k);
  const saved = await appRow(k, x.appId);
  expect(saved.state, saved.failure_code).toBe("failed");
  expect(saved.failure_code).toMatch(/^[a-z_]+$/);
  await noEffects(x);
  // A terminal failed application is not made executable by delivering its job again.
  await recipeApplyJob(k.app.ctx, x.job);
  expect((await appRow(k, x.appId)).state).toBe("failed");
  await noEffects(x);
}
async function pause(x: Queued, id = x.t.id) {
  const r = await web(k, x.p, "POST", `/api/v1/bindings/${id}/pause`, {});
  expect(r.status, r.text).toBe(200);
}
async function revoke(x: Queued, id = x.t.id) {
  const r = await web(k, x.p, "DELETE", `/api/v1/bindings/${id}`);
  expect(r.status, r.text).toBe(200);
}

describe("ST-210 queued Neon recipes: exact grants remain required at dispatch", () => {
  it.each(["revoked", "paused", "expired", "family expired", "scope narrowed", "grant extended"])("refuses a %s grant after enqueue, including another delivery", async (state) => {
    const x = await queued({ create: true, oauth: state === "family expired" });
    if (state === "revoked") await revoke(x);
    if (state === "paused") await pause(x);
    if (state === "expired") await k.app.db.owner.query("update bindings set expires_at=$2 where id=$1", [x.t.id, new Date(k.app.clock.now().getTime() - 1)]);
    if (state === "family expired") await k.app.db.owner.query("update bindings set family_expires_at=$2 where id=$1", [x.t.id, new Date(k.app.clock.now().getTime() - 1)]);
    if (state === "scope narrowed") await k.app.db.owner.query("update bindings set scopes=$2 where id=$1", [x.t.id, JSON.stringify([
      { capability: "recipes.apply", domain_id: x.p.domain.id, env: "dev" }, { capability: "secrets.write", domain_id: x.p.domain.id, env: "dev" },
    ])]);
    if (state === "grant extended") await k.app.db.owner.query("update bindings set expires_at=expires_at+interval '1 day' where id=$1", [x.t.id]);
    await failWithoutEffects(x);
  });

  it("keeps a plan-only creator's dependency when the owner applies its plan", async () => {
    const x = await queued({ planOnly: true });
    await revoke(x);
    await failWithoutEffects(x);
  });

  it.each(["creator", "applier"])("rechecks the %s when two different bindings plan and apply", async (role) => {
    const x = await queued({ distinctApplier: true });
    await pause(x, role === "creator" ? x.t.id : x.applier.id);
    await failWithoutEffects(x);
  });

  it("permits a live plan-only creator and an owner's explicitly applied plan", async () => {
    const x = await queued({ planOnly: true });
    await tick(k);
    expect((await appRow(k, x.appId)).state).toBe("applied");
    expect(await versions(x)).toHaveLength(2);
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(2);
  });

  it("preserves valid OAuth refresh rotation and does not duplicate effects on redelivery", async () => {
    const x = await queued({ oauth: true, kind: "cli" });
    // Access rotation is not a grant change: family expiry and granted resources are unchanged.
    await k.app.db.owner.query("update bindings set token_hash=decode(repeat('ab',32),'hex'),expires_at=$2 where id=$1", [x.t.id, new Date(k.app.clock.now().getTime() + 1800_000)]);
    await tick(k);
    expect((await appRow(k, x.appId)).state).toBe("applied");
    expect(await versions(x)).toHaveLength(2);
    expect(providerCalls().map((c) => c.op)).toEqual(["connectionUri", "connectionUri", "upsertEnv", "upsertEnv"]);
    const before = providerCalls().length;
    await recipeApplyJob(k.app.ctx, x.job);
    expect(providerCalls()).toHaveLength(before);
    expect(await versions(x)).toHaveLength(2);
  });

  it.each(["missing", "wrong grant", "wrong creator", "wrong owner", "wrong domain", "wrong plan", "wrong job actor"])("fails closed for %s execution metadata", async (kind) => {
    const x = await queued();
    const job = structuredClone(x.job);
    if (kind === "missing") delete job.payload.authorization;
    else {
      const authorization = job.payload.authorization as Record<string, any>;
      expect(authorization).toBeTruthy();
      if (kind === "wrong grant") authorization.applier.grant_hash = "0".repeat(64);
      if (kind === "wrong creator") authorization.creator.id = "00000000-0000-7000-8000-00000000abcd";
      if (kind === "wrong owner") authorization.user_id = "00000000-0000-7000-8000-00000000abcd";
      if (kind === "wrong domain") authorization.domain_id = "00000000-0000-7000-8000-00000000abcd";
      if (kind === "wrong plan") authorization.plan_hash = "0".repeat(64);
      if (kind === "wrong job actor") { job.payload.by_kind = "user"; job.payload.by_id = x.p.user.userId; }
    }
    await k.app.db.owner.query("update jobs set payload=$2 where id=$1", [job.id, JSON.stringify(job.payload)]);
    await failWithoutEffects({ ...x, job });
  });

  it("does not let a foreign job owner select another tenant through its payload", async () => {
    const x = await queued();
    const foreign = await makePerson(k, `foreign${sequence}`);
    const forged = { ...x.job, user_id: foreign.user.userId };
    await recipeApplyJob(k.app.ctx, forged).catch(() => undefined);
    await noEffects(x);
    expect((await k.app.db.owner.query("select 1 from secret_versions where user_id=$1", [foreign.user.userId])).rowCount).toBe(0);
    // Remove only this fixture job from future ticks after checking the malformed delivery.
    await k.app.db.owner.query("update jobs set state='done' where id=$1", [x.job.id]);
  });

  it("refuses a legacy queued plan without creator authorization even when its old hash is consistent", async () => {
    const x = await queued();
    const plan = (await appRow(k, x.appId)).plan as Plan;
    delete plan.authorization;
    const hash = planHash(plan);
    const job = structuredClone(x.job);
    (job.payload.authorization as Record<string, unknown>).plan_hash = hash.toString("hex");
    await k.app.db.owner.query("update recipe_applications set plan=$2,plan_hash=$3 where id=$1", [x.appId, JSON.stringify(plan), hash]);
    await k.app.db.owner.query("update jobs set payload=$2 where id=$1", [job.id, JSON.stringify(job.payload)]);
    await failWithoutEffects({ ...x, job });
    expect((await appRow(k, x.appId)).failure_code).toBe("recipe_authorization_missing");
  });

  it("refuses a domain released after enqueue", async () => {
    const x = await queued();
    await k.app.db.owner.query("update domains set released_at=$2 where id=$1", [x.p.domain.id, k.app.clock.now()]);
    await failWithoutEffects(x);
  });
});

describe("ST-211 queued Neon recipes: revocation at asynchronous effect boundaries", () => {
  it.each(["createProject", "connectionUri", "upsertEnv"].flatMap((effect) => ["pause", "revoke"].map((change) => ({ effect, change }))))("rechecks $change after credential decrypt before $effect", async ({ effect, change }) => {
    const x = await queued({ create: effect === "createProject" });
    const connection = effect === "upsertEnv" ? x.vercelConnection : x.neonConnection;
    const credentialId = (await k.app.db.owner.query("select id from connection_credentials where connection_id=$1 and revoked_at is null", [connection])).rows[0].id;
    const original = k.kms.decrypt.bind(k.kms);
    let crossed = false;
    vi.spyOn(k.kms, "decrypt").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!crossed && args[3].secret_id === credentialId) { crossed = true; await (change === "pause" ? pause(x) : revoke(x)); }
      return result;
    });
    await tick(k);
    expect(crossed).toBe(true);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(providerCalls().some((c) => c.op === effect)).toBe(false);
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(0);
    if (effect !== "upsertEnv") await noEffects(x);
    else { expect(await versions(x)).toHaveLength(1); expect(k.fakes.neon.calls.filter((c) => c.op === "connectionUri")).toHaveLength(1); }
  });

  it("stops all Nest and Vercel writes if revoked while the first URI is fetched", async () => {
    const x = await queued();
    const original = k.fakes.neon.connectionUri.bind(k.fakes.neon);
    vi.spyOn(k.fakes.neon, "connectionUri").mockImplementationOnce(async (...args) => { const result = await original(...args); await revoke(x); return result; });
    await tick(k);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(providerCalls().map((c) => c.op)).toEqual(["connectionUri"]);
    expect(await versions(x)).toEqual([]);
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(0);
  });

  it.each(["pause", "revoke"])("rechecks a %s after Nest sealing before committing a secret version", async (change) => {
    const x = await queued();
    const original = k.kms.generateDataKey.bind(k.kms);
    let sealed = false;
    vi.spyOn(k.kms, "generateDataKey").mockImplementationOnce(async (...args) => { const result = await original(...args); sealed = true; await (change === "pause" ? pause(x) : revoke(x)); return result; });
    await tick(k);
    expect(sealed).toBe(true);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(await versions(x)).toEqual([]);
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(0);
  });

  it.each(["pointer", "audit"])("rolls back a Nest version if authorization changes during its %s HMAC", async (boundary) => {
    const x = await queued();
    const original = k.app.ctx.kms.hmac.bind(k.app.ctx.kms);
    let crossed = false;
    vi.spyOn(k.app.ctx.kms, "hmac").mockImplementation(async (key, data) => {
      const result = await original(key, data);
      if (!crossed && key === boundary && (key === "pointer" || data.toString().includes('"action":"secret.write"'))) {
        crossed = true;
        // This statement commits independently; calling the pause route would also wait on this transaction's audit head.
        await k.app.db.owner.query("update bindings set paused_at=$2 where id=$1", [x.t.id, k.app.clock.now()]);
      }
      return result;
    });
    await tick(k);
    expect(crossed).toBe(true);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(await versions(x)).toEqual([]);
    expect((await k.app.db.owner.query("select 1 from audit_log where chain_id=$1 and action='secret.write'", [x.p.user.userId])).rowCount).toBe(0);
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(0);
  });

  it("retains an already created project while refusing every later effect", async () => {
    const x = await queued({ create: true });
    const original = k.fakes.neon.createProject.bind(k.fakes.neon);
    vi.spyOn(k.fakes.neon, "createProject").mockImplementationOnce(async (...args) => { const project = await original(...args); await pause(x); return project; });
    await tick(k);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(providerCalls().map((c) => c.op)).toEqual(["createProject"]);
    expect(k.fakes.neon.created.length).toBe(x.createdBefore + 1);
    const connection = (await k.app.db.owner.query("select external_ref,provider_facts from connections where id=$1", [x.neonConnection])).rows[0];
    expect(connection.external_ref).toBe(k.fakes.neon.created.at(-1));
    expect(connection.provider_facts.created_by_application).toBe(x.appId);
    expect(await versions(x)).toEqual([]);
    await recipeApplyJob(k.app.ctx, x.job);
    expect(providerCalls()).toHaveLength(1);
  });

  it("keeps the first Vercel effect but stops the next variable after a pause", async () => {
    const x = await queued();
    const original = k.fakes.vercel.upsertEnv.bind(k.fakes.vercel);
    vi.spyOn(k.fakes.vercel, "upsertEnv").mockImplementationOnce(async (...args) => { const result = await original(...args); await pause(x); return result; });
    await tick(k);
    expect((await appRow(k, x.appId)).state).toBe("failed");
    expect(k.fakes.vercel.projects.get(x.vercelProject)!.env.size).toBe(1);
    expect(await versions(x)).toHaveLength(1);
    expect(k.fakes.neon.calls.filter((c) => c.op === "connectionUri")).toHaveLength(1);
    expect(k.fakes.vercel.calls.filter((c) => c.op === "upsertEnv")).toHaveLength(1);
    await recipeApplyJob(k.app.ctx, x.job);
    expect(k.fakes.vercel.calls.filter((c) => c.op === "upsertEnv")).toHaveLength(1);
  });
});
