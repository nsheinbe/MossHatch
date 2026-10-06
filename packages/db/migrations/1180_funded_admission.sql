-- Wholesale promised by a verified authorization or a consented off-session charge.
-- Unpaid Checkout remains zero; pending/unknown vendor outcomes retain the reservation.
alter table orders add column funding_reserved_minor bigint not null default 0 check (funding_reserved_minor >= 0);
-- State alone is insufficient: an unanswered charge or vendor write can survive cancellation,
-- refund, dispute, and the renewal lookahead window. Preserve those promises until reconciled.
-- Known completion is already reflected in vendor cash and must not be reserved a second time.
update orders o set funding_reserved_minor = (o.quote->>'wholesale_minor')::bigint
where o.registered_at is null and o.state not in ('registered','renewed')
  and not exists (select 1 from transfers_in t where t.order_id = o.id and t.state = 'completed')
  and not exists (select 1 from order_operations p where p.order_id = o.id and p.state = 'resolved' and
    (p.kind = 'register' and p.response_code = 'registered' or p.kind = 'renew' and p.response_code = 'renewed'))
  and (
    o.kind in ('register','transfer_in','restore') and o.state in ('review_hold','authorized','registering','outcome_unknown','registrar_unavailable','paid_before_registration','capturing','captured','capture_failed','canceling','refund_pending')
    or o.kind = 'renew' and o.state = 'renewing_upstream'
    or exists (select 1 from order_operations p where p.order_id = o.id and p.state = 'sent' and p.kind in ('register','transfer','renew','renew_charge'))
    or exists (select 1 from transfers_in t where t.order_id = o.id and (t.state in ('submitting','submitted','pending_owner_approval','pending_registry') or t.late_watch_until is not null))
  );
