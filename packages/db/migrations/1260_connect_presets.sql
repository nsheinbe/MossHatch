-- DC-05: preset plans. Off until turned on. A missing flag is off.
insert into flags (name, value) values ('connect.presets', 'false'::jsonb) on conflict (name) do nothing;
