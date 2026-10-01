---
status: accepted
date: 2026-10-01
---

# Passkey-only test accounts, without email recovery

## Decision

The owner does not want to collect email addresses or client IP addresses. Ledger of Life is a test-network product: nothing here has monetary value. Sign-up and sign-in use passkeys only. A provider-verified passkey, the appropriate sole-owned wallet and the existing tenancy membership/signature checks authorize tenancy actions. There is no backup-email requirement or second-session wallet-recovery proof, in production or locally.

This supersedes [ADR 0011](0011-ask-for-recovery-at-the-first-wallet-action.md) and the mandatory backup-access recovery ceremony in [ADR 0004](0004-solana-embedded-wallet-and-separate-fee-sponsor.md), where they conflict. Wallet custody, sponsor separation and user authorization remain unchanged.

## Consequences

- Recommend a second passkey on another device using Privy's existing passkey-linking hook; never make it a tenancy prerequisite. Losing every passkey means losing the test account. This consequence is stated at sign-up and in account settings.
- Existing accounts can remove a linked email in Me when at least one passkey remains. The address is used only client-side to call Privy's unlink hook, not shown as an account label or sent to the application store.
- Delete the obsolete recovery screens, challenge/signature code, API endpoints, readiness flags and skip-recovery build settings. Store initialization removes old recovery/browser records and the connector registry's legacy source-rate field. SQLite secure deletion and WAL reclamation remove freed bytes from the live database; existing backups are a separate retention concern.
- Stop reading forwarded client-IP headers for host pairing. Single-use, ten-minute owner invitations, 128 invitation/active-host caps and canonical connector-key checks already bound admission. Their invitation entropy and authenticated issuer are the authorization boundary, not an untrusted source header. This deliberately drops the per-source throttle rather than introducing another network-derived identifier.
- Public AI desk visitor limits remain keyed by a cryptographically random, first-party session cookie, not an IP or fingerprint, with a shared daily cap that cannot be evaded by rotating cookies.
- No documents are requested or uploaded by account setup. This decision is not a claim of anonymous operation: wallet/account identifiers, tenancy records and explicitly entered text still exist. [PRIVACY.md](../PRIVACY.md) inventories those facts and outstanding owner decisions.

## Verification boundary

Local tests exercise passkey-only tenancy readiness, wallet-access checks, signed service operations and migration of legacy records without a public-chain submission. Device-specific Privy signup/link/unlink and a complete deployed tenancy require a separate real-device run; this decision does not assert they were exercised.
