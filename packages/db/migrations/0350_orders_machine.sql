-- Orders module (Phase 2): columns the state machine needs beyond 0004. Adds columns only, so the existing table
-- privileges and row-level security policies on `orders` cover them unchanged.
alter table orders
  add column authorized_at timestamptz,
  add column amount_capturable_minor bigint,
  add column tax_minor bigint,
  add column registered_at timestamptz,
  add column registrar_ref text,
  add column registrar_expires_at timestamptz,
  add column next_check_at timestamptz,          -- earliest time a poll or retry may act (backoff)
  add column check_count integer not null default 0,
  add column cancel_pi_id text,                  -- the PaymentIntent the cancel step must cancel (may differ from the linked one)
  add column capture_failed_at timestamptz,
  add column capture_deadline timestamptz,       -- capture_failed: delete inside add-grace at this time
  add column pay_link_expires_at timestamptz,
  add column stripe_customer_id text,
  add column payment_method_ref text,
  -- late_registration_watch: a name we gave up on but that may still appear as ours upstream (kept 14 days).
  add column late_watch_until timestamptz,
  add column late_watch_state text check (late_watch_state in ('watching','claimed','expired'));

create index orders_next_check on orders (next_check_at) where state in ('checkout_open','authorized','registering','outcome_unknown','registered','capturing','capture_failed','canceling','registrar_unavailable','paid_before_registration','review_hold','refund_pending');
create index orders_late_watch on orders (late_watch_until) where late_watch_state = 'watching';
