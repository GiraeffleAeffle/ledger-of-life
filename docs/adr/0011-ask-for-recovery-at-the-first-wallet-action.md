---
status: superseded by 0014
---

# Ask for the recovery proof at the first wallet action, not at sign-up

Superseded on 1 October 2026 by [ADR 0014](0014-passkey-only-test-accounts.md). The following records the historical decision, not the current account-access contract.

[ADR 0004](0004-solana-embedded-wallet-and-separate-fee-sponsor.md) requires that backup access is proved to recover the same wallets before funds are used. The setup wizard also put that proof, which needs a second browser, in front of every area of the app, and a production build cannot skip it. A judge with one browser, a phone visiting a local run, or an arbitrator following an invitation could see nothing, not even public city data, until it was done.

Setup now ends after the passkey, the backup email and the two wallets. The proof is asked the first time a wallet acts on a tenancy: as a step in the tenancy card ("Prove you can recover your wallets") and as a reminder card on Today. The server rule is unchanged: `requireWalletRecovery` still refuses every Solana and Robinhood connected-funds action, and a tenant or arbitrator whose wallet reads it refuses sees the proof as their next step. The alternative, keeping the proof at sign-up and letting demo builds skip it, leaves production builds walled off and hides the step from the people it is meant to protect.

## Consequences

- A person can browse, choose a city and read before proving anything. "Set up once" became "set up, then prove before a wallet acts on a tenancy".
- The proof gates what the server already gates: deposit space, deposit, claims, settlement. Money's test-token actions (buying test shares, pledging, borrowing, local stakes, paid AI) never required it server-side and still do not. Gating them would put the ceremony back in front of the demo; that is a product decision, not an accident.
- Whether the backup email is required stays a server setting: demo builds that skip the proof (`DEMO_SKIP_RECOVERY=1`, never in production) skip the email too.
- The baseline still records the two wallets once and cannot be replaced ([wallet setup](../WALLET_SETUP.md)).
