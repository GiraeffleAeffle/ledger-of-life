# What your shares can do · test-network workflow

The signed-in tenant uses **their own Privy EVM wallet** on Robinhood Chain testnet. The landlord and a test lending-pool funder are played by operator-held **test** keys. All USD and TSLA figures are test-token amounts at an **operator-set simulated test price**; they are not money or live stock prices. No Solana assets are bridged.

```mermaid
sequenceDiagram
  actor T as Tenant (signed-in wallet)
  actor O as Test operator (faucet and simulated yield)
  participant E as Test rental earnings escrow
  participant D as Test stock desk
  participant C as New collateral tenancy
  actor L as Landlord (test actor)
  O->>T: Mint test USD for the new earnings deposit
  L->>E: Accept signed-in tenant's new test agreement
  T->>E: Sign acceptance, funding, and test-vault supply
  O->>E: Contribute simulated test yield to vault
  T->>E: Sign earnings claim
  E-->>T: Release test USD earnings to own wallet
  T->>D: Sign test USD approval and buy official test TSLA
  L->>C: Accept a new test tenancy backed by the tenant's TSLA
  T->>C: Sign TSLA approval + pledge shares (150% of new deposit)
  Note over C,L: Test price falls 30%: flag shortfall; tenant can top up, or after grace sell only enough for cash security
  L->>C: Propose move-out claim
  T->>C: Accept claim
  C->>D: Sell only shares needed to pay approved claim
  C-->>L: Test USD claim
  C-->>T: Unused TSLA shares, in kind (plus surplus test USD)
```

```mermaid
sequenceDiagram
  actor T as Tenant (signed-in wallet)
  participant P as Test lending pool
  actor F as Test funder (operator key)
  F->>P: Supply test USD liquidity
  T->>P: Approve and deposit official test TSLA
  T->>P: Borrow test USD at <=50% of simulated collateral value
  P-->>T: Test USD; debt accrues simple interest by elapsed seconds
  Note over T,P: Test price falls 30%: LTV/health update; add shares or repay
  F->>P: Liquidate only if debt reaches 80% of collateral value
  T->>P: Repay principal + accrued interest
  P-->>T: Remaining shares returned when debt is zero
```

| What the person sees | On-chain execution | Test-only input/actor |
| --- | --- | --- |
| “Earn”: tenant signs a new test tenancy, funds its deposit with operator-faucet test USD, supplies it to the test vault and signs the simulated-yield claim into their own wallet. | Rental escrow, vault and ERC-20 transfers, with the signed-in tenant as the escrow tenant. | Operator landlord accepts; operator funds the test-USD faucet and injects simulated yield. This earnings tenancy is separate from the later share-backed tenancy. |
| “Buy”: approve test USD and buy official test TSLA with their own wallet signature. | ERC-20 allowance and test stock desk swap. | Desk quote and test USD liquidity are synthetic. |
| “Secure a new deposit”: see required shares, sign approval and pledge; landlord accepts. | New `CollateralEscrow` per wallet, 150% opening / 125% maintenance, on-chain stock custody. | Operator acts as landlord and arbitrator; per-wallet oracle + sale desk set the simulated price. This new tenancy is separate from the earnings tenancy. |
| Price falls: see new value, buffer and top-up request; choose to sign top-up, or let grace pass and trigger partial protective sale. | `flagShortfall`, `pledge`, `liquidate`. | Price and sale quote both change in the isolated test market. Grace period is real chain time. |
| Move out: proposed claim, tenant signs acceptance; the claim is paid, unused shares returned. | `proposeClaim`, `acceptClaim`, `settle`; only approved amount is sold. | Landlord proposes a small sample test claim. |
| “Borrow”: see max available, interest rate, debt, LTV, health and liquidation threshold; sign pledge and borrow; later add shares, repay and withdraw remaining shares. | Per-wallet `TestLendingPool`: collateral transfers, test USD debt/transfers and liquidation. | Operator supplies liquidity and, if unhealthy, calls liquidation. Price is shared with this wallet's collateral tenancy, never a live exchange feed. |

A real implementation would use the same consent and transaction boundaries with a signed tenancy specifying eligible assets and valuation rules, independent price sources and executable liquidity, an independently funded lending venue, and wallet-signed tenant actions. Test actors and the simulated price/yield would be replaced by actual parties and verifiable inputs; neither test dollars nor test TSLA would become a redeemable asset by doing so.

## Executed testnet proof

The operator script `contracts/evm/script/share-workflows-cycle.mjs` exercised a wallet-signed test earnings agreement → signed deposit funding/vault supply → operator-contributed simulated yield → tenant-signed claim → signed test-USD/official-test-TSLA buy → 150% share pledge → 30% test-price drop and signed top-up → move-out claim and in-kind return → signed loan/collateral → 60% test-price drop, liquidation, repayment and share withdrawal. [Deployment addresses, transaction hashes and final balances](evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json) come from an ephemeral scripted test wallet, **not** from a Privy session. The same actions were then exercised with a signed-in browser wallet; screenshots are local test artifacts in `/tmp/share-shots/`.

To repeat locally: compile Foundry contracts with `cd contracts/evm && forge build`, then from the repository root run `SOLANA_TEST_SIGNER_MODE=1 node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/share-workflows-cycle.mjs`. The operator test capability and the ignored `.testnet-secrets/robinhood-testnet/` key files must already be configured; neither the script nor the evidence prints keys. This creates fresh isolated test contracts and replaces the evidence file with the new run.
