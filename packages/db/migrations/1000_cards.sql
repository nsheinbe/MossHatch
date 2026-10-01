-- Phase 6: hatchkind.com cards (PLAN 4.4 `cards`, 4.8, threat row 42, D-035, C-64 to C-71).
-- A card holds computed traits, the hatch date and a stored portrait. Never free text, never an owner field.

create table cards (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  domain_id uuid not null references domains(id),
  -- The public address hatchkind.com/<slug>: the domain's ASCII name.
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  species text not null,
  family text not null check (family in ('fox','moth','beetle','koi')),
  rarity text not null check (rarity in ('common','uncommon','rare')),
  -- Short phrases from a fixed vocabulary, computed on the server from the domain name.
  traits jsonb not null check (jsonb_typeof(traits) = 'array' and jsonb_array_length(traits) between 1 and 8),
  hatched_on date not null,
  snapshot_ref text not null,
  snapshot_url text not null,
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  image_width int not null,
  image_height int not null,
  image_bytes int not null,
  indexable boolean not null default false,
  published_at timestamptz not null,
  unpublished_at timestamptz,
  unpublish_reason text check (unpublish_reason in ('owner','released','takedown','account_closed','republished')),
  takedown_state text not null default 'none' check (takedown_state in ('none','taken_down')),
  action_id uuid,
  -- When the stored portrait was deleted from blob storage (after an unpublish).
  purged_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index cards_live_slug on cards (slug) where unpublished_at is null;
create unique index cards_live_domain on cards (domain_id) where unpublished_at is null;
create index cards_user on cards (user_id);
create index cards_unpurged on cards (unpublished_at) where unpublished_at is not null and purged_at is null;

alter table cards enable row level security;
alter table cards force row level security;
create policy tenant on cards using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on cards to mh_runtime;

-- Repeat infringers lose publishing (C-66). Written by support and the takedown path (cron role); read by the publish gate.
create table card_publish_blocks (
  user_id uuid primary key references users(id),
  reason text not null check (reason in ('repeat_takedown','abuse')),
  created_at timestamptz not null default now()
);
alter table card_publish_blocks enable row level security;
alter table card_publish_blocks force row level security;
create policy tenant on card_publish_blocks using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select on card_publish_blocks to mh_runtime;

-- Web Risk lookups per month, a count only (C-68 quota record). The returned verdicts are not stored or redistributed.
create table card_screen_counts (
  month date primary key,
  lookups int not null default 0
);
grant select, insert, update on card_screen_counts to mh_runtime;

-- Take-down ledger: a report can name the card it is about (C-66, `target_kind = card`).
alter table abuse_reports add column if not exists target_id uuid;

-- The public read path. hatchkind.com's role sees this view and nothing else: published, not taken down, and the domain not released.
-- No user id, no domain id, no card id. The view runs with its owner's rights, like the definer functions in 0007.
create view public_cards as
  select c.slug, c.species, c.family, c.rarity, c.traits, c.hatched_on, c.snapshot_url, c.image_sha256, c.image_width, c.image_height, c.indexable, c.published_at
  from cards c join domains d on d.id = c.domain_id
  where c.unpublished_at is null and c.takedown_state = 'none' and d.released_at is null;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mh_cards') then create role mh_cards nologin; end if;
end $$;
grant usage on schema public to mh_cards;
grant select on public_cards to mh_cards;
grant select on public_cards to mh_runtime, mh_cron;

-- The system role (sweeps, take-downs, release) works on every card table.
grant all on cards, card_publish_blocks, card_screen_counts to mh_cron;
