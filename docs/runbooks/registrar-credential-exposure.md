# Runbook: registrar credential exposure or unattributed change

Template: PLAN section 5. Skeleton written in Phase 3 (the first phase with an OpenSRS adapter and the signed RPC). Nothing here has been run against OpenSRS or Horizon: no credentials exist. The key-rotation drill below (ST-116) has been exercised only against the fake Horizon transport in `packages/registrar/src/opensrs/opensrs.test.ts`.

## Trigger

Any of: the OpenSRS reseller key, the reseller control-panel password or the `REGISTRAR_RPC_SECRET` seen outside the `registrar` project's Sensitive variables (repository, log, chat, screenshot, CI output, a departed person's machine); an alert from the unattributed-change detector (`reconciliation_findings` of kind `unattributed`: lock, nameservers, DS, owner email hash, `auto_renew`, `let_expire`, privacy or a transfer that no committed action explains, ST-114); the nightly posture job finding `auto_renew=1` or an unlocked name we did not unlock (ST-113); the end-user interface probe answering `reachable` (a registrant could reach codes or password resets); the velocity fuse tripping (`registrar.fuse_tripped`, ST-115); OpenSRS telling us of suspicious activity.

## Severity

S1. Page immediately. Registrar credentials move names, and a moved name is the worst harm the product can do.

## First 15 minutes

1. Pause every registrar write: `update flags set value = 'true', updated_by = 'incident' where name = 'registrar_writes_paused'`. The kill switch fails closed (ST-116): unlock, code issue, nameserver, DS, contact and DNS writes answer `registrar_writes_paused`; renewals already charged wait and retry (C-30). Reads, the detector and `transfer.poll` keep running.
2. If a hostile transfer is in progress, follow `stop-hostile-transfer.md` in parallel.
3. Rotate the reseller key (the drill steps): in the OpenSRS reseller control panel generate a new API key; put it in the `registrar` project's Production Sensitive variable (Horizon: the Preview/staging variable); redeploy the `registrar` project; smoke `GET_BALANCE` (the `getBalance` RPC command from `web`); confirm the old key is refused. Record the time of each step.
4. If `REGISTRAR_RPC_SECRET` leaked: set a new value in both projects, redeploy `registrar` first, then `web`; the RPC refuses the old signature (ST-118).
5. Reset the reseller control-panel password and confirm its 2FA (ST-119 checklist).
6. Run the detector by hand (`registrar.reconcile`) and read every open finding; list each domain with an unexplained change.
7. Lift the pause only after step 6 shows nothing unexplained is still open: `update flags set value = 'false', updated_by = 'incident' where name = 'registrar_writes_paused'`.

## Decision owner

Founder. The second trusted person may run steps 1 and 6 on instruction.

## Customer-notice template

Only for owners whose names changed: "On <date> a change was made to <domain> that you did not make: <what changed, in plain words>. We reversed it at <time> and locked the name. We replaced our registrar credentials. You do not need to do anything. If you see anything else you did not do, press Freeze in any Mosshatch email or write to security@mosshatch.com." Never include a code, a key or a contact detail.

## Upstream and regulator clocks

- Tucows / OpenSRS: tell them within 4 hours of learning a credential was compromised (MSA 2.8). Use the incident contact recorded under ST-119.
- ICANN: through Tucows, within 7 days, where Tucows asks for it.
- GDPR: 72 hours to the supervisory authority where personal data of people in scope was affected (counsel confirms applicability).

## Evidence to preserve

The leaked artefact and where it was found (hash, URL, first-seen time); `reconciliation_findings`, `alerts`, `audit_log` and `order_operations` rows for the window; the OpenSRS reseller activity log export; the registrar project's function logs (they hold ids, never values). Do not delete anything until it is captured.

## Exit test

- The old key is refused by OpenSRS (a smoke call with it fails authentication); the new key answers `GET_BALANCE`.
- `registrar_writes_paused` is false and one unlock-and-relock on a founder-owned test domain completes.
- The detector's next run opens no new unattributed finding; every earlier finding is closed with a note.
- The drill time is recorded in this file: pause, generate, update, redeploy, smoke, lift (target: under 30 minutes, own target).

## Drill log

| Date | Where | Pause to lift | Notes |
|---|---|---|---|
| (owed) | Horizon | | Not run: no Horizon credentials exist. ST-116 passes only against the fake Horizon transport. |
