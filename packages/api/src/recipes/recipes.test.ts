import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeBinding, type Person } from "../vault/testkit.ts";
import { readSecretsForBinding } from "../vault/read.ts";
import { prepare } from "../stepup/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { appRow, applyReq, approvePlan, bearer, connect, makePerson, makeRecipeKit, plan, seedZone, tick, web, zone, type RecipeKit } from "./testkit.ts";
import { resendRecordToDns } from "./registry.ts";

let k: RecipeKit;
beforeAll(async () => { k = await makeRecipeKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await k.app.db.owner.query("delete from rate_counters"); });

const secretOf = async (p: Person, env: "dev" | "preview" | "prod", name: string) => {
  const r = await readSecretsForBinding(k.app.ctx, { userId: p.user.userId, bindingId: "00000000-0000-7000-8000-00000000abcd", bindingKind: "cli", scopes: [{ capability: "secrets.read", domain_id: p.domain.id, env }] }, { domainId: p.domain.id, env, names: [name] });
  return r[0]?.value;
};
let cred = 0;
async function vercelPerson(tag: string) {
  const p = await makePerson(k, tag);
  const credential = `vcp_test_${tag}_${++cred}_VERCELCREDENTIALCANARY`;
  const project = `prj_${tag}${cred}`;
  k.fakes.vercel.addProject(project, credential, { ipv4: "216.198.79.1", cname: `c${cred}abcdef.vercel-dns-017.com` });
  const connectionId = await connect(k, p, "vercel", credential, project);
  return { p, credential, project, connectionId };
}
async function neonPerson(tag: string, o: { project?: boolean } = {}) {
  const p = await makePerson(k, tag);
  const credential = `napi_test_${tag}_${++cred}_NEONCREDENTIALCANARY`;
  const project = o.project === false ? undefined : `proj-${tag}${cred}`;
  if (project) k.fakes.neon.addProject(project, credential); else k.fakes.neon.setOrgCredential(credential);
  const connectionId = await connect(k, p, "neon", credential, project);
  return { p, credential, project, connectionId };
}

describe("hosting on Vercel: preview, one approval, apply equals preview", () => {
  it("the plan shows the provider's own values, flags the sensitive records, and applies exactly what it showed", async () => {
    const { p, project } = await vercelPerson("host");
    await seedZone(k, p.domain.fqdn, [{ type: "AAAA", name: "", value: "2001:db8::1" }, { type: "A", name: "", value: "192.0.2.10" }, { type: "CNAME", name: "blog", value: "blog.example.net" }]);
    const r = await plan(k, p, "hosting-vercel");
    expect(r.status, r.text).toBe(201);
    const view = r.json.plan;
    expect(view.dns.add).toEqual([{ type: "A", name: "@", value: "216.198.79.1" }, { type: "CNAME", name: "www", value: expect.stringMatching(/\.vercel-dns-017\.com$/) }]);
    expect(view.dns.remove.map((x: { type: string }) => x.type).sort()).toEqual(["A", "AAAA"]);
    expect(view.needs_approval).toBe(true);
    expect(view.sensitive.map((s: { type: string; name: string }) => `${s.type} ${s.name}`).sort()).toEqual(["A @", "AAAA @", "CNAME www"]);
    // Without the approval nothing happens.
    const refused = await applyReq(k, p, "hosting-vercel", r.json.application_id, view.plan_hash);
    expect(refused.status).toBe(403); expect(refused.json.error.code).toBe("approval_required");
    expect((await appRow(k, r.json.application_id)).state).toBe("planned");
    const { summary } = await approvePlan(k, p, r.json.application_id);
    for (const s of ["A @", "AAAA @", "CNAME www"]) expect(summary).toContain(s);
    expect(summary).toContain(view.plan_hash.slice(0, 12));
    const ok = await applyReq(k, p, "hosting-vercel", r.json.application_id, view.plan_hash);
    expect(ok.status, ok.text).toBe(202);
    await tick(k);
    const row = await appRow(k, r.json.application_id);
    expect(row.state, row.failure_code).toBe("applied");
    const z = await zone(k, p.domain.fqdn);
    expect(z.filter((x) => x.name === "" && (x.type === "A" || x.type === "AAAA"))).toEqual([{ type: "A", name: "", value: "216.198.79.1" }]);
    expect(z.find((x) => x.name === "blog")).toBeTruthy();
    expect(z.find((x) => x.name === "www")!.value).toBe(view.dns.add[1].value);
    expect(row.applied_records).toEqual(row.plan.dns.add);
    expect([...k.fakes.vercel.projects.get(project)!.domains].sort()).toEqual([p.domain.fqdn, `www.${p.domain.fqdn}`]);
    // A used plan cannot be applied again.
    expect((await applyReq(k, p, "hosting-vercel", r.json.application_id, view.plan_hash)).status).toBe(409);
  });
});

