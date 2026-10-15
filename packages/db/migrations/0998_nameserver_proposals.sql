-- Proposals share the existing revocation, expiry, tenant and request lifecycle.
-- Execution remains gated until destination authorization/inventory and DNSSEC transition verification exist.
alter table agent_requests drop constraint agent_requests_kind_check;
alter table agent_requests add constraint agent_requests_kind_check
  check (kind in ('register','renew','dns_change','scope','nameservers_change'));
