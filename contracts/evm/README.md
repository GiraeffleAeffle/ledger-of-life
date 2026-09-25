# Robinhood rental escrow proof

This is an immutable per-tenancy escrow with a narrow Morpho vault adapter. It implements agreement acceptance, fixed-asset funding, supply-only lending, policy-bounded earnings release, tenant-approved claims, assigned arbitration, and separately executed settlement. The escrow has no operator withdrawal key, upgrade method, arbitrary executor, or authority over a personal portfolio.

All amounts are native atomic integers. USDG uses 6 decimals; the selected Morpho vault uses 18-decimal shares. Claim payments cannot exceed the requested claim or security requirement. A settlement records a minimum total asset value: losses below that floor stop payment until the decision is revisited. Residual earnings return with the tenant's security. Closed escrow donations can only return to the fixed tenant.

## Sponsor-paid rental actions

Both direct native methods and a bounded EIP-712 relay are implemented. The latter allows an unrelated sponsor to pay transaction gas while the tenant, landlord, or assigned arbitrator signs the exact permitted action. EOA signatures enforce low-S and valid V; deployed contract role wallets use ERC-1271. There is no arbitrary target, native value, or call data in a signed action.

Domain: `name=RentalEscrow`, `version=1`, immutable `chainId`, and `verifyingContract=escrow`.

```text
EscrowAction(
  address signer,
  uint8 kind,
  uint256 amount,
  uint256 limit,
  bytes32 evidence,
  uint256 expectedNonce,
  uint256 deadline
)
```

| Kind | Operation | Amount | Limit | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Accept agreement | 0 | 0 | Zero hash |
| 1 | Fund fixed security | 0 | 0 | Zero hash |
| 2 | Supply | Underlying assets | Minimum shares | Zero hash |
| 3 | Release earnings | Underlying assets | Maximum burned shares | Zero hash |
| 4 | Propose claim | Requested assets | 0 | Private evidence digest |
| 5 | Accept claim | 0 | Minimum settlement assets | Zero hash |
| 6 | Contest claim | 0 | 0 | Zero hash |
| 7 | Resolve claim | Landlord award | Minimum settlement assets | Zero hash |
| 8 | Execute settlement | 0 | Minimum assets from redemption | Zero hash |

Every action binds the current global escrow nonce and an expiry. An unsuccessful action reverts its nonce and state. A successful signed action emits both its ordinary financial event and `SignedOperationExecuted`, allowing reconciliation to verify the authorization digest as well as the effect. The sponsor has no independent trading signature.

This is the implemented sponsorship choice; it does not claim working Safe4337, Pimlico, or a configured wallet provider. Initial USDG approval and personal-wallet stock trades/withdrawals require their own supported sponsorship path. A preapproved local test wallet is not proof of gasless consumer onboarding. ERC-1271 support is verified with a local contract-wallet fixture, not an installed Safe.

## Commands

From `contracts/evm`, with Foundry and Solc 0.8.28:

```sh
forge test --offline -vv
forge script script/LocalProof.s.sol:LocalProof --offline --sig 'run()' -vv
```

On a fresh environment, allow Foundry to obtain the pinned compiler before using `--offline`. That flag also avoids an observed Foundry 1.4.4/macOS proxy-detection crash. No containers are needed. The script requires chain 31337 and uses public fixture keys. Without `--broadcast` it executes only in Foundry's local EVM. It returns a test token, mock vault and settled escrow; it is not a Robinhood deployment. To leave an interactive escrow before funding, deploy the contracts from the application deployment tooling rather than presenting this completed script as a new tenancy.

From the repository root:

```sh
node --experimental-strip-types --test src/finance/robinhood/native.test.ts
```

## Verified evidence on September 22, 2026

