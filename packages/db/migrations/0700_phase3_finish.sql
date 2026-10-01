-- Phase 3 finish: saved-card consent at first Checkout (C-31, C-38), the Checkout fallback for Renew now, card-updater handling,
-- and the pre-charge notice record. Adds columns only; no existing column changes meaning.

-- An order whose Checkout asked Stripe to save the card for later off-session use (`setup_future_usage=off_session`). Set only when the
-- person ticked the auto-renew box, which is separate from the terms box (C-31). Only such a card is ever charged off-session.
alter table orders
  add column if not exists save_card boolean not null default false,
  -- The Stripe payment method is attached to the customer and may be charged off-session (set on capture of a save_card order).
  add column if not exists card_reusable boolean not null default false,
  -- When a saved card was detached because the order ended without a name (C-31: "detach a saved card if the order is cancelled").
  add column if not exists card_detached_at timestamptz;

-- The mandate after a card-updater event (C-38): the card network replaced the card details. A new brand is a new agreement (Stripe),
-- so the mandate waits for a fresh passkey signature; a new number or expiry on the same brand is recorded and the person is told.
alter table renewal_mandates
  add column if not exists card_updated_at timestamptz,
  add column if not exists reconsent_required_at timestamptz,
  add column if not exists reconsent_reason text;

-- The checkout opt-in: the person ticked the auto-renew box beside the price at checkout. It saves the card; the mandate itself is
-- still signed with a passkey on the domain page (`mandate.sign`), so this is a pending intention, not a mandate.
alter table orders
  add column if not exists auto_renew_opt_in boolean not null default false;

create index if not exists orders_payment_method on orders (payment_method_ref) where payment_method_ref is not null;
create index if not exists renewal_mandates_pm on renewal_mandates (stripe_payment_method_ref) where revoked_at is null;
