# Idle capital around a home: idea exploration

Status 2026-09-25. These are **product explorations**, not implemented features or legal advice. The common thread: money that renting and owning force people to lock away should keep working for its owner, without weakening the protection it exists for.

## 1. Stocks as the deposit (collateral deposit)

**Idea.** Instead of three months' rent in cash, the tenant pledges tokenized stocks or ETFs to the escrow. The tenant keeps price gains and distributions; the landlord is protected by over-collateralization.

**Mechanics.**
- Required collateral value = deposit × safety factor, e.g. 150% for a broad ETF, more for single stocks.
- A price oracle (Chainlink on Robinhood Chain; Pyth on Solana) values the collateral.
- Below a maintenance level (e.g. 125%), the tenant has a grace period to top up with more stock or cash. After that, the escrow sells just enough collateral into stablecoin to restore the cash-equivalent deposit.
- At move-out, the approved claim is paid from collateral: stablecoin first, then collateral sold at oracle price with a slippage bound. The rest returns to the tenant **in kind** (their shares, not cash).

**Why it's attractive.** For a tenant with savings already invested, it avoids selling and re-buying (taxes, fees, missed growth). For the pitch: "your deposit is your portfolio".

**Risks and open points.**
- **Price risk:** the landlord carries gap risk (a crash between oracle updates), so the safety factor and a partial-cash minimum matter.
- **Liquidity:** stock tokens trade 24/7 only on some venues; forced sales need a reliable route.
- **Law:** §551 BGB fixes cash deposits at three months' rent and requires them to be kept apart from the landlord's money. Other securities are allowed by agreement, but the landlord must accept them and the valuation rules, and the three-month cap should be checked against the collateral amount.
- **Eligibility:** xStocks and Robinhood Stock Tokens are not available to US persons and have issuer terms.

**Feasibility here.**
- **Robinhood Chain testnet:** high. The official testnet TSLA/AMZN tokens exist, and our `TestStockDesk` can act as the sale route. A Chainlink feed would need to be confirmed on testnet, or mocked with a clearly labelled test oracle.
- **Solana devnet:** medium. `tSPYx` exists, but it needs an oracle integration in the Anchor program.

**Prototype (done, unreviewed):** [`CollateralEscrow.sol`](../contracts/evm/src/CollateralEscrow.sol) implements pledge at an initial ratio, excess withdrawal, permissionless shortfall flag, grace period, forced sale of only what is needed with an oracle-bounded slippage limit, the claim/dispute/arbitrator flow, and settlement that pays the landlord in cash and returns the rest in kind. There are 7 forge tests in `test/CollateralEscrow.t.sol`.

It also ran live on Robinhood Chain testnet (`script/CollateralTestnetCycle.s.sol`, 14 transactions, all succeeded, escrow `0xb04bCbA7D89631E5Ca33B8152B8b346Cc8F08229`):
- A $10 deposit was secured by 0.0403 **official test TSLA** (150%).
- A test 25% price drop triggered a shortfall, which the tenant cured with 0.0081 TSLA.
- A $2 claim was paid to the landlord by selling 0.0072 TSLA.
- 0.0412 TSLA returned to the tenant.

The price oracle and sale desk are our test contracts (`TestPriceOracle`, `TestStockDesk`), not Chainlink or a real venue.

## 2. Borrowing against stocks to pay the deposit

**Idea.** A tenant with investments borrows stablecoin against them (Morpho, Kamino) and uses the loan as a normal cash deposit.

**Assessment.** It works with existing protocols today, and the deposit escrow does not change, because the landlord just sees cash. It does add borrowing interest (usually higher than the deposit's lending yield, so the net is negative) and liquidation risk exactly when moving house is expensive. Idea 1 is strictly simpler for the tenant. **Verdict:** mention it as an option; don't build it first.

## 3. Collect home tokens monthly, swap them for a whole home

**Idea.** Each month part of rent, savings or deposit earnings buys fractional tokens of real homes. The tokens pay a share of rental income. Once someone holds tokens worth a whole unit, they can exchange them for that unit (rent-to-own, one token at a time).

**Mechanics that exist today.** Tokenized real estate is usually one legal entity (SPV/GmbH) per property, with tokens as shares or debt-like claims. Platforms such as RealT, Lofty or Brickken distribute rental income on-chain.

**The hard part is the swap for a whole home.** Converting tokens into direct ownership means buying out every other token holder of that property and transferring the land title (in Germany: notarized purchase contract, land register entry, real-estate transfer tax of 3.5–6.5%). That's workable as an **option** ("tokens count as down-payment credit when you buy through us"), not as an automatic on-chain swap.

**A realistic version.**
- Tokens across many homes form an index-like "home fund" that pays monthly income.
- The tenant can use the fund value as equity for a mortgage, or redeem it at NAV.
- Optional: tokens of the flat you rent give you a right of first refusal.

**Verdict:** strong story, heavy legal/operational build. For the hackathon, keep it as the visual (the token-grid card) plus a clear roadmap slide.

## 4. Other money that just sits there

| Idle money | Typical size | Same escrow pattern? | Notes |
| --- | --- | --- | --- |
| Rental deposit | 3 × net rent | Yes (this product) | Largest pool for renters |
| Service-charge prepayments (Nebenkosten) | 1–3 months ahead | Yes, short-term | Settled yearly, could earn in lending until then |
| Owners' maintenance reserve (Instandhaltungsrücklage) | Often tens of thousands per building | Yes, multi-party | Owners' association; governance by vote, very conservative |
| Purchase escrow (Notaranderkonto) | Full purchase price, weeks | Partly | Short, regulated; yield small but amounts huge |
| Car/equipment/student-housing deposits | €500–€5,000 | Yes | Same mechanics, different counterparties |
| Rent guarantee / bank guarantee (Mietbürgschaft) | Replaces deposit | Alternative | Tenant pays a fee; collateral deposit (idea 1) competes with it |

**Verdict:** the escrow core (fixed parties, bounded claims, arbitrator, pull payouts, supply-only lending) generalizes to all rows except the purchase escrow. Service-charge prepayments are the easiest second use case, with the same landlord relationship and yearly settlement.

## Recommendation

1. Idea 1 is prototyped on Robinhood testnet. Next: a real oracle (Chainlink), a Solana port, and a landlord-facing risk explanation.
2. Pitch ideas 3 and 4 as the roadmap ("every euro that has to wait should work for its owner").
3. Skip idea 2 as a feature.
