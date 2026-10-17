-- DC-07: publish Domain Connect settings and the discovery TXT. Off until turned on. A missing flag is off.
insert into flags (name, value) values ('domainconnect.discovery', 'false'::jsonb) on conflict (name) do nothing;
