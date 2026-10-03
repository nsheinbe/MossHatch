# Commercial registration policy

This is an explicit operator configuration, not a traffic certification or an automatic public launch. The previous 3/day, 10 lifetime and 5 registrar operations/day values were dogfood spend fuses for the documented USD 20 reseller balance (D-060), not infrastructure capacity or upstream quotas.

## Select the count policy on both projects

Set `MH_REGISTRATION_POLICY=commercial` in Production on **mosshatch** and **mosshatch-registrar**, then deploy both projects. Without it, the existing dogfood defaults remain.

| Project | Optional explicit limit | Commercial default |
| --- | --- | --- |
| mosshatch | `MH_LIVE_DAILY_REGISTRATIONS` | unlimited |
| mosshatch | `MH_LIVE_TOTAL_REGISTRATIONS` | unlimited |
| mosshatch-registrar | `MH_REGISTRAR_DAILY_SPEND_OPS` | unlimited |

A nonnegative safe integer sets an explicit count ceiling; `0` stops that operation; `unlimited` removes it. Invalid explicit commercial values stop operations. Commercial policy replaces the legacy global count flags `limits.daily_registrations` (seeded at 200/day) and `limits.total_live_registrations` (seeded at 10). Configure an intended global count limit through the variables above rather than expecting those legacy flags to constrain commercial policy.

Payment/identity/amount verification, authorization windows, idempotency, sanctions screening, new-account exposure and velocity controls, operator pause flags, the vendor balance floor, renewal reserves, signed RPC/shared anti-replay nonces, and real provider rate-limit responses remain enforced. Commercial policy also removes the registrar count fuse from renewals, transfers-in and restores; real funds still have to exist.

## Working capital remains a real bottleneck

MossHatch normally creates a **manual-capture** Stripe Checkout. It verifies the authorization, registers upstream using the reseller's prepaid balance, then captures the customer payment. That authorization is not settled cash available to replenish the vendor account.

The checkout sell gate requires:

`vendor available balance - renewal reserves - existing authorized registration reserves - this order's wholesale cost >= configured floor`

The default floor is USD 250; the dogfood setup script can explicitly reduce it to USD 5. A documented USD 20 balance cannot fund a launch of 100 or 1,000 registrations. For example, at a verified USD 11.98 wholesale quote, 100 simultaneous .com registrations require at least USD 1,448 with the default floor, and 1,000 require USD 12,230, **plus renewal reserves**. These are arithmetic examples; use today's authenticated vendor quote and actual balance, not this document's sample price.

Before changing production policy, run the existing read-only go-live preflight and inspect current pause/floor flags, vendor available and held funds, renewal reserves, and expected wholesale mix. The operator must fund the actual vendor requirement; customer authorization or capture alone does not prove that capacity.

## Admission and provider concurrency are not yet proven safe for a funded surge

The current sell gate runs before Checkout. Unpaid `checkout_open` orders intentionally reserve no wholesale. When many checkouts authorize together, their authorization transitions do not atomically recheck and reserve vendor funds. Several can pass the early check against the same money. Provider `insufficient_funds` handling prevents an unfunded upstream registration and the state machine cancels/refunds as appropriate, but it does not preserve the renewal/floor cushion as an atomic admission guarantee. Do not claim funded surge admission from this policy change.

The current Openprovider adapter also compares a before/after **global reseller balance** delta to one register/renew quote. Overlapping paid operations can observe combined debits, report `debit_mismatch`, and pause a TLD in that warm adapter. Verify provider operation-specific accounting or a shared paid-operation serialization boundary before opening a surge of paid work; an instance-local mutex is insufficient across serverless instances.

These gaps are prerequisites for production commercial enablement, independent of customer chargeback acceptance. This change deliberately makes the operator's count policy explicit while retaining dogfood defaults until those prerequisites are satisfied.

## Public acquisition is a separate choice

Existing controls are `MH_INVITE_ONLY=0` for signup, `MH_LIVE_GATE=0` for access to purchase routes, and a matching `VITE_SITE_MODE=live` web build. Opening signup alone leaves purchases invite-gated. Registration policy does not change these controls, account authentication, accepted documents or the legal/tax readiness checks.

After the prerequisites above, validate an isolated provider sandbox with concurrent distinct accounts, full authorization-to-capture/fulfillment, duplicate callbacks, insufficient funding, renewals during a registration burst, and provider throttling. Record the deployed hashes, available funding, throughput, p95 completion time, backlog, errors and actual upstream quotas. Live purchases and registrations are not necessary for this code validation.
