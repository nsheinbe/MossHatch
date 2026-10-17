-- DC-06: the presets section in the Connect tab. Off until turned on. A missing flag is off.
insert into flags (name, value) values ('connect.ui', 'false'::jsonb) on conflict (name) do nothing;
