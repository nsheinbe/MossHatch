-- The brand launcher (docs/LAUNCHER.md, D-061): talk to the creature, approve a brief, pay credits for a build on Slate.
-- Off by default: the flag `launcher_enabled` gates every route, and only invited accounts pass (MH_LAUNCHER_INVITE_ONLY).

insert into flags (name, value) values ('launcher_enabled', 'false') on conflict (name) do nothing;

-- One conversation per account and domain. `api_messages` is the exact Messages API history, append-only (the prompt cache and the
-- model's thinking blocks both depend on an unchanged prefix); `transcript` is what the page shows (captions), which can hold lines
-- the model never sees (an in-character refusal). `persona` is frozen at creation so the cached prefix never drifts.
create table launcher_conversations (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  source text not null check (source in ('owned', 'practice')),
  spec jsonb not null,
  persona text not null,
  model text not null,
  api_messages jsonb not null default '[]'::jsonb check (jsonb_typeof(api_messages) = 'array'),
  transcript jsonb not null default '[]'::jsonb check (jsonb_typeof(transcript) = 'array'),
  -- Tool calls waiting for the owner (a proposed brief, a proposed revision); answered at the start of the next owner turn.
  pending jsonb not null default '[]'::jsonb check (jsonb_typeof(pending) = 'array'),
  proposals jsonb not null default '[]'::jsonb check (jsonb_typeof(proposals) = 'array'),
  owner_turns int not null default 0,
  -- Token counts summed over the conversation (input, output, cache reads and writes), for the cost record. Never text.
  usage jsonb not null default '{}'::jsonb,
  -- A turn holds this lease while it streams, so two tabs cannot interleave turns (append-only history).
  turn_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index launcher_conversations_live on launcher_conversations (user_id, domain) where archived_at is null;
alter table launcher_conversations enable row level security;
alter table launcher_conversations force row level security;
create policy tenant on launcher_conversations using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on launcher_conversations to mh_runtime;

-- A build (or revision) from quote to result. `price_minor` is what the owner is charged in credits (1 credit = 1 US cent) and is shown
-- before they confirm; `slate_price_minor` is Slate's quote. A row starts `quoted`; only a confirmed row ever reaches Slate.
create table launcher_builds (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  conversation_id uuid not null references launcher_conversations(id),
  proposal_id text not null,
  kind text not null check (kind in ('website', 'revision')),
  version int,
  brief jsonb not null,
  instruction text check (instruction is null or char_length(instruction) <= 500),
  base_build_id uuid references launcher_builds(id),
  slate_quote_id text not null,
  slate_model text,
  slate_price_minor bigint not null check (slate_price_minor >= 0),
  price_minor bigint not null check (price_minor >= 0),
  currency text not null check (currency = 'usd'),
  quote_expires_at timestamptz not null,
  status text not null default 'quoted' check (status in ('quoted', 'expired', 'queued', 'building', 'ready', 'failed', 'refunded', 'canceled')),
  slate_build_id text,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  steps jsonb not null default '[]'::jsonb,
  title text,
  summary text,
  preview_url text,
  -- Slate's preview URLs are signed and valid 10 minutes: re-read from Slate when older than 8.
  preview_fetched_at timestamptz,
  error_code text,
  charged_minor bigint,
  confirmed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index launcher_builds_idem on launcher_builds (user_id, idempotency_key) where idempotency_key is not null;
create unique index launcher_builds_version on launcher_builds (conversation_id, version) where version is not null;
create index launcher_builds_conv on launcher_builds (conversation_id, created_at);
create index launcher_builds_confirmed on launcher_builds (confirmed_at) where confirmed_at is not null;
alter table launcher_builds enable row level security;
alter table launcher_builds force row level security;
create policy tenant on launcher_builds using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on launcher_builds to mh_runtime;

-- The credits ledger: append-only, one row per movement. Balance = sum(delta_minor). A build is charged once, settled at most once (an
-- `adjust` with the build: Slate charged less than it quoted) and refunded at most once (the unique index), so a retried confirm or a
-- second failure poll cannot move money twice. The runtime role may insert and read;
-- nobody updates or deletes a row (grants), and a correction is a new `adjust` row.
create table launcher_credits (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  delta_minor bigint not null check (delta_minor <> 0),
  kind text not null check (kind in ('grant', 'charge', 'refund', 'adjust')),
  build_id uuid references launcher_builds(id),
  -- Who moved it: 'system' (charge, refund), 'owner-script' (scripts/launcher-credits.mjs), later 'stripe'.
  created_by text not null,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  check (kind not in ('charge', 'refund') or build_id is not null),
  check (kind <> 'charge' or delta_minor < 0),
  check (kind <> 'refund' or delta_minor > 0),
  check (kind <> 'grant' or delta_minor > 0)
);
create unique index launcher_credits_once on launcher_credits (build_id, kind) where build_id is not null;
create index launcher_credits_user on launcher_credits (user_id, created_at);
alter table launcher_credits enable row level security;
alter table launcher_credits force row level security;
create policy tenant on launcher_credits using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert on launcher_credits to mh_runtime;

-- The global daily spend fuse needs every account's charges for a UTC day; the runtime role asks through this (a sum, nothing else).
create or replace function launcher_spend_on(p_day date)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(-sum(c.delta_minor), 0)::bigint from launcher_credits c
  where c.build_id is not null and c.build_id in (
    select b.id from launcher_builds b where b.confirmed_at >= p_day::timestamptz and b.confirmed_at < (p_day + 1)::timestamptz)
$$;
revoke all on function launcher_spend_on(date) from public;
grant execute on function launcher_spend_on(date) to mh_runtime, mh_cron;

-- The system role (support, the owner's credit script, sweeps) works on every launcher table.
grant all on launcher_conversations, launcher_builds, launcher_credits to mh_cron;
