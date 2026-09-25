# Testnet comparison: Solana devnet vs Robinhood Chain testnet

Status 2026-09-25. Both stacks are driven by operator-held **test keys** (no passkeys). Every result below is test-token evidence, not Privy/wallet evidence and not a statement about real yield or securities.

| Journey step | Solana devnet | Robinhood Chain testnet (46630) |
| --- | --- | --- |
| Deposit asset | Circle devnet test USDC | `tUSDG`, our test token: the official USDG contract does not exist on testnet |
| Custody | Our Anchor escrow, [pull-v2 program](evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json). Full cycle **finalized**, including two independent payouts | `RentalEscrow.sol`. Full cycle **broadcast on testnet**: 22 transactions, all succeeded (escrow `0x1bB3C9D24f52809F39dE09C582F4359A8162316f`, final settle tx `0xfa17bb24…5b60`) |
| Lending | Real Kamino devnet reserve through CPI | `TestYieldVault`, a minimal share vault standing in for Morpho, which has no testnet deployment |
| Yield | **None**: the devnet reserve has 0 borrowed of ~236 USDC, so the supply rate is 0% | Test yield: the operator moves 0.5 tUSDG into the vault, which raises the escrow's share value |
| Earnings release | Implemented and SVM-tested; **not executable on devnet** because there is no surplus | **Executed on testnet**: 0.5 tUSDG released to the tenant's wallet |
| Stock asset | `tSPYx`, our Token-2022 copy using the xStocks ScaledUiAmount mechanism (mint `2bD1ng5P3CT2HUAjiZ8TTNczVPiJSZL9RF8CuiXbLASJ`) | Robinhood's **official testnet TSLA Stock Token** from the faucet |
| Buying | One atomic transaction co-signed by tenant and test market maker at the live mainnet SPYx price (Jupiter). **Finalized**: 5 test USDC → 0.00648581 tSPYx | `TestStockDesk` contract selling faucet TSLA at the live mainnet TSLAx reference price. **On testnet**: 0.5 tUSDG → 0.00134192 official test TSLA (desk `0x239213413AC090e7D7d9B0647A8d2197614710c4`) |
| Dividends / corporate actions | Multiplier update on our copy. **Finalized**: +0.5%, same raw units, displayed shares 0.0065182 | Official token `uiMultiplier` = 1.0, controlled by Robinhood; we can read it but not simulate a distribution |
| Move-out | 2-USDC claim → accept → settle → payout 8 / payout 2, **finalized** | 2-tUSDG claim → accept → settle; on testnet 2 went to the landlord and 8.01 to the tenant; the escrow ended empty (state Closed, nonce 8) |
| Cost | Fee sponsor ~0.003 SOL per rent-creating step, far less per plain action | ~0.00015 test ETH for the whole cycle, including deployments |

## What each side proves best

- **Solana**: real protocol integration (Kamino CPI), deployed custody fixes and a real xStock-style corporate-action mechanism. Weakness: devnet has no borrowing, so the "earn" step cannot be shown.
- **Robinhood**: the complete earn → release → buy story in one run, with an official testnet Stock Token. Weakness: the vault, stablecoin and desk are our test contracts, not Morpho, USDG or a real exchange.

## Reproduce

```sh
# Solana custody cycle (see TEST_SIGNER_MODE.md)
npm run test-signer -- new --send && npm run test-signer -- run --send --claim=2000000
# Solana investment rail
node --env-file-if-exists=.env.local --experimental-strip-types scripts/solana-test-market.mjs status
#   ... buy 5000000 --send | dividend 50 --send | sell RAW --send
# Robinhood testnet cycle (needs faucet ETH + TSLA on the operator key)
node scripts/robinhood-testnet-cycle.mjs          # simulation against live testnet
node scripts/robinhood-testnet-cycle.mjs --send   # broadcast
```

Making Solana yield visible would require real utilization of the devnet reserve, for example by borrowing from it against collateral in another reserve. That is not done.
