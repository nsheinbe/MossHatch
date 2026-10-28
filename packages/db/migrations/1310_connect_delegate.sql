-- DC-13: explain when the apex cannot be served here. Off until the flag is turned on.

insert into flags (name, value) values ('connect.delegate', 'false'::jsonb) on conflict (name) do nothing;
