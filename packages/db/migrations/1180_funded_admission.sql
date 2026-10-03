-- Wholesale promised by a verified authorization or a consented off-session charge.
-- Unpaid Checkout remains zero; pending/unknown vendor outcomes retain the reservation.
alter table orders add column funding_reserved_minor bigint not null default 0 check (funding_reserved_minor >= 0);
update orders set funding_reserved_minor = (quote->>'wholesale_minor')::bigint
where kind in ('register','transfer_in','restore') and registered_at is null and state in ('review_hold','authorized','registering','outcome_unknown','registrar_unavailable','paid_before_registration','captured','capture_failed','canceling','refund_pending')
   or kind = 'renew' and state = 'renewing_upstream';
