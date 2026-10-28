-- DC-04: a connect plan is stored for one hour and applied only when its hash still matches a fresh zone read.
-- connect.apply is off until the flag is turned on. A missing flag is off.

insert into flags (name, value) values ('connect.apply', 'false'::jsonb) on conflict (name) do nothing;

alter table actions drop constraint if exists actions_type_check;
alter table actions add constraint actions_type_check check (type in (
  'secret.reveal','domain.nameservers.change','domain.unlock','domain.transfer_out','domain.contact.change','agent.purchase.approve',
  'agent.token.create','agent.token.widen','dns.sensitive.approve','device.approve','passkey.add','card.publish','mandate.sign',
  'account.close','account.export','connect.apply'));

create table connect_plans (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  source text not null check (source in ('preset','domainconnect','recipe','pasted','ai')),
  source_id text not null check (source_id ~ '^[A-Za-z0-9_./-]{1,80}$'),
  source_version integer not null check (source_version >= 1),
  intent jsonb not null,
  plan jsonb not null,
  plan_hash bytea not null check (octet_length(plan_hash) = 32),
  sensitive_count integer not null default 0,
  state text not null default 'planned' check (state in ('planned','approved','applying','applied','failed','expired','blocked')),
  prompt_hash bytea check (prompt_hash is null or octet_length(prompt_hash) = 32),
  applied_records jsonb,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z_]{1,48}$'),
  approved_by_action_id uuid,
  expires_at timestamptz not null,
  applied_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint connect_plans_intent_no_secret check (intent::text !~* '"(secret|password|authcode|auth_code|token)"\s*:')
);
create index connect_plans_domain on connect_plans (domain_id, created_at desc);
create trigger connect_plans_touch before update on connect_plans for each row execute function set_updated_at();

alter table connect_plans enable row level security;
alter table connect_plans force row level security;
create policy tenant on connect_plans using (user_id = app_user_id()) with check (user_id = app_user_id());

grant select, insert, update on connect_plans to mh_runtime;
grant all on connect_plans to mh_cron;
