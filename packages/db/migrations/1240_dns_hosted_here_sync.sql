-- DC-01: one-shot correction of domains.dns_hosted_here from the nameservers already stored on the row.
-- No registrar call. Same rule as isProviderDns: every nameserver is Openprovider's, or every nameserver is
-- OpenSRS SystemDNS (also the mock). Empty, mixed, and foreign sets are not hosted here.
-- Rows written after registration, transfer-in, sync, and nameserver change already set the column. This
-- catches rows that predate that, and is safe to run again.

create or replace function sync_dns_hosted_here() returns integer
language plpgsql
as $$
declare
  n integer;
begin
  update domains d
     set dns_hosted_here = hosted.ok,
         updated_at = now()
    from (
      select id,
             cardinality(nameservers) > 0
             and (
               not exists (
                 select 1 from unnest(nameservers) ns
                  where lower(regexp_replace(btrim(ns), '\.$', '')) not in (
                    'ns1.openprovider.nl', 'ns2.openprovider.be', 'ns3.openprovider.eu'
                  )
               )
               or not exists (
                 select 1 from unnest(nameservers) ns
                  where lower(regexp_replace(btrim(ns), '\.$', '')) not like '%.systemdns.com'
               )
             ) as ok
        from domains
    ) hosted
   where d.id = hosted.id
     and d.dns_hosted_here is distinct from hosted.ok;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke all on function sync_dns_hosted_here() from public;

select sync_dns_hosted_here();