describe("ST-129: one approval per human-started plan with a sensitive record, and nothing hides", () => {
  it("the approval lists every sensitive record among benign ones, including removals, and binds the plan hash", async () => {
    const { p } = await vercelPerson("st129");
    await seedZone(k, p.domain.fqdn, [
      { type: "TXT", name: "www", value: "google-site-verification=abc" }, { type: "CNAME", name: "docs", value: "docs.example.net" },
      { type: "A", name: "api", value: "192.0.2.5" }, { type: "TXT", name: "notes", value: "hello" },
    ]);
    const r = await plan(k, p, "hosting-vercel");
    const sens = r.json.plan.sensitive.map((s: { type: string; name: string }) => `${s.type} ${s.name}`).sort();
    expect(sens).toEqual(["A @", "CNAME www", "TXT www"]);
    const prep = await prepare(k.app, p.user, { type: "dns.sensitive.approve", target_id: r.json.application_id, user_input: {} });
    expect(prep.json.summary).toContain("Sensitive records (3): ");
    for (const s of sens) expect(prep.json.summary).toContain(s);
    // A second plan for the same change is a different application: the first approval does not cover it.
    await approvePlan(k, p, r.json.application_id);
    const r2 = await plan(k, p, "hosting-vercel");
    expect(r2.json.plan.plan_hash).toBe(r.json.plan.plan_hash);
    expect((await applyReq(k, p, "hosting-vercel", r2.json.application_id, r2.json.plan.plan_hash)).status).toBe(403);
    // An approval id sent to another application's approve route is refused.
    const p3 = await prepare(k.app, p.user, { type: "dns.sensitive.approve", target_id: r2.json.application_id, user_input: {} });
    expect(p3.status).toBe(200);
    const cross = await web(k, p, "POST", `/api/v1/recipe-applications/${r.json.application_id}/approve`, {}, { [ACTION_HEADER]: p3.json.action_id });
    expect(cross.status).toBe(403);
    // The zone moves after the approval: the approved plan no longer matches and nothing is applied.
    await seedZone(k, p.domain.fqdn, [...await zone(k, p.domain.fqdn), { type: "TXT", name: "later", value: "x" }]);
    const stale = await applyReq(k, p, "hosting-vercel", r.json.application_id, r.json.plan.plan_hash);
    expect(stale.status).toBe(409); expect(stale.json.error.code).toBe("plan_changed");
    expect((await zone(k, p.domain.fqdn)).some((x) => x.name === "" && x.type === "A")).toBe(false);
  });

  it("a plan with no sensitive record and no resource step needs no approval (Neon variables only)", async () => {
    const { p } = await neonPerson("st129n");
    const r = await plan(k, p, "postgres-neon");
    expect(r.json.plan.needs_approval).toBe(false);
    expect((await applyReq(k, p, "postgres-neon", r.json.application_id, r.json.plan.plan_hash)).status).toBe(202);
    await tick(k);
    expect((await appRow(k, r.json.application_id)).state).toBe("applied");
    expect(await secretOf(p, "dev", "DATABASE_URL")).toMatch(/^postgresql:\/\/.*-pooler\..*sslmode=require$/);
    expect(await secretOf(p, "dev", "DATABASE_URL_UNPOOLED")).not.toContain("-pooler");
  });
});

