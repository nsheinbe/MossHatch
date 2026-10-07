-- The one-live-registration lock covers every state in which an order holds money for a name or has sent its registration
-- (docs/AUDIT-2026-10-07.md F4). Before, `review_hold`, `registrar_unavailable` and `paid_before_registration` were outside it, so a
-- second buyer could authorize a name while the first was waiting, and the first buyer's later move failed on the index.
-- The authorization step already turns a conflict on this index into a clean `name_taken` void (orders/machine.ts evaluateAuthorization).
-- `superseded_at is null` stays (0550): a released name can be registered again.
drop index if exists orders_one_live_register;
create unique index orders_one_live_register on orders (fqdn_ascii)
  where kind = 'register' and superseded_at is null
    and state in ('review_hold', 'authorized', 'registering', 'outcome_unknown', 'registrar_unavailable', 'paid_before_registration',
                  'registered', 'capturing', 'captured');
