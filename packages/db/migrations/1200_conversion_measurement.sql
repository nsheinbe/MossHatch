-- Aggregate first-party stages, without raw searches, URLs, visitor IDs or IP addresses.
create table conversion_counts (
 day date not null, event text not null check (event in ('visit','search','available','selected','checkout')),
 mode text not null check (mode in ('preview','live')), device text not null check (device in ('mobile','desktop')),
 source text not null check (source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 medium text not null check (medium ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 campaign text not null check (campaign ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 count bigint not null default 1 check (count > 0),
 primary key(day,event,mode,device,source,medium,campaign)
);
grant select,insert,update on conversion_counts to mh_runtime;
grant select,insert,update,delete on conversion_counts to mh_cron;
-- First attribution wins. Order ownership is checked through the existing orders RLS before insert.
create table conversion_orders (
 order_id uuid primary key references orders(id) on delete cascade,
 user_id uuid not null references users(id) on delete cascade,
 device text not null check (device in ('mobile','desktop')),
 source text not null check (source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 medium text not null check (medium ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 campaign text not null check (campaign ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);
alter table conversion_orders enable row level security;
alter table conversion_orders force row level security;
create policy conversion_orders_owner on conversion_orders using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select,insert on conversion_orders to mh_runtime;
grant select,insert,update,delete on conversion_orders to mh_cron;
