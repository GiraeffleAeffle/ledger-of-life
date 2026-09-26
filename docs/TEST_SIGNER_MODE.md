# Test-signer mode (devnet, no passkeys)

Runs a complete Solana tenancy cycle without Privy passkey prompts. Three operator-held test keys act as tenant, landlord and arbitrator. Every step goes through the same agreement, staged-initialization and operation services as the app: prepare → sign the exact prepared bytes → sponsor signature and persisted broadcast → finalized reconciliation. Only the wallet signature is produced locally.

**These runs are fixtures. They are not Privy, wallet or user evidence** and must never be cited as such.

```sh
npm run test-signer -- new            # dry run: records a test agreement, simulates payout-account setup
npm run test-signer -- new --send     # creates payout accounts and funds the test tenant (10 test USDC)
npm run test-signer -- status         # phase, balances and the next step
npm run test-signer -- next --send    # performs exactly one next step
npm run test-signer -- run --send     # runs every remaining step until paid out
# Move-out variants: --claim=ATOMIC (default 0) and --dispute (routes to the arbitrator)
```

Without `--send`, nothing is signed or broadcast.

## Guards

- `SOLANA_TEST_SIGNER_MODE=1` is required (the npm script sets it). The flag has no effect on the web app.
- Only the local SQLite database. Only devnet or localnet, and never the mainnet genesis hash.
- Only agreements whose three parties all use `test-signer:` subjects. Real Privy tenancies, including the closed staged and active joint devnet tenancies, cannot be driven.
- The Privy recovery gate is replaced only inside this CLI's service instances. The production service factories are unchanged.
- The test tenancy uses its own manifest from `.testnet-secrets/test-signer/state.json`. The app's `SOLANA_DEPLOYMENT_MANIFEST` is not modified.

## Funding

The sponsor pays fees and rent. The test tenant needs 10 devnet test USDC. `new --send` tries the pinned operator faucet account first. If that account is empty, the command prints the test tenant's wallet address. Request 10 USDC for that address at [Circle's faucet](https://faucet.circle.com/) (Solana devnet), then run `run --send`.

Keys and state live in the ignored `.testnet-secrets/test-signer/` directory (mode 0600).

## Investment rail

`scripts/solana-test-market.mjs` adds the portfolio half on devnet: a Token-2022 copy of SPYx (`tSPYx`, no value) with the xStocks scaled-UI-amount mechanism, an atomic buy/sell against a test market maker at the live mainnet SPYx reference price, and test distributions through multiplier updates. The Robinhood testnet equivalent is `scripts/robinhood-testnet-cycle.mjs`. See the [testnet comparison](TESTNET_STACK_COMPARISON.md).

## Operator test capability

Test-only actions (test helpers, simulated yield, Robinhood test earn, test-market purchases) share one server-side check, `operatorTestCapability` in `src/server/test-capability.ts`. Request hostnames are not trusted. The capability is off on Vercel, off when `NODE_ENV=production` unless `ALLOW_OPERATOR_TEST_ACTIONS=1`, and otherwise follows the test-signer rules (`SOLANA_TEST_SIGNER_MODE=1`, local store). Robinhood test earn runs once per wallet. Test-market purchases keep the market maker's signature on the server until the exact quote is checked, simulated and a per-account budget (five attempts) is reserved; a purchase that times out stays pending and reconciles by signature instead of allowing a second buy.
