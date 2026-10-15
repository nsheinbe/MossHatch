# DNS panel visual check

Captured in this dedicated cloud workspace on 2026-10-09 using installed Chromium 151, local Vite, and synthetic mocked API records for `fern-harness.com`. No live domain was read or changed. Desktop is 1280×900, phone is 390×844. Both versions include the functional DNS safety changes; **before** is the existing table layout before the requested typography/layout polish. **After** is the compact record layout. These screenshots are visual evidence, not proof of API security or real DNS propagation.

| Before | After |
|---|---|
| [Desktop](before-desktop.png) | [Desktop](after-desktop.png) |
| [Phone](before-phone.png) | [Phone](after-phone.png) |

The six-column table split values into fragments and clipped controls on the phone. Records now use a stacked semantic layout with a full-width monospace value, separate type/name/TTL, visible sensitivity notices and 44-pixel action targets. Delegation has its own section explaining its migration gate. The UI and passkey flow are also checked by Playwright; final counts are in the [verification report](../../SECURE-AGENT-DNS-VERIFICATION.md).
