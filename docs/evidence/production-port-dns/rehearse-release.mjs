import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// LOCAL ONLY. No env fallback, remote hosts, credentials, existing DB mutation, or repo writes.
const repo = '/workspace/MossHatch-production-port';
const baseUrl = process.env.TEST_DATABASE_URL;
assert.equal(baseUrl, 'postgres://postgres@127.0.0.1:54329/postgres', 'Only explicitly authorized loopback database allowed');
const require = createRequire(path.join(repo, 'package.json'));
const { Pool } = require('pg');
const { migrate } = await import(pathToFileURL(path.join(repo, 'packages/db/src/migrate.ts')));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceHead='3280902987932ecc89f2ddf416fcc531053bf501';
assert.deepEqual(fs.readFileSync(path.join(repo,'packages/db/src/migrate.ts')),execFileSync('git',['show',`${sourceHead}:packages/db/src/migrate.ts`],{cwd:repo}), 'The rehearsed migration runner changed');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const names = ['0998_nameserver_proposals.sql', '1130_dns_reconciliation.sql'];
const pins = ['1856d191e54cfd8cfcf3483be607dd2c80706c73c510e3d910c115faea573a92', '2ec9c61122ff2e32819c26e4690b3c979800631814e8a721aa88a8f0db799b80'];
const temp = fs.mkdtempSync('/tmp/mosshatch-migration-rehearsal-');
const baselineDir = path.join(temp, 'main-baseline');
const pinnedDir = path.join(temp, 'pinned-two');
fs.mkdirSync(baselineDir); fs.mkdirSync(pinnedDir);
const baselineNames = execFileSync('git', ['ls-tree', '-r', '--name-only', 'e311dae', '--', 'packages/db/migrations'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').map(p => path.basename(p)).sort();
assert.equal(baselineNames.length, 38);
for (const name of baselineNames) {
  const original = execFileSync('git', ['show', `e311dae:packages/db/migrations/${name}`], { cwd: repo });
  assert.deepEqual(fs.readFileSync(path.join(repo, 'packages/db/migrations', name)), original);
  fs.writeFileSync(path.join(baselineDir, name), original);
}
const sql = names.map((name, i) => {
  const original = fs.readFileSync(path.join(repo, 'packages/db/migrations', name), 'utf8');
  assert.equal(sha(original), pins[i]); fs.writeFileSync(path.join(pinnedDir, name), original); return original;
});
const admin = new Pool({ connectionString: baseUrl, max: 1 });
const owned = [];
const pools = [];
let passed = 0;
const pass = (label, detail = {}) => { passed++; console.log(JSON.stringify({ check: passed, result: 'PASS', label, ...detail })); };
const literal = text => `'${text.replaceAll("'", "''")}'`;
const catalogueSql = `select jsonb_build_object(
  'tables', (select jsonb_agg(to_jsonb(t) order by t.relname) from (select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('agent_requests','dns_snapshots') and c.relkind='r') t),
  'columns', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.ordinal_position) from (select table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('agent_requests','dns_snapshots')) t),
  'constraints', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select c.conrelid::regclass::text as table_name,c.conname as name,c.contype::text as type,c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'indexes', (select jsonb_agg(to_jsonb(t) order by t.table_name,t.name) from (select i.indrelid::regclass::text as table_name,i.indexrelid::regclass::text as name,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) as definition from pg_index i where i.indrelid in ('public.agent_requests'::regclass,'public.dns_snapshots'::regclass)) t),
  'policies', (select jsonb_agg(to_jsonb(t) order by t.tablename,t.policyname) from (select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('agent_requests','dns_snapshots')) t)
) as catalogue`;
const catalogue = async c => (await c.query(catalogueSql)).rows[0].catalogue;
const ledger = async c => (await c.query('select name, applied_at from schema_migrations order by name')).rows;
const oldColumns = ['id','user_id','domain_id','reason','zone_hash','records','after_hash','added_count','removed_count','sensitive_count','actor_kind','rolled_back_at','taken_at','expires_at','write_state','intended_hash'];
const receipts = async c => (await c.query(`select ${oldColumns.join(',')} from dns_snapshots order by id`)).rows;
const newColumns = ['state_format','intended_records','agent_request_id','observed_hash','observed_at','reconciliation_state'];
async function fresh(label) {
  const name = `mh_migrehearsal_${label}_${crypto.randomBytes(6).toString('hex')}`;
  assert.match(name, /^mh_migrehearsal_[a-z0-9_]+$/);
  await admin.query(`create database "${name}"`); owned.push(name);
  const url = new URL(baseUrl); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href, max: 4 }); pools.push(pool);
  assert.deepEqual(await migrate(pool, baselineDir), baselineNames);
  const userId = (await pool.query("insert into users(email,status) values('migration-fixture@example.invalid','active') returning id")).rows[0].id;
  const domainId = (await pool.query("insert into domains(user_id,fqdn_ascii,tld,registrar,livemode) values($1,'migration-fixture.example','example','mock',false) returning id", [userId])).rows[0].id;
  const bindingId = (await pool.query("insert into bindings(user_id,kind,name,token_prefix,token_hash,expires_at) values($1,'agent','Migration fixture','fixture',decode($2,'hex'),now()+interval '1 hour') returning id", [userId, sha(name)])).rows[0].id;
  for (let i = 0; i < 8; i++) {
    const records = [{type:'A',name:`host${i}`,value:`192.0.2.${i+1}`,ttl:i === 0 ? 0 : 60+i}, {type:'CAA',name:'@',value:'0 issue "ca.example"',ttl:3600}, {type:'TYPE65280',name:`opaque${i}`,value:'\\# 4 01020304 | : ,',ttl:7200}];
    await pool.query("insert into dns_snapshots(user_id,domain_id,reason,zone_hash,records,after_hash,intended_hash,expires_at,write_state) values($1,$2,'pre_write',$3,$4,$5,$5,now()+interval '30 days','applied')", [userId, domainId, sha(`before-${i}`), JSON.stringify(records), sha(`after-${i}`)]);
  }
  return { pool, userId, domainId, bindingId };
}
async function rejectCode(c, statement, values, code) {
  await assert.rejects(c.query(statement, values), e => e.code === code);
}
async function tx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('begin'); await fn(c); await c.query('rollback'); }
  catch(e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}
