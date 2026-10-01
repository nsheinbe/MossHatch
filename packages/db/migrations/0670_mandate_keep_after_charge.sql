-- C-19, C-31, C-38: an auto-renew mandate and the consent that proves it are the evidence for every renewal charged under it, so
-- they are kept at least three years after the last renewal charge (COMPLIANCE C-31: "kept at least 3 years after the last
-- renewal"), not three years from the signature. That also covers the card dispute window of the last charge: neither PLAN nor
-- COMPLIANCE states a figure for it, and 540 days (the longest card-network window, an unverified own figure) is shorter.
-- `retain_until` is set at signing (domains/mandate.ts, MANDATE_RETAIN_MS) and extended here whenever a renewal payment for the
-- domain succeeds, whichever path writes the payment, and including a charge that settles shortly after the mandate was switched
-- off (a charge already started stays, C-34). The retention purge keeps the consent while its mandate is kept. Only adds.
create or replace function renewal_mandate_keep_after_charge() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain uuid; v_at timestamptz; v_keep timestamptz;
begin
  if new.status is distinct from 'succeeded' then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status and old.captured_at is not distinct from new.captured_at then return new; end if;
  select o.domain_id into v_domain from orders o where o.id = new.order_id and o.kind = 'renew';
  if v_domain is null then return new; end if;
  v_at := coalesce(new.captured_at, new.created_at);
  v_keep := v_at + interval '1095 days';
  -- The mandates in force for this charge: signed before it, and not switched off more than 30 days before it settled.
  update renewal_mandates m set retain_until = v_keep
   where m.domain_id = v_domain and m.user_id = new.user_id and m.accepted_at <= v_at
     and (m.revoked_at is null or m.revoked_at > v_at - interval '30 days') and m.retain_until < v_keep;
  update consents c set retain_until = v_keep from renewal_mandates m
   where m.domain_id = v_domain and m.user_id = new.user_id and m.accepted_at <= v_at
     and (m.revoked_at is null or m.revoked_at > v_at - interval '30 days') and c.id = m.consent_id and c.retain_until < v_keep;
  return new;
end $$;
create trigger payments_mandate_keep after insert or update of status, captured_at on payments
  for each row execute function renewal_mandate_keep_after_charge();
revoke all on function renewal_mandate_keep_after_charge() from public;

-- Mandates charged before this migration: the same rule, once.
update renewal_mandates m set retain_until = x.keep
  from (select m2.id, max(coalesce(p.captured_at, p.created_at)) + interval '1095 days' as keep
          from renewal_mandates m2
          join orders o on o.domain_id = m2.domain_id and o.user_id = m2.user_id and o.kind = 'renew'
          join payments p on p.order_id = o.id and p.status = 'succeeded' and coalesce(p.captured_at, p.created_at) >= m2.accepted_at
           and (m2.revoked_at is null or m2.revoked_at > coalesce(p.captured_at, p.created_at) - interval '30 days')
         group by m2.id) x
 where m.id = x.id and m.retain_until < x.keep;
update consents c set retain_until = m.retain_until from renewal_mandates m where c.id = m.consent_id and c.retain_until < m.retain_until;
