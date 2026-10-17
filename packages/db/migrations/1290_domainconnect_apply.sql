-- DC-08: signed Domain Connect sync apply. Off until turned on. A missing flag is off.
-- While it is off, discovery omits urlSyncUX.
insert into flags (name, value) values ('domainconnect.apply', 'false'::jsonb) on conflict (name) do nothing;