**25 local contract tests passed**, including 256 fuzz runs for conservation. Coverage includes the 3,000 → 10 earnings → 120 claim → 2,880 security refund scenario; separated personal funds; incorrect roles; claim caps; partial losses; stale nonces; expiry and chain mismatch; share slippage; failed withdrawals; callback reentrancy; EIP-712 tampering; cross-contract replay; malformed/high-S signatures; and ERC-1271 authorization. **14 TypeScript tests and strict typechecking passed** for native plans, typed relay encoding, canonical receipt reconciliation, exact amounts, accumulating exposure, and gated quote validation.

**Two tests also passed against a pinned Robinhood mainnet fork at block 69,829,067.** They executed the actual USDG token and selected Steakhouse USDG vault locally through the new escrow. Source addresses:

- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Morpho vault: `0xBeEff033F34C046626B8D0A041844C5d1A5409dd`.
- SPY metadata/multiplier read: `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`. No stock trade was executed.

| Fork observation | Result |
| --- | ---: |
| Declared local security fixture | 3,000 USDG |
| Cash retained for preview rounding | Determined from same-block deposit/redeem previews |
| Vault shares minted | Reported by the fork test |
| Eligible earnings after **90 days of synthetic time progression** | Reported by the fork test |
| Earnings released | 10 USDG |
| Landlord settlement | 120 USDG |
| Tenant settlement | Includes residual earnings and any retained cash |
| Remaining escrow shares | 0 |

The fork supplies only the exact funded security requirement. It computes a
preview-backed amount that leaves enough USDG idle to preserve the contract's
minimum accounting value; a separate test call confirms that supplying all
available USDG reverts when preview rounding would make security insufficient.
These are local fork results, not realized mainnet returns or a forecast. The
fixture changes the tenant's local token balance and local time; no transaction
is broadcast to Robinhood. Morpho V2's transient per-transaction accrual cache
requires deposit setup and later accrual to execute as separate transactions.
Advancing time within the same Foundry transaction does not reset that cache.

Replay, using an archive-capable RPC if the public endpoint has pruned the block:

```sh
ROBINHOOD_FORK_PROOF=true ROBINHOOD_FORK_BLOCK=69829067 \
  forge test --offline --match-contract RobinhoodForkTest -vv
```

The original research block 69,695,660 was unavailable from the public RPC's historical state during implementation. Default unit runs explicitly skip network fork tests; do not count a skip as an integration pass. Changing the source block requires recording its new evidence. The fork source RPC can be configured with `ROBINHOOD_FORK_RPC`; its default is the official public endpoint.

## Integration boundaries

- Morpho V2 `max*` views return zero. `securityValue` and `releasableEarnings` are accounting bounds, not guaranteed available liquidity. Simulate the exact operation from the correct caller, then reconcile actual asset/share changes. In-kind exits and arbitrary allocator operations are outside this adapter.
- Deployments and dependencies must be reviewed and pinned by the application. A contract address from browser input is not an authorized tenancy. The adapter's read verifies asset/network/vault identity; deployment provenance remains the application's responsibility.
- Signed action fields must be shown to the user before signing. The durable server stores the plan, digest, signature and submitted hash. A timeout remains unresolved until chain observation; it is not permission to resubmit as a new operation.
- The TypeScript stock helper is fail-closed without approved 0x RWA access, a current eligible profile, an enabled instrument, and reviewed route/allowance targets. Quotes still require fresh simulation and a tenant signature. It never signs, submits, fabricates fills, or grants unlimited allowance.
- Robinhood Stock Tokens accumulate exposure using a multiplier. Chainlink prices already include that multiplier; REST underlying-equity prices do not. No second cash dividend is credited.
- No production wallet/provider account, stock purchase, fiat transfer, or production deployment was created here. Provider access, wallet recovery, complete fee sponsorship, actual stock execution/exit and production review remain integration gates.

Primary references: [Robinhood network](https://docs.robinhood.com/chain/connecting/), [stock integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [Morpho integration](https://docs.morpho.org/developers/earn/tutorials/assets-flow/), [Morpho V2 source](https://github.com/morpho-org/vault-v2), and [0x RWA access](https://help.0x.org/articles/5420296643-xstocks-support-on-0x).
