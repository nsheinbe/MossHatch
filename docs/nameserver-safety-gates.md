# Nameserver proposals and DNSSEC status

`nameservers.propose:example.com` grants an agent permission to request an exact registry delegation change for one owned domain. The wildcard form is rejected. Existing DNS read or write scopes do not imply this permission. An owner can grant it through the existing passkey consent flow or review an incremental scope request; agents never receive owner factors or registrar credentials.

REST: `POST /api/v1/agent/domains/example.com/nameservers/proposals`, with `{"nameservers":["ns1.destination.example","ns2.destination.example"]}`. MCP: `nameservers_propose` with `domain` and the same `nameservers` array. Both create the same existing agent-request record. Duplicate pending proposals reuse its ID. Existing expiry, revocation, tenant isolation, decline and velocity controls apply. A fresh grant check under the request lock prevents a grant narrowed during provider reads from persisting the proposal.

The browser previews the same plan through `POST /api/v1/domains/:fqdn/nameserver-proposals`. Plans bind the domain, current registry nameservers, available complete source records and TTL, provider-reported DS state, and exact requested nameservers to hashes. Agent requests additionally bind the tenant and requesting grant. Registry delegation is different from an NS record in a hosted zone. Source records are retained; public DNS scanning is not treated as inventory or authorization for another provider.

## Gates in this change

Nameserver execution is unavailable, including previously committed actions. The request can be reviewed or declined, but cannot be approved for execution. Neither `target_signed` nor a passkey assertion proves destination compatibility. Custom glue remains unavailable.

DNSSEC mutation is also unavailable at the browser/API approval and execution boundaries, including old committed DS actions. The former DS writer had no durable receipt before a provider call and cannot safely retry an uncertain outcome. Provider-aware reads remain available. Openprovider uses DNSKEY input; its returned DS is computed from registrar key material and is explicitly **not** an observation of the parent zone. The UI does not offer a generic DS-add form for Openprovider or an enabled removal button.

Before enabling either operation, implement and review all of:

- Separate authorization for the destination DNS account and complete authorized source/destination inventories, including records absent from public lookups.
- Actual authenticated parent DS observations, destination DNSKEY and RRSIG validation, and a provider-supported staged key/delegation transition with TTL waiting periods.
- Exact owner step-up approval bound to tenant, domain, grant, source-state version, destination state, expiry and complete changes; rechecks immediately before execution.
- A committed operation receipt before any provider write, read-only unknown-outcome reconciliation, safe recovery of partial application and duplicate-apply rejection.
- Separate provider acceptance, authoritative visibility and sampled propagation reporting. No global instant-propagation or atomicity claim.

Rollback cannot undo lost mail or cached answers. Do not remove DNSSEC data merely to get past a delegation gate.

## Evidence limits

This change used fixture providers and isolated local PostgreSQL/browser tests. It did not authorize or call a real-provider sandbox, change any real domain, install any owner factor, or verify a live DNSSEC transition. Production remains on a newer branch; reconcile the overlapping provider/DNS UI changes before merge or deployment.

Official references consulted on 2026-10-09: [Openprovider domain API](https://docs.openprovider.com/doc/domain.swagger), [Openprovider DNSSEC transitions](https://support.openprovider.eu/hc/en-us/articles/216648828-DNSSEC-Updates-and-transfers), and [DNSSEC key input format](https://doc.openprovider.eu/API_Format_DNSSEC_Keys).