describe("ST-86: billable or unknown-cost steps need the plan-hash approval for every principal; applied equals previewed", () => {
  it("a Neon project creation (unknown cost) fails without approval for a session, a CLI token and an agent token", async () => {
    const { p } = await neonPerson("st86", { project: false });
    const scopes = [{ capability: "recipes.apply", domain_id: p.domain.id, env: "dev" }, { capability: "secrets.write", domain_id: p.domain.id, env: "dev" }];
    const cliTok = await makeBinding(k, p, scopes, "cli"), agentTok = await makeBinding(k, p, scopes, "agent");
    const r = await plan(k, p, "postgres-neon", { create_project: true });
    expect(r.json.plan.needs_approval).toBe(true);
    expect(r.json.plan.steps).toContainEqual({ service: "neon", op: "project.create", target: p.domain.fqdn, creates_resource: true, cost: "unknown" });
    for (const [label, call] of [
      ["session", () => applyReq(k, p, "postgres-neon", r.json.application_id, r.json.plan.plan_hash)],
      ["cli", () => bearer(k, cliTok.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash })],
      ["agent", () => bearer(k, agentTok.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash })],
    ] as const) {
      const res = await call();
      expect(res.status, label).toBe(403); expect(res.json.error.code, label).toBe("approval_required");
    }
    expect(k.fakes.neon.created.length).toBe(0);
    // A bearer-started plan waits for the same human approval.
    const byCli = await bearer(k, cliTok.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, { input: { create_project: true } });
    expect(byCli.status, byCli.text).toBe(201);
    expect((await appRow(k, byCli.json.application_id)).created_by_kind).toBe("cli");
    await approvePlan(k, p, byCli.json.application_id);
    const go = await bearer(k, cliTok.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: byCli.json.application_id, plan_hash: byCli.json.plan.plan_hash });
    expect(go.status, go.text).toBe(202);
    await tick(k);
    expect((await appRow(k, byCli.json.application_id)).state).toBe("applied");
    expect(k.fakes.neon.created.length).toBe(1);
    expect(await secretOf(p, "dev", "DATABASE_URL")).toContain(k.fakes.neon.projects.get(k.fakes.neon.created[0]!)!.project.poolerHost);
  });

  it("a plan whose inputs change between the apply request and the job fails in the job and applies nothing", async () => {
    const { p, project } = await vercelPerson("st86z");
    const r = await plan(k, p, "hosting-vercel");
    await approvePlan(k, p, r.json.application_id);
    expect((await applyReq(k, p, "hosting-vercel", r.json.application_id, r.json.plan.plan_hash)).status).toBe(202);
    await seedZone(k, p.domain.fqdn, [{ type: "TXT", name: "sneaky", value: "changed-in-between" }]);
    await tick(k);
    const row = await appRow(k, r.json.application_id);
    expect(row.state).toBe("failed"); expect(row.failure_code).toBe("plan_changed");
    expect(k.fakes.vercel.projects.get(project)!.domains.size).toBe(0);
    expect((await zone(k, p.domain.fqdn)).map((x) => x.name)).toEqual(["sneaky"]);
  });

  it("review: the plan binds the Neon project, so moving the connection to a new project voids an older plan", async () => {
    const { p, credential, project } = await neonPerson("st86proj");
    k.fakes.neon.setOrgCredential(credential);
    const a = await plan(k, p, "postgres-neon", { envs: ["prod"] });
    expect(a.status, a.text).toBe(201);
    expect(a.json.plan.needs_approval).toBe(false);
    const b = await plan(k, p, "postgres-neon", { envs: ["dev"], create_project: true });
    const { summary } = await approvePlan(k, p, b.json.application_id);
    expect((await applyReq(k, p, "postgres-neon", b.json.application_id, b.json.plan.plan_hash)).status).toBe(202);
    await tick(k);
    expect((await appRow(k, b.json.application_id)).state).toBe("applied");
    const stale = await applyReq(k, p, "postgres-neon", a.json.application_id, a.json.plan.plan_hash);
    expect(stale.status).toBe(409); expect(stale.json.error.code).toBe("plan_changed");
    await tick(k);
    expect(await secretOf(p, "prod", "DATABASE_URL")).toBeUndefined();
    // The approval names the project the connection is moved away from.
    expect(summary).toContain(project!);
  });

  it("ST-35: an agent's recipe that writes prod emails every address at once", async () => {
    const { p } = await neonPerson("st35rec");
    const agent = await makeBinding(k, p, [{ capability: "recipes.apply", domain_id: p.domain.id, env: "prod" }, { capability: "secrets.write", domain_id: p.domain.id, env: "prod" }], "agent");
    const r = await bearer(k, agent.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, { input: { envs: ["prod"] } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.plan.needs_approval).toBe(false);
    k.app.email.clear();
    const go = await bearer(k, agent.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash });
    expect(go.status, go.text).toBe(202);
    await tick(k);
    expect((await appRow(k, r.json.application_id)).state).toBe("applied");
    const mails = k.app.email.sent.filter((m) => m.kind === "agent.prod_write");
    expect(mails.map((m) => m.text.match(/wrote (\S+) \(prod\)/)?.[1]).sort()).toEqual(["DATABASE_URL", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL_UNPOOLED"]);
    expect(JSON.stringify(mails)).not.toContain("postgresql://");
    // A plan a person applies from the app sends no agent notice.
    const own = await plan(k, p, "postgres-neon", { envs: ["prod"] });
    k.app.email.clear();
    await applyReq(k, p, "postgres-neon", own.json.application_id, own.json.plan.plan_hash);
    await tick(k);
    expect(k.app.email.sent.filter((m) => m.kind === "agent.prod_write")).toEqual([]);
  });

  it("the plan hash sent must be the stored one", async () => {
    const { p } = await neonPerson("st86h");
    const r = await plan(k, p, "postgres-neon");
    expect((await applyReq(k, p, "postgres-neon", r.json.application_id, "0".repeat(64))).status).toBe(409);
  });
});