async function checkPreserved(k, before) { assert.deepEqual(await receipts(k.pool), before); }

try {
  const roles = (await admin.query("select rolname from pg_roles where rolname=any($1) order by rolname", [['mh_runtime','mh_cron','mh_contacts','mh_vault']])).rows.map(r => r.rolname);
  assert.equal(roles.length, 4, 'Do not create shared roles in this rehearsal');
  pass('Only loopback PostgreSQL and unique owned databases; existing shared roles preserved', { head, baseline_migrations: baselineNames.length, pinned_files: Object.fromEntries(names.map((n,i)=>[n,pins[i]])) });

  const clean = await fresh('clean');
  const before = await receipts(clean.pool);
  const beforeLedger = await ledger(clean.pool);
  const beforeCat = await catalogue(clean.pool);
  const aclBefore=(await clean.pool.query("select relname,relacl::text[] from pg_class where oid in ('agent_requests'::regclass,'dns_snapshots'::regclass) order by relname")).rows;
  assert.equal((await clean.pool.query("select count(*)::int n from dns_snapshots where write_state in ('pending','unknown')")).rows[0].n, 0);
  assert.deepEqual(await migrate(clean.pool, pinnedDir), names);
  await checkPreserved(clean, before);
  const afterCat = await catalogue(clean.pool);
  const afterLedger = await ledger(clean.pool);
  assert.deepEqual(afterLedger.filter(r=>!names.includes(r.name)), beforeLedger);
  assert.equal(afterLedger.length, 40);
  assert.deepEqual((await clean.pool.query("select relname,relacl::text[] from pg_class where oid in ('agent_requests'::regclass,'dns_snapshots'::regclass) order by relname")).rows,aclBefore);
  assert.deepEqual(afterCat.tables, beforeCat.tables); assert.deepEqual(afterCat.policies, beforeCat.policies);
  pass('Exact two-file runner application preserves all eight original rows, RR data, TTL, hashes, original ledger timestamps, RLS/policies and table ACLs', { original_rows_sha256:sha(JSON.stringify(before)), rows:before.length });
  const added = (await clean.pool.query(`select ${newColumns.join(',')} from dns_snapshots`)).rows;
  for (const row of added) assert.deepEqual(row, {state_format:null,intended_records:null,agent_request_id:null,observed_hash:null,observed_at:null,reconciliation_state:'unresolved'});
  assert.deepEqual(await migrate(clean.pool,pinnedDir), []); assert.deepEqual(await ledger(clean.pool), afterLedger);
  pass('Legacy state_format remains NULL; five nullable fields stay NULL; reconciliation defaults unresolved; second run skips both without timestamp changes');

  for (const kind of ['register','renew','dns_change','scope','nameservers_change']) await tx(clean.pool, async c => {
    const id = (await c.query("insert into agent_requests(user_id,binding_id,kind,request_hash,params,created_at,expires_at) values($1,$2,$3,$4,'{}',now(),now()+interval '1 hour') returning id", [clean.userId,clean.bindingId,kind,crypto.randomBytes(32)])).rows[0].id;
    await c.query("update dns_snapshots set agent_request_id=$1,state_format='complete-v1',reconciliation_state='desired_observed' where id=$2", [id,before[0].id]);
  });
  await rejectCode(clean.pool,"insert into agent_requests(user_id,binding_id,kind,request_hash,params,created_at,expires_at) values($1,$2,'unapproved_kind',$3,'{}',now(),now()+interval '1 hour')",[clean.userId,clean.bindingId,crypto.randomBytes(32)],'23514');
  await rejectCode(clean.pool,"update dns_snapshots set state_format='legacy-authority' where id=$1",[before[0].id],'23514');
  await rejectCode(clean.pool,"update dns_snapshots set reconciliation_state='success' where id=$1",[before[0].id],'23514');
  await rejectCode(clean.pool,"update dns_snapshots set reconciliation_state=null where id=$1",[before[0].id],'23502');
  await rejectCode(clean.pool,"update dns_snapshots set agent_request_id=$1 where id=$2",[crypto.randomUUID(),before[0].id],'23503');
  await tx(clean.pool,async c=>{for(const state of ['unresolved','desired_observed','before_observed','partial_observed'])await c.query('update dns_snapshots set reconciliation_state=$1 where id=$2',[state,before[0].id]);});
  await checkPreserved(clean,before);
  pass('Kind allow-list, state-format/reconciliation checks, NOT NULL and real agent-request FK enforced; rolled-back fixture changes preserve eight rows');
  const unresolvedIndex=afterCat.indexes.find(i=>i.name==='dns_snapshots_unresolved');
  assert.ok(unresolvedIndex.indisvalid && unresolvedIndex.indisready); assert.match(unresolvedIndex.definition,/pending.*unknown/);
  pass('Valid partial index covers pending/unknown receipts only', { index:unresolvedIndex.definition });

  const failure=await fresh('failure'); const failBefore=await receipts(failure.pool);
  await failure.pool.query('create table migration_index_collision(id uuid); create index dns_snapshots_unresolved on migration_index_collision(id)');
  await assert.rejects(migrate(failure.pool,pinnedDir), /migration 1130_dns_reconciliation.sql failed: relation "dns_snapshots_unresolved" already exists/);
  assert.deepEqual((await ledger(failure.pool)).filter(r=>names.includes(r.name)).map(r=>r.name),[names[0]]);
  assert.equal((await failure.pool.query('select count(*)::int n from information_schema.columns where table_schema=\'public\' and table_name=\'dns_snapshots\' and column_name=any($1)',[newColumns])).rows[0].n,0);
  await checkPreserved(failure,failBefore);
  const middleCat=await catalogue(failure.pool);
  await failure.pool.query('drop table migration_index_collision');
  assert.deepEqual(await migrate(failure.pool,pinnedDir),[names[1]]); await checkPreserved(failure,failBefore);
  pass('Failure late in 1130 rolls back its entire DDL and ledger row; 0998 stays durable; reviewed repair then retry applies only 1130');

  // Connector artifact: one transaction supplied by the caller. No persistent helper function,
  // secret URI, new dependency, generalized migration runner change, or raw migration substitution.
  // The exact catalogues are from pinned main and successfully rehearsed exact files on PG16.
  const catalogues=[beforeCat,middleCat,afterCat];
  const catalogueHashes=[];
  for(const expected of catalogues) catalogueHashes.push((await clean.pool.query("select encode(digest($1::jsonb::text,'sha256'),'hex') value",[JSON.stringify(expected)])).rows[0].value);
  const aclSql="select jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text[]) order by relname) from pg_class where oid in ('agent_requests'::regclass,'dns_snapshots'::regclass)";
  const ledgerSets=[baselineNames,[...baselineNames,names[0]].sort(),[...baselineNames,...names].sort()];
  const wrapper=`-- REVIEW ARTIFACT ONLY. Execute as ONE transaction after explicit owner approval.\n-- Source ${sourceHead}; original-file SHA256 pins:\n${names.map((n,i)=>`-- ${n}: ${pins[i]}`).join('\n')}\nset local lock_timeout = '1s';\nset local statement_timeout = '30s';\nset local search_path = pg_catalog, public, pg_temp;\ndo $release$\ndeclare v_names text[]; v_catalogue jsonb; v_phase integer; v_acl_before jsonb; v_acl_after jsonb;\nbegin\n  if not pg_try_advisory_xact_lock(727001) then raise exception 'release_migration_lock_busy'; end if;\n  select array_agg(name order by name) into v_names from schema_migrations;\n  if v_names = array[${ledgerSets[0].map(literal).join(',')}]::text[] then v_phase := 0;\n  elsif v_names = array[${ledgerSets[1].map(literal).join(',')}]::text[] then v_phase := 1;\n  elsif v_names = array[${ledgerSets[2].map(literal).join(',')}]::text[] then v_phase := 2;\n  else raise exception 'release_migration_ledger_drift'; end if;\n  select catalogue into v_catalogue from (${catalogueSql}) as checked;\n  if encode(digest(v_catalogue::text,'sha256'),'hex') is distinct from (case v_phase ${catalogueHashes.map((h,i)=>`when ${i} then ${literal(h)}`).join(' ')} end) then raise exception 'release_migration_catalogue_drift'; end if;\n  select * into v_acl_before from (${aclSql}) as before_acl;\n  if v_phase = 0 then\n    execute ${literal(sql[0])};\n    insert into schema_migrations(name) values (${literal(names[0])});\n  end if;\n  if v_phase < 2 then\n    execute ${literal(sql[1])};\n    insert into schema_migrations(name) values (${literal(names[1])});\n  end if;\n  select catalogue into v_catalogue from (${catalogueSql}) as checked;\n  if encode(digest(v_catalogue::text,'sha256'),'hex') is distinct from ${literal(catalogueHashes[2])} then raise exception 'release_migration_postcheck_failed'; end if;\n  select * into v_acl_after from (${aclSql}) as after_acl;\n  if v_acl_after is distinct from v_acl_before then raise exception 'release_migration_acl_changed'; end if;\nend $release$;\nselect name, applied_at from schema_migrations where name in (${names.map(literal).join(',')}) order by name;\n`;
  const wrapperPath=path.join(temp,'connector-two-migrations.REVIEW.sql'); fs.writeFileSync(wrapperPath,wrapper);
  fs.writeFileSync(path.join(temp,'catalogue-preflight.READONLY.sql'),`select encode(digest(catalogue::text,'sha256'),'hex') catalogue_sha256 from (${catalogueSql}) as checked;\n`);
  fs.writeFileSync(path.join(temp,'catalogue-hashes.json'),JSON.stringify({baseline:catalogueHashes[0],after0998:catalogueHashes[1],complete:catalogueHashes[2]},null,2));
  fs.writeFileSync(path.join(temp,'catalogues.json'),JSON.stringify({baseline:beforeCat,after0998:middleCat,complete:afterCat},null,2));
  const executeWrapper=async pool=>{const c=await pool.connect();try{await c.query('begin');await c.query(wrapper);await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
  const wrapped=await fresh('wrapper');const wrappedBefore=await receipts(wrapped.pool);
  await executeWrapper(wrapped.pool);await checkPreserved(wrapped,wrappedBefore);
  const wrappedLedger=await ledger(wrapped.pool);await executeWrapper(wrapped.pool);assert.deepEqual(await ledger(wrapped.pool),wrappedLedger);
  pass('Connector single-transaction wrapper applies exact original SQL and exact ledger names, validates catalog, and safely skips a verified rerun', { wrapper:wrapperPath, wrapper_sha256:sha(wrapper) });

  const drift=await fresh('drift');const driftBefore=await receipts(drift.pool);
  await drift.pool.query('alter table dns_snapshots add column state_format integer');
  await assert.rejects(executeWrapper(drift.pool),/release_migration_catalogue_drift/);
  assert.equal((await ledger(drift.pool)).length,38);await checkPreserved(drift,driftBefore);
  await drift.pool.query('alter table dns_snapshots drop column state_format');
  await drift.pool.query('insert into schema_migrations(name) values($1),($2)',names);
  await assert.rejects(executeWrapper(drift.pool),/release_migration_catalogue_drift/);
  await drift.pool.query('delete from schema_migrations where name=any($1)',[names]);
  await drift.pool.query("insert into schema_migrations(name) values('9999_unapproved.sql')");
  await assert.rejects(executeWrapper(drift.pool),/release_migration_ledger_drift/);
  await drift.pool.query("delete from schema_migrations where name='9999_unapproved.sql'");
  pass('Wrapper rejects unledgered columns, falsely claimed completed migrations, and unexpected ledger names before writes');

  const locked=await drift.pool.connect();
  try {await locked.query('select pg_advisory_lock(727001)');await assert.rejects(executeWrapper(drift.pool),/release_migration_lock_busy/);}
  finally{await locked.query('select pg_advisory_unlock(727001)');locked.release();}
  assert.equal((await ledger(drift.pool)).length,38);
  pass('Connector transaction lock conflicts with existing runner session advisory lock and aborts without waiting or applying either file');

  // A same-name index on another table is not in the two-table manifest; the exact DDL still
  // refuses it. Both files and ledger writes must roll back as one connector transaction.
  const atomic=await fresh('atomic');const atomicBefore=await receipts(atomic.pool);
  await atomic.pool.query('create table migration_index_collision(id uuid); create index dns_snapshots_unresolved on migration_index_collision(id)');
  await assert.rejects(executeWrapper(atomic.pool),/relation "dns_snapshots_unresolved" already exists/);
  assert.equal((await ledger(atomic.pool)).length,38);assert.deepEqual(await catalogue(atomic.pool),beforeCat);await checkPreserved(atomic,atomicBefore);
  await atomic.pool.query('drop table migration_index_collision');await executeWrapper(atomic.pool);
  pass('Connector late-1130 failure rolls back BOTH migrations plus ledger; explicit retry after removing fixture collision succeeds');

  const resume=await fresh('resume');const resumeDir=path.join(temp,'only0998');fs.mkdirSync(resumeDir);fs.writeFileSync(path.join(resumeDir,names[0]),sql[0]);
  await migrate(resume.pool,resumeDir);const time0998=(await ledger(resume.pool)).find(r=>r.name===names[0]).applied_at;
  await executeWrapper(resume.pool);assert.deepEqual((await ledger(resume.pool)).find(r=>r.name===names[0]).applied_at,time0998);
  pass('Connector resumes verified runner-partial state without rerunning or retimestamping 0998');

  const concurrent=await fresh('concurrent');const results=await Promise.all([migrate(concurrent.pool,pinnedDir),migrate(concurrent.pool,pinnedDir)]);
  assert.deepEqual(results.map(r=>r.length).sort(),[0,2]);assert.equal((await ledger(concurrent.pool)).length,40);
  pass('Existing runner advisory lock serializes two concurrent exact-file applications; one applies, one skips');
  const pauseSql=fs.readFileSync(path.join(repo,'docs/runbooks/sql/secure-dns-pause.sql'),'utf8');
  const pauseNames=['agent_purchases_paused','orders_paused','registrar_writes_paused'];
  const executePause=async pool=>{const c=await pool.connect();try{await c.query('begin');await c.query(pauseSql);await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
  const flags=async pool=>(await pool.query('select name,value,updated_at,updated_by from flags order by name')).rows;
  await concurrent.pool.query("update flags set value='false'::jsonb where name=any($1)",[pauseNames]);
  const flagsBefore=await flags(concurrent.pool);
  assert.equal(flagsBefore.filter(f=>pauseNames.includes(f.name)).length,3);
  await executePause(concurrent.pool);const flagsAfter=await flags(concurrent.pool);
  assert.deepEqual(flagsAfter.filter(f=>!pauseNames.includes(f.name)),flagsBefore.filter(f=>!pauseNames.includes(f.name)));
  for(const flag of flagsAfter.filter(f=>pauseNames.includes(f.name))){assert.equal(flag.value,true);assert.equal(flag.updated_by,'secure-dns-restricted-release');}
  await executePause(concurrent.pool);assert.deepEqual(await flags(concurrent.pool),flagsAfter);
  pass('Exact pause SQL changes only three false flags to true with attribution; repeat preserves every row/timestamp', {pause_sql_sha256:sha(pauseSql)});
  await concurrent.pool.query("update flags set value='false'::jsonb where name=any($1)",[pauseNames]);
  await concurrent.pool.query("update flags set value='\"unexpected\"'::jsonb where name='orders_paused'");
  const badFlags=await flags(concurrent.pool);await assert.rejects(executePause(concurrent.pool),/release_pause_flag_drift/);assert.deepEqual(await flags(concurrent.pool),badFlags);
  await concurrent.pool.query("delete from flags where name='orders_paused'");
  const missingFlags=await flags(concurrent.pool);await assert.rejects(executePause(concurrent.pool),/release_pause_flag_drift/);assert.deepEqual(await flags(concurrent.pool),missingFlags);
  pass('Pause SQL rejects bad-value or missing flag with no partial pause or unrelated flag mutation');
  console.log(JSON.stringify({result:'ALL_CHECKS_PASSED',checks:passed,artifacts:temp,local_only:true,production_executed:false}));
} finally {
  for(const pool of pools)await pool.end();
  for(const name of owned)await admin.query(`drop database "${name}"`);
  await admin.end();
  console.log(JSON.stringify({cleanup:'Only rehearsal-owned databases removed',count:owned.length,artifacts_retained:temp}));
}
