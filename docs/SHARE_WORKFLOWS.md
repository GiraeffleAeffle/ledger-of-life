# What your shares can do · test-network workflow

The signed-in tenant uses **their own Privy EVM wallet** on Robinhood Chain testnet. The landlord and a test lending-pool funder are operator-held **test** keys. The demo stock is **tTSLA · fake test stock**, deployed and mintable for each wallet's isolated test market; it is *not* Robinhood's separately displayed official test TSLA. Test USD is freely minted. All USD and stock valuations use an **operator-set simulated test price**; none is money or a live stock price. No Solana assets are bridged.

```mermaid
sequenceDiagram
  actor T as Tenant (signed-in wallet)
  actor O as Test operator (faucet and simulated yield)
  participant E as Separate $1,500 test rental escrow
  participant V as Dedicated test yield vault
  participant D as Fake tTSLA test desk
  participant C as New collateral tenancy
  actor L as Landlord (test actor)
  O->>T: Prepare demo position: mint $1,501 for deposit + $3,540 purchase faucet
  O->>D: Deploy mintable fake tTSLA and fund desk/pool with test liquidity
  L->>E: Accept signed-in tenant's $1,500 test agreement (3 × $500 rent)
  T->>E: Sign acceptance and funding
  T->>E: Sign vault supply into dedicated vault V
  O->>V: Contribute $60.50 simulated test yield
  T->>E: Sign claim of about $60
  E-->>T: Release test USD earnings to own wallet
  T->>D: Sign test USD approval and buy about $3,600 fake tTSLA
  L->>C: Accept a new test tenancy backed by the tenant's fake tTSLA
  T->>C: Sign fake tTSLA approval + pledge $1,800 shares (150% of ~$1,200 deposit)
  Note over C,L: Test price falls 30%: flag shortfall; tenant can top up, or after grace sell only enough for cash security
  L->>C: Propose move-out claim
  T->>C: Accept claim
  C->>D: Sell only fake shares needed to pay approved claim
  C-->>L: Test USD claim
  C-->>T: Unused fake tTSLA shares, in kind (plus surplus test USD)
```

```mermaid
sequenceDiagram
  actor T as Tenant (signed-in wallet)
  participant P as Test lending pool
  actor F as Test funder (operator key)
  F->>P: Supply test USD liquidity
  T->>P: Approve and deposit fake tTSLA
  T->>P: Borrow test USD at <=50% of simulated collateral value
  P-->>T: Test USD; debt accrues simple interest by elapsed seconds
  Note over T,P: Test price falls 30%: LTV/health update; add shares or repay
  F->>P: Liquidate only if debt reaches 80% of collateral value
  T->>P: Repay principal + accrued interest
  P-->>T: Remaining shares returned when debt is zero
```

| What the person sees | On-chain execution | Test-only input/actor |
| --- | --- | --- |
| “Prepare a demo position”: operator deploys a dedicated vault and isolated fake tTSLA market, test landlord accepts a $1,500 (3 × $500) earnings deposit, test faucet supplies $1,501 for security/reserve and **$3,540 test USD to buy fake stock**. The tenant signs acceptance, funding, vault supply, and then claims about $60 of simulated earnings. | Separate `RentalEscrow`, `TestYieldVault`, fake tTSLA desk, test USD transfers and wallet-signed calls. Up to three operator-contributed test yields per wallet per UTC day, claiming each before the next. | $3,540 is explicitly a faucet purchase budget, **not earnings**; the $60.50 operator contribution creates about $60 claimable test yield in the dedicated vault. Earlier $10 test escrows remain at their recorded chain addresses. |
| “Buy”: approve test USD and purchase around $3,600 of per-wallet tTSLA · fake test stock with the tenant wallet; the official test TSLA holding above is unchanged. | ERC-20 allowance and isolated test desk swap. | Fake stock supply, desk quote and liquidity are synthetic. |
| “Secure a new deposit”: see required shares, sign approval and pledge; landlord accepts. | New `CollateralEscrow` per wallet, 150% opening / 125% maintenance, fake-stock custody. | Operator acts as landlord and arbitrator; per-wallet oracle + sale desk set the simulated price. This new tenancy is separate from the $1,500 earnings tenancy. |
| Price falls: see new value, buffer and top-up request; choose to sign top-up, or let grace pass and trigger partial protective sale. | `flagShortfall`, `pledge`, `liquidate`. | Price and sale quote both change in the isolated test market. Grace period is real chain time. |
| Move out: proposed claim, tenant signs acceptance; the claim is paid, unused shares returned. | `proposeClaim`, `acceptClaim`, `settle`; only approved amount is sold. | Landlord proposes a small sample test claim. |
| “Borrow”: see max available, interest rate, debt, LTV, health and liquidation threshold; sign pledge and borrow; later add shares, repay and withdraw remaining fake shares. | Per-wallet `TestLendingPool`: collateral transfers, test USD debt/transfers and liquidation. | Operator supplies $8,000 test USD liquidity and, if unhealthy, calls liquidation. Test price is shared only with this wallet's collateral tenancy. |

A non-test implementation would use the same consent and transaction boundaries with eligible assets and valuation rules specified in the tenancy, independent price sources and executable liquidity, an independently funded lending venue, and wallet-signed tenant actions. The fake tTSLA faucet, test USD, simulated yield and operator-set quote would be replaced by verifiable inputs and actual parties; none of these test tokens is redeemable.

## Executed testnet proof

The operator script `contracts/evm/script/share-workflows-cycle.mjs` executes the $1,500 test escrow and dedicated vault → ~$60 personally signed yield claim → $3,540 purchase faucet plus yield, signed ~$3,600 fake-stock buy → 150% share pledge for ~$1,200 deposit → 30% test-price drop and signed top-up → move-out claim and in-kind return → signed loan/collateral → 60% test-price drop, liquidation, repayment and fake-share withdrawal. It then signs two more yield claims and confirms a fourth simulated yield on the same UTC day is blocked. [Deployment addresses, transaction hashes and final balances](evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json) come from an ephemeral scripted test wallet, **not** from a Privy session. Signed-in browser checks and responsive screenshots are local artifacts in `/tmp/share-shots/`.

To repeat locally: compile Foundry contracts with `cd contracts/evm && forge build`, then from the repository root run `SOLANA_TEST_SIGNER_MODE=1 node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/share-workflows-cycle.mjs`. The operator test capability and the ignored `.testnet-secrets/robinhood-testnet/` key files must already be configured; neither the script nor the evidence prints keys. This creates fresh isolated test contracts and replaces the evidence file with the new run.
