-- DC-12: propagation of a connect plan. Off until the flag is turned on. A missing flag is off.

insert into flags (name, value) values ('connect.verify', 'false'::jsonb) on conflict (name) do nothing;

alter table connect_plans add column verify_state text
  check (verify_state is null or verify_state in ('pending', 'shedding', 'spread'));
