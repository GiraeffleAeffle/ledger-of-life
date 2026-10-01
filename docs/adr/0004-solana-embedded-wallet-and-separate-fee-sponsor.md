---
status: accepted
---

# Start with a user-owned embedded Solana wallet and separate fee sponsorship

The mandatory backup-access recovery ceremony below was superseded on 1 October 2026 by [ADR 0014](0014-passkey-only-test-accounts.md). Custody and sponsor separation remain unchanged.

The connected demo needs passkey access, recovery and transactions without requiring the tenant to hold SOL. We use Privy for a user-owned embedded Solana wallet and a separate app-funded fee payer. ADR 0008 records the implemented sponsor service; Kora remains an alternative provider, not an active dependency. This preserves ordinary Solana wallet signing for the lending and investment integrations, at the cost of a wallet-provider dependency and sponsor operating costs.

## Considered options

An external wallet alone would not meet the agreed onboarding requirement. A Swig smart wallet with on-chain passkey authority is a concrete alternative, but adds wallet invocation and recovery permissions that must be tested with the full money path. Passkey authentication into an embedded wallet and on-chain passkey authorization are different designs; the first implementation chooses embedded-wallet signing.

## Consequences

Require user authorization for spending and prove that backup access recovers the same funded wallet. Paying fees grants no portfolio authority; neither the app backend nor the landlord/arbitrator receives an independent investment signer. Sponsorship must cover required account creation and respect transaction/quote signatures. Wallet identities become expensive to change after funding, so prove the selected recovery path before onboarding funded demo users.

Acceptance requires the new-device, mobile/browser, cancellation and zero-user-SOL tests in the [wallet plan](../SOLANA_STACK_EXPLORATION_2026-09-22.md#5-wallets-banking-and-server-operation), which also contains the provider documentation. This proposal does not claim those integrations already work in our application.

Implementation evidence and remaining connected acceptance gates are recorded in [the status report](../IMPLEMENTATION_STATUS.md) and [ADR 0008](0008-durable-runtime-and-bounded-sponsors.md). Acceptance of this architecture does not assert completed provider or production validation.
