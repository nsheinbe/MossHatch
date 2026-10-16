# Funded admission

Commercial registration policy enables the funded-admission path on the web deployment. Deploy migration 1180 before the web code, then the registrar's new signed funding commands before commercial policy is enabled. Keep the operator pause and commercial policy unchanged until the native PostgreSQL money tests, both deployments, provider authentication, actual vendor balance and asynchronous settlement verification pass.

A verified card authorization or unexpectedly captured registration/transfer payment must acquire an uncached vendor funding lease before becoming authorized. The lease uses the exact Redis boundary shared by register, renew, transfer-in and restore on every registrar instance. Those writes, including signed calls outside the order pipeline, cannot overlap the funding observation and its admission transaction. Normal reads and reconciliation remain available.

The short transaction locks its order and a PostgreSQL advisory boundary, checks the full durable wholesale reservations plus uncharged renewals due within 14 days and the configured cash floor, and records funding_reserved_minor with the authorization. The lease is released after commit; vendor/Stripe HTTP happens outside that transaction. The API and registrar functions are bounded at 800 seconds; the shared lease is 900 seconds, and admission refuses leases with less than 30 seconds remaining. PostgreSQL statement/idle timeouts bound the admission transaction.

Unpaid Checkout reserves zero. Consented off-session renewals reserve before sending the Stripe payment request; a known decline frees their reservation, an unanswered payment retains it. A verified automatic-capture renewal Checkout reserves before fulfillment, or the existing refund path returns the unkept payment. Renewals already due rank ahead of new registrations through the lookahead reserve.

Known upstream registration/renewal/transfer completion frees only its own reservation after the vendor debit. Pending/unknown outcomes retain reservations, including early-captured transfers and other order states. Confirmed inactive transfer cancellation frees the reservation; an unknown status does not. An unresolved registration write keeps its reservation even after cancellation. Uncertain reservations require reconciliation before any operator release; do not clear them merely to admit more sales.

This is internal funded-admission coordination, not a provider accounting certification. Openprovider authentication must work, the real available/held balance must be funded for the expected wholesale mix, and the provider's pending hold/debit/settlement behavior must be verified in sandbox. Out-of-band reseller purchases that bypass the signed registrar cannot be coordinated by this application. The bounded Redis lease also cannot establish an unlimited upper bound on a vendor's asynchronous effects; durable order reservations are kept until known completion, but direct pending RPC operations without an order need operator reconciliation. Commercial launch remains blocked on those facts.

Read-only admission telemetry:
SELECT kind,state,count(*) AS orders,sum(funding_reserved_minor) AS reserved_minor FROM orders GROUP BY kind,state ORDER BY kind,state;
SELECT name,value,updated_at,updated_by FROM flags WHERE name IN ('registrar_writes_paused','sell_gate.min_funds_minor');
SELECT * FROM registrar_balance_snapshots ORDER BY at DESC LIMIT 1;

Validation includes independent concurrent PostgreSQL admission transactions, an eight-account authorization burst with only two funded wholesale slots, all four operation kinds across pending/early-captured states, completed-debit accounting, off-session unanswered-payment reservation, signed RPC authentication and cross-instance exclusion of all paid methods during admission. These tests use fake Stripe/provider effects and native PostgreSQL; they do not buy domains.
