# Production-port DNS interface

Captured locally from the production-port worktree based on production commit `e311dae`, using Chromium and synthetic API fixtures on 2026-10-09.

- `dns-desktop.png`: current DNS panel at a 1280 × 900 viewport.
- `dns-phone.png`: current DNS panel at a 390 × 844 viewport.
- `nameservers-desktop.png` and `nameservers-phone.png`: the same panel scrolled to the delegation preview and its execution gate.

The port preserves the main baseline's compact panel, provider-aware DNSSEC metadata, contact and registrant verification controls, descriptive history, and local-time labels. It adds visible TTL, preserved-record protection, and a nameserver proposal preview whose execution remains blocked.

The records and destination nameservers are fixtures. These captures show local interface behavior; they do not demonstrate a live registrar write, DNSSEC transition, or DNS propagation.
