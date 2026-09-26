# Product ontology

The machine-readable source of truth is [`ontology.yaml`](ontology.yaml). This page explains it. When a concept changes, update both.

**Thesis.** Money and assets that everyday life forces people to lock away (rental deposits first) should keep working for their owner, without weakening the protection they exist for.

**Positioning (decided 2026-09-26).** A household-ownership app. Your verified identity is the root, and everything you own, rent or run attaches to it through adapters. The rental deposit is the first and most complete building block.

**Bigger picture.** Part of [Stadtstack](https://stadtstack.giraeffleaeffle.chatgpt.site): one verified identity, many contexts (tenancy, club, house community, city). Each context gives the person roles, a feed of what is decided, and what they own there. The tenancy is the first context that is built.

**The app in one sentence.** A home-centred app that shows everything you own. It secures rental deposits in escrows that earn, lets tenants claim and invest those earnings, and connects the other things a household owns that produce value.

## Six layers

| Layer | Question it answers | Concepts |
| --- | --- | --- |
| 1. Identity | Who is acting, with which keys, in which contexts, and what may others learn? | Person, Wallet, IdentityAssurance, Credential, DisclosurePolicy, Context, Membership |
| 2. Homes | Which home, which terms, who is involved? | Home, Listing, Application, Agreement, Role |
| 3. Custody | Where is the deposit, and who may move it? | Escrow, Operation, Claim, Settlement, Payout |
| 4. Earnings | What does the locked deposit earn? | YieldSource, Earnings, Release |
| 5. Ownership | What do I own and what does it pay me? | Asset, Position, Venue, Distribution, Adapter |
| 6. Vision | Where can this go? | CollateralDeposit, HomeEquityPath, DeviceTokenization |

Each layer builds on the ones below it. For example, an **Earnings Release** (4) requires an active **Escrow** (3), which requires an accepted **Agreement** (2) between verified **People** (1).

## Concept map

```mermaid
flowchart LR
  P[Person] -- has --> W[Wallet]
  P -- plays Role in --> AG[Agreement]
  L[Listing] -- application chosen --> AG
  AG -- secured by --> E[Escrow]
  E -- supplies to --> Y[YieldSource]
  Y -- produces --> EA[Earnings]
  EA -- Release --> C[Cash in own wallet]
  C -- buys at Venue --> S[Security token]
  S -- pays --> D[Distribution]
  E -- move-out Claim --> ST[Settlement] --> PO[Payouts]
  P -- configures --> AD[Adapter]
  AD -- observes --> DEV[Solar / validator / car]
  DEV -- pays --> D
  subgraph Owned[Everything you own]
    C
    S
    LD[Locked deposit]
    DEV
    HS[Home shares]
  end
  E -. tenant's residual claim .-> LD
```

## Money flow of one tenancy

```mermaid
sequenceDiagram
  participant T as Tenant wallet
  participant E as Escrow
  participant Y as Lending
  participant L as Landlord
  T->>E: Deposit (one approval: fund + lend)
  E->>Y: Supply
  Y-->>E: Interest accrues
  E->>T: Claim earnings any time (only above the deposit)
  T->>T: Invest in stocks or home shares, which pay distributions
  L->>E: Move-out: propose deduction (0 allowed)
  T->>E: Agree and settle (or dispute; arbitrator decides)
  E->>T: Payout: deposit minus deduction
  E->>L: Payout: deduction
```

## Rules that must always hold

- **The deposit is protected.** The required security is never released as earnings. Only what it earns can be claimed.
- **Fixed recipients, pull payouts.** Money only goes to each party's canonical account, and a party that breaks its own account blocks only itself.
- **Roles come from agreements.** The "Who are you?" choice in onboarding is a display preference, not a permission.
- **The tenant's portfolio is theirs.** Landlord and arbitrator have no authority beyond the escrow.
- **Adapters are read-only**, and their credentials stay on the server.
- **Privacy by predicates.** Others learn facts ("verified adult, income at least 3× rent"), not documents. No personal data goes on-chain, and identity is never linked to a wallet address on-chain.
- **Everything shown has a reality level** (below). Never present simulated or illustrative values as real.

## How real each part is (2026-09-26)

| Level | Meaning | What is at this level |
| --- | --- | --- |
| Live mainnet | Real assets | Nothing yet |
| Testnet, real | Real execution with test tokens | Accounts and wallets; listings and agreements; Solana escrow (setup, deposit, lending, claims, settlement, payouts); Robinhood escrow; tSPYx and test TSLA purchases |
| Testnet, simulated input | Real execution, one input faked on purpose | Deposit yield (Solana `test_credit_yield`, Robinhood test vault) and therefore earnings claims; tSPYx distributions |
| Read-only live | Real third-party data | Home Assistant solar and savings; Gnosis, Ethereum and Solana validators; SPYx and TSLA reference prices |
| Prototype | Ran in tests or scripts, not an app feature | Stocks as deposit (`CollateralEscrow`); Morpho on a mainnet fork |
| Illustration | Visual only | Home shares and the home-token grid |
| Roadmap | Idea only | Home tokens toward owning a home; EU Digital Identity Wallet; EV adapter; tokenizing device income |

## Journeys

| Person | Steps |
| --- | --- |
| Tenant | Choose role → account → test USDC → browse → apply → accept → secure deposit → **claim earnings any time → invest** → move-out answer → payout |
| Landlord | Choose role → account → post a home → choose applicant → invite arbitrator → accept → create deposit space → propose deduction → payout |
| Arbitrator | Choose role → account → join by invitation → decide a dispute |
| Any owner | Connect adapters → see everything owned |

In each tenancy phase exactly one person has an action; everyone else sees what they are waiting for (`src/server/journey.ts`).

## Where concepts live in code

| Concept | Code |
| --- | --- |
| Person, Wallet | `src/wallets/`, `src/server/authenticated.ts` |
| Listing, Application | `src/server/listings.ts` |
| Agreement, Role | `src/server/agreements.ts` |
| Escrow (Solana) | `programs/rental_escrow/src/` |
| Escrow (Robinhood), CollateralDeposit | `contracts/evm/src/` |
| Operation, Release, Payout | `src/server/solana-service.ts`, `src/server/solana-initialization.ts` |
| Journey (next step per person) | `src/server/journey.ts`, `src/components/home.tsx` |
| Position, Venue, Distribution | `src/server/portfolio.ts`, `src/server/robinhood-demo.ts` |
| Adapter | `src/server/adapters.ts`, `src/components/assets.tsx` |
| Test tooling (never evidence) | `src/server/test-signer.ts`, `src/server/test-helpers.ts`, `scripts/` |

## Open design questions

1. **Name and positioning:** is this a deposit product with a portfolio, or a household-ownership app whose first adapter is the rental deposit?
2. **Home shares:** which issuer or legal wrapper (a Germany-compatible security), and is "down-payment credit" enough for the vision?
3. **Device income:** stay read-only, or pilot selling future solar or validator income (regulatory scope)?
4. **Identity:** EUDI Wallet (adult check and opt-in city are built against the EU test verifier; the current PID has no age flag, so the birth date is read and discarded) versus German eID via a provider. Banks must accept EUDI wallets for onboarding and strong authentication by December 2027. The EUDI framework offers selective disclosure (SD-JWT VC, mdoc) but no zero-knowledge proofs yet; income thresholds without revealing income need them.
5. **Mainnet path:** which network holds the first real deposit, and which yield source and stock venue are eligible there?
