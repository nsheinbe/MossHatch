-- DC-14: a model may propose a connect plan. Off until the flag is turned on. It cannot apply one.

insert into flags (name, value) values ('connect.ai', 'false'::jsonb) on conflict (name) do nothing;
