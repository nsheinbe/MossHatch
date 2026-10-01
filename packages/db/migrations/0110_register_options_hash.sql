-- Review fix (passkey.add): a registration challenge records the hash of the options it was issued with, so
-- POST /passkeys can require that the ceremony used exactly the options the step-up signed (actions.params.options_hash).
-- Written by the app under the user's RLS policy on webauthn_challenges; no new grant is needed.
alter table webauthn_challenges add column if not exists options_hash bytea;