describe("ST-85: recipes.apply alone writes nothing; a dev token cannot target Vercel production or preview", () => {
  it("a token holding only recipes.apply gets 403 for DNS and for variables, and nothing is queued", async () => {
    const { p } = await vercelPerson("st85");
    await k.fakes.neon.addProject(`proj-st85-${cred}`, `neon-st85-${cred}`);
    await connect(k, p, "neon", `neon-st85-${cred}`, `proj-st85-${cred}`);
    const only = await makeBinding(k, p, [{ capability: "recipes.apply", domain_id: p.domain.id, env: "dev" }], "agent");
    for (const recipe of ["postgres-neon", "hosting-vercel"]) {
      const r = await bearer(k, only.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/${recipe}/plan`, { input: {} });
      expect(r.status, r.text).toBe(201);
      if (recipe === "hosting-vercel") await approvePlan(k, p, r.json.application_id);
      const a = await bearer(k, only.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/${recipe}/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash });
      expect(a.status, recipe).toBe(403); expect(a.json.error.code).toBe("scope_missing");
      expect(["planned", "approved"]).toContain((await appRow(k, r.json.application_id)).state);
    }
    expect((await k.app.db.owner.query("select count(*)::int n from jobs where kind = 'recipe.apply' and user_id = $1", [p.user.userId])).rows[0].n).toBe(0);
  });

  it("a dev token whose Neon plan writes Vercel production or preview is denied; development is allowed", async () => {
    const { p } = await vercelPerson("st85v");
    await k.fakes.neon.addProject(`proj-st85v-${cred}`, `neon-st85v-${cred}`);
    await connect(k, p, "neon", `neon-st85v-${cred}`, `proj-st85v-${cred}`);
    const dev = await makeBinding(k, p, [{ capability: "recipes.apply", domain_id: p.domain.id, env: "dev" }, { capability: "secrets.write", domain_id: p.domain.id, env: "dev" }], "cli");
    for (const [target, status] of [["production", 403], ["preview", 403], ["development", 202]] as const) {
      const r = await bearer(k, dev.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, { input: { envs: ["dev"], vercel_targets: [target] } });
      expect(r.status, r.text).toBe(201);
      const a = await bearer(k, dev.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash });
      expect(a.status, target).toBe(status);
    }
    await tick(k);
    const envs = [...k.fakes.vercel.projects.values()].flatMap((x) => [...x.env.values()].map((e) => e.target.join(",")));
    expect(envs).not.toContain("production"); expect(envs).not.toContain("preview");
  });

  it("a token without recipes.plan or recipes.apply cannot plan, and a cookie cannot use another user's plan", async () => {
    const { p } = await neonPerson("st85p");
    const none = await makeBinding(k, p, [{ capability: "secrets.read", domain_id: p.domain.id, env: "dev" }], "cli");
    expect((await bearer(k, none.token, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, { input: {} })).status).toBe(403);
    const q = await neonPerson("st85q");
    const r = await plan(k, q.p, "postgres-neon");
    expect((await web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash })).status).toBe(404);
    expect((await web(k, p, "GET", `/api/v1/recipe-applications/${r.json.application_id}`)).status).toBe(404);
  });
});

describe("ST-88: reserved and malformed variable names on recipe apply", () => {
  it("a prefix that makes a reserved or malformed name is refused with 422 and an audit row, in any case", async () => {
    const { p } = await neonPerson("st88r");
    const before = (await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action = 'secret.name_rejected'", [p.user.userId])).rows[0].n;
    const bad = ["LD_", "ld_", "Ld_", "DYLD_", "dyld_", "BASH_FUNC_", "npm_config_", "Git_Config_", "AWS_", "vercel_", "MOSSHATCH_", "1X_", "A-B_", "a b "];
    for (const prefix of bad) {
      const r = await plan(k, p, "postgres-neon", { prefix });
      expect(r.status, prefix).toBe(422); expect(r.json.error.code).toBe("invalid_name");
      expect(r.text).not.toContain(prefix);
    }
    const after = (await k.app.db.owner.query("select count(*)::int n from audit_log where chain_id = $1 and action = 'secret.name_rejected'", [p.user.userId])).rows[0].n;
    expect(after - before).toBe(bad.length);
    expect((await plan(k, p, "postgres-neon", { prefix: "PRIMARY_" })).status).toBe(201);
    expect((await k.app.db.owner.query("select count(*)::int n from recipe_applications where user_id = $1", [p.user.userId])).rows[0].n).toBe(1);
  });
});

describe("email with Resend: provider-created records are pending, then exact", () => {
  it("creates the domain and a send-only key under one approval, then writes the exact records under a second plan", async () => {
    const p = await makePerson(k, "mail");
    const credential = `re_test_mail_${++cred}_RESENDCREDENTIALCANARY`;
    k.fakes.resend.credential = credential;
    await connect(k, p, "resend", credential);
    const r1 = await plan(k, p, "email-resend", { envs: ["dev", "prod"] });
    expect(r1.status, r1.text).toBe(201);
    expect(r1.json.plan.fidelity).toBe("pending_provider_create");
    expect(r1.json.plan.dns.add).toEqual([]);
    expect(r1.json.plan.variables).toEqual([{ name: "RESEND_API_KEY", targets: ["nest:dev", "nest:prod"] }]);
    await approvePlan(k, p, r1.json.application_id);
    expect((await applyReq(k, p, "email-resend", r1.json.application_id, r1.json.plan.plan_hash)).status).toBe(202);
    await tick(k);
    expect((await appRow(k, r1.json.application_id)).state).toBe("applied");
    expect(k.fakes.resend.keys.length).toBe(1);
    expect(await secretOf(p, "dev", "RESEND_API_KEY")).toBe(k.fakes.resend.keys[0]!.token);
    const r2 = await plan(k, p, "email-resend");
    expect(r2.json.plan.fidelity).toBe("exact");
    expect(r2.json.plan.variables).toEqual([]);
    const dom = [...k.fakes.resend.domains.values()][0]!;
    expect(r2.json.plan.dns.add.length).toBe(3);
    expect(r2.json.plan.sensitive.length).toBe(3);
    await approvePlan(k, p, r2.json.application_id);
    await applyReq(k, p, "email-resend", r2.json.application_id, r2.json.plan.plan_hash);
    await tick(k);
    const z = await zone(k, p.domain.fqdn);
    for (const rec of dom.records) expect(z).toContainEqual(resendRecordToDns(p.domain.fqdn, rec));
    expect(z.find((x) => x.type === "TXT" && x.name === "send")!.value).toBe("v=spf1 include:amazonses.com ~all");
  });
});

describe("ST-87: no route, tool or command returns a stored provider credential; only recipe.apply and connection.check decrypt", () => {
  it("responses, stored rows and mail never carry the credential; every decrypt is audited with one of the two purposes", async () => {
    const { p, credential } = await vercelPerson("st87");
    const texts: string[] = [];
    for (const [m, u] of [["GET", `/api/v1/domains/${p.domain.fqdn}/connections`], ["GET", `/api/v1/domains/${p.domain.fqdn}/nest`], ["GET", "/api/v1/recipes"]] as const) texts.push((await web(k, p, m, u)).text);
    const r = await plan(k, p, "hosting-vercel");
    texts.push(r.text, (await web(k, p, "GET", `/api/v1/recipe-applications/${r.json.application_id}`)).text);
    await approvePlan(k, p, r.json.application_id);
    texts.push((await applyReq(k, p, "hosting-vercel", r.json.application_id, r.json.plan.plan_hash)).text);
    await tick(k);
    const stored = (await Promise.all(["connections", "recipe_applications", "audit_log", "jobs", "alerts", "email_log", "actions", "dns_snapshots"].map(async (t) => JSON.stringify((await k.app.db.owner.query(`select * from ${t}`)).rows)))).join("\n");
    const hay = [...texts, stored, JSON.stringify(k.app.email.sent)].join("\n");
    expect(hay).not.toContain(credential); expect(hay).not.toContain("VERCELCREDENTIALCANARY");
    const purposes = (await k.app.db.owner.query("select distinct detail->>'purpose' as p from audit_log where action = 'connection.credential.used'")).rows.map((x) => x.p).sort();
    expect(purposes).toEqual(["connection.check", "recipe.apply"]);
  });

  it("source scan: the decrypt function is called only from the vault and the two recipe jobs, and no route selects credential ciphertext", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const q = path.join(d, f); if (statSync(q).isDirectory()) walk(q); else if (/\.ts$/.test(f) && !/\.test\.ts$|testkit\.ts$/.test(f)) files.push(q); } };
    walk(root);
    const callers = files.filter((f) => /withConnectionCredential\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f)).sort();
    expect(callers).toEqual(["recipes/apply.ts"]);
    expect(readFileSync(path.join(root, "vault/connections.ts"), "utf8")).toMatch(/export async function withConnectionCredential</);
    const purposes = [...readFileSync(path.join(root, "recipes/apply.ts"), "utf8").matchAll(/withCred\([^,]+,[^,]+,\s*"([a-z.]+)"/g)].map((m) => m[1]);
    expect(new Set(purposes)).toEqual(new Set(["recipe.apply", "connection.check"]));
    const readers = files.filter((f) => /from connection_credentials/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f)).sort();
    for (const f of readers) expect(["recipes/apply.ts", "vault/connections.ts", "vault/drill.ts", "vault/jobs.ts", "ops/erasure.ts"]).toContain(f);
    expect(readFileSync(path.join(root, "recipes/apply.ts"), "utf8")).toMatch(/select id from connection_credentials/);
  });
});

describe("ST-130: dangling targets are flagged in one scan, and disconnecting removes the recipe's records", () => {
  it("a wired host answering with the provider's not-found page opens a finding at the next check; a fixed host resolves it", async () => {
    const { p, connectionId } = await vercelPerson("st130");
    const r = await plan(k, p, "hosting-vercel");
    await approvePlan(k, p, r.json.application_id);
    await applyReq(k, p, "hosting-vercel", r.json.application_id, r.json.plan.plan_hash);
    await tick(k);
    k.fakes.probe.gone.add(`www.${p.domain.fqdn}`);
    await web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/connections/vercel/check`);
    await tick(k);
    const list = await web(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/connections`);
    expect(list.json.findings).toEqual([expect.objectContaining({ kind: "dangling_target", host: `www.${p.domain.fqdn}` })]);
    expect((await k.app.db.owner.query("select count(*)::int n from alerts where kind = 'recipe.dangling_target'")).rows[0].n).toBeGreaterThan(0);
    // The recurring scan queues a check of every wired connection without anyone asking.
    k.fakes.probe.gone.add(p.domain.fqdn);
    const { connectionScanJob } = await import("./apply.ts");
    await connectionScanJob(k.app.ctx, { id: "x", kind: "connection.scan", attempt_id: "x", attempts: 0, max_attempts: 1, payload: {}, user_id: null });
    await tick(k);
    expect((await web(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/connections`)).json.findings.map((f: { host: string }) => f.host).sort()).toEqual([p.domain.fqdn, `www.${p.domain.fqdn}`].sort());
    k.fakes.probe.gone.clear();
    await web(k, p, "POST", `/api/v1/domains/${p.domain.fqdn}/connections/vercel/check`);
    await tick(k);
    expect((await web(k, p, "GET", `/api/v1/domains/${p.domain.fqdn}/connections`)).json.findings).toEqual([]);
    // Disconnect: the records the recipe wrote are deleted, others stay, and the credential is destroyed.
    await seedZone(k, p.domain.fqdn, [...await zone(k, p.domain.fqdn), { type: "TXT", name: "keep", value: "mine" }]);
    const del = await web(k, p, "DELETE", `/api/v1/connections/${connectionId}`);
    expect(del.status, del.text).toBe(200); expect(del.json.records_removed).toBe(2);
    const z = await zone(k, p.domain.fqdn);
    expect(z).toEqual([{ type: "TXT", name: "keep", value: "mine" }]);
    const c = (await k.app.db.owner.query("select ciphertext, wrapped_dek, revoked_at from connection_credentials k join connections n on n.id = k.connection_id where n.id = $1", [connectionId])).rows[0];
    expect(c.ciphertext).toBeNull(); expect(c.wrapped_dek).toBeNull(); expect(c.revoked_at).not.toBeNull();
    expect((await appRow(k, r.json.application_id)).state).toBe("removed");
    expect((await web(k, p, "DELETE", `/api/v1/connections/${connectionId}`)).status).toBe(404);
  });
});
