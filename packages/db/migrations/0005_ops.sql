create table flags (
  name text primary key,
  value jsonb not null,
  updated_by text not null default 'migration',
  updated_at timestamptz not null default now()
);
insert into flags (name, value) values
  ('registrar_writes_paused', 'false'), ('orders_paused', 'false'), ('agent_purchases_paused', 'false'),
  ('limits.daily_registrations', '200'), ('limits.new_account_daily_registrations', '5'),
  ('limits.new_account_exposure_minor', '30000'), ('heartbeat.tick', 'null');

create table webhook_events (
  id uuid primary key default uuidv7(),
  provider text not null check (provider in ('stripe','resend','opensrs','github')),
  event_id text not null,
  livemode boolean,
  type text not null,
  payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (provider, event_id)
);

create table jobs (
  id uuid primary key default uuidv7(),
  kind text not null,
  priority smallint not null default 1 check (priority in (0,1)),
  run_at timestamptz not null default now(),
  state text not null default 'queued' check (state in ('queued','running','done','failed','dead')),
  attempt_id uuid,
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  locked_until timestamptz,
  dedupe_key text,
  payload jsonb not null default '{}',
  last_error text,
  user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_payload_ids_only check (payload::text !~* '"[a-z_]*(secret|password|authcode|auth_code|token)[a-z_]*"\s*:')
);
create unique index jobs_dedupe_live on jobs (dedupe_key) where dedupe_key is not null and state in ('queued','running');
create index jobs_runnable on jobs (priority, run_at) where state = 'queued';
create index jobs_running on jobs (locked_until) where state = 'running';
create trigger jobs_touch before update on jobs for each row execute function set_updated_at();

create table email_log (
  id uuid primary key default uuidv7(),
  kind text not null,
  dedupe_key text not null unique,
  user_id uuid references users(id),
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','sent','delivered','bounced','complained','suppressed')),
  bounced_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table alerts (
  id uuid primary key default uuidv7(),
  severity text not null check (severity in ('info','warn','page')),
  kind text not null,
  subject text,
  detail jsonb,
  state text not null default 'open' check (state in ('open','acked','closed')),
  raised_at timestamptz not null default now(),
  acked_at timestamptz,
  acked_by text
);

create table account_exports (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  requested_at timestamptz not null default now(),
  ready_at timestamptz,
  expires_at timestamptz,
  storage_ref text
);

create table rate_counters (
  key_hash bytea not null,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key_hash, bucket, window_start)
);
create index rate_counters_ttl on rate_counters (window_start);
