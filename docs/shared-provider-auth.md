# Shared Openprovider authentication

The live registrar uses its existing private Redis connection to share Openprovider bearer tokens and coordinate login across cold function instances. Production and sandbox hosts and exact contact usernames use separate cache namespaces. Password rotation selects a different token key; raw passwords are never stored. Account-wide login leases, attempt spacing and cooldowns remain shared across credential rotation.

Bearer tokens are secrets. Redis must remain private to the registrar project with sensitive credentials and authenticated HTTPS access. The cache does not expose tokens through signed RPC, application responses, errors or logs. Redis holds a bearer for at most 12 hours; a read never extends its lifetime. Every Redis script uses keys in one hash slot.

| Behavior | Bound |
| --- | --- |
| Login owner lease | 45 seconds; stale owners cannot publish over a replacement |
| Provider login starts | At least 2.1 seconds apart per host/contact; at most 29 in a rolling minute |
| Cold followers | At most 2.5 seconds of polling delays, then a retryable busy result; Redis requests have their existing 5-second timeout |
| Login HTTP 401 or provider code 196 | Shared 20-minute authentication cooldown |
| Login HTTP 429 | Shared one-minute backoff |
| Other login failures | Shared five-second backoff, without marking credentials permanently invalid |
| Provider rejects a cached token | Compare-and-delete only that token, then at most one retry through shared login admission |
| Redis failure | No local login fallback; provider requests stop before authentication |

The first authentication rejection retains its existing sanitized `auth_failed` error. Following attempts return retryable `openprovider_auth_cooldown` without another provider login. Correcting account access or credentials does not clear the account-wide cooldown early; capacity returns after its bounded expiry. A failed login owner cannot overwrite a newer owner's token or cooldown.

Official Openprovider documentation lists [30 token-generation calls per minute](https://support.openprovider.eu/hc/en-us/articles/218390187-What-are-Openprovider-API-calls-limits) and a 20-minute block after 100 failed logins in an hour. The [quick start](https://support.openprovider.eu/hc/en-us/articles/360025683173-Getting-started-with-Openprovider-API) gives a 48-hour token TTL and the supported username/password/ip login shape. [API access must be enabled for the intended contact](https://support.openprovider.eu/hc/en-us/articles/360015453220-How-to-enable-API-access); `ip: "0.0.0.0"` is valid login syntax and does not establish that contact-level allowlists permit the registrar's egress IP. [Code 196 means authentication/authorization failure](https://support.openprovider.eu/hc/en-us/articles/216644928-API-Error-Codes). An HTTP 500 with that code does not by itself establish a provider outage.

This coordination protects the registrar's login budget. Other applications using the same provider contact outside this Redis namespace can still consume the provider's quota. Availability, quote, balance and paid-operation quotas are separate and remain to be measured. No commercial-policy flag, registration price, payment flow, funding admission or real purchase is changed here.
