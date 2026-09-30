# Documentation

Start with the [roadmap](ROADMAP.md) for where the project stands and what is next, then [implementation status](IMPLEMENTATION_STATUS.md) for what exists and what remains unproved, then [validation](VALIDATION.md) for reproducible evidence.

| Document                                                            | Purpose                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Roadmap](ROADMAP.md)                                               | Where we are, the ordered frontier and the decisions only the owner can make |
| [Deployment](DEPLOYMENT.md)                                         | The container image, what it needs at run time, the scheduler and the private GPU path |
| [Ledger of Life plan](LEDGER_OF_LIFE_PLAN.md)                       | Demo story, planned-feature triage and approved UX composition        |
| [Home journey](HOME_JOURNEY.md)                                     | The Solana rental flow, one next step per role                        |
| [Validation](VALIDATION.md)                                         | Reproducible checks, evidence and known toolchain limits              |
| [Test-signer mode](TEST_SIGNER_MODE.md)                             | Running a whole tenancy with operator-held test keys (never evidence) |
| [Build spec](HACKATHON_BUILD_SPEC.md)                               | Product behavior, acceptance scenario and scope                       |
| [Ledger of Life](LEDGER_OF_LIFE.md)                                 | The product idea, the six areas and the adapter choices               |
| [Information architecture](INFORMATION_ARCHITECTURE.md)             | Where each feature lives, and how to place a new one                  |
| [Product ontology](ONTOLOGY.md)                                     | Concepts, invariants and reality levels; machine-readable in `ontology.yaml` |
| [Domain glossary](../CONTEXT.md)                                    | Shared meanings for security, earnings, claims and personal assets    |
| [Architecture decisions](adr/README.md)                             | Durable choices, alternatives and consequences                        |
| [Shared parallel plan](PARALLEL_STACK_EXPLORATION_2026-09-22.md)    | Independent chain adapters and comparison criteria                    |
| [Robinhood stack report](ROBINHOOD_STACK_EXPLORATION_2026-09-22.md) | Dated protocol research and native proof gates                        |
| [Solana stack report](SOLANA_STACK_EXPLORATION_2026-09-22.md)       | Dated program, wallet and investment research                         |
| [Wallet setup](WALLET_SETUP.md)                                     | Privy activation, recovery and developer-account handoff              |
| [Robinhood native API](ROBINHOOD_NATIVE_API.md)                     | Verified deployment configuration, authorization and receipt recovery |
| [Solana native API](SOLANA_NATIVE_API.md)                           | Test manifest, fee payer, signing and receipt recovery                |
| [Solana devnet rehearsal](SOLANA_DEVNET_REHEARSAL.md)               | Finalized operator-key escrow cycle, deployment evidence and next app handoff |

The dated reports retain research observations and desired acceptance gates. The implementation status owns current completion claims. The older `IMPLEMENTATION_PLAN.md` and `MARKET_AND_CHAIN_DECISION.md` describe the initial prototype exploration and do not supersede the parallel build spec.
