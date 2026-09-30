# Rental security and tenant asset building

This context describes the rental security shared by a tenant and landlord, and the tenant's separate accumulation of personal assets while renting. It also names the parts of the Ledger of Life workspace, so the interface, the code and the docs use the same words.

## Language

### People and the rental relationship

**Tenant**:
The person whose rental obligations the deposit secures and whose personal assets remain independent of that security.
_Avoid_: Investor when referring to the person's tenancy role.

**Landlord**:
The party entitled to request deductions for obligations covered by the tenancy agreement, subject to its claim and settlement rules.

**Arbitrator**:
The person assigned to resolve a particular disputed claim within the agreed authority and amount limits.
_Avoid_: Administrator, portfolio manager.

**Tenancy**:
The rental relationship between identified parties, including its security obligation, agreement, evidence and settlement.
_Avoid_: Account, wallet.

**Accepted agreement**:
The fixed tenancy terms that both tenant and landlord have accepted, including required security and the earnings release policy. Acceptance alone does not transfer or lock the tenant's money.
_Avoid_: Funded tenancy, completed deposit.

**Prepared escrow**:
A custody arrangement bound to an accepted agreement that holds no rental security until the tenant funds it.
_Avoid_: Active deposit, funded security.

### Rental security and earnings

**Deposit principal**:
The tenant's funded rental security, excluding earnings and separate personal savings.
_Avoid_: Investment portfolio, spendable balance.

**Required security**:
The amount that must remain available to secure the tenancy's remaining obligations under the applicable agreement.
_Avoid_: Current asset value; the obligation and the assets covering it are different amounts.

**Deposit assets**:
The cash and lending interests held to cover rental security and retained deposit earnings.
_Avoid_: Personal portfolio.

**Deposit earnings**:
Income attributable to the funded deposit, distinct from returning principal and from permission to release that income.
_Avoid_: Available cash, guaranteed return.

**Earnings release policy**:
The agreed conditions determining whether, when and how much deposit earnings may leave the rental security.
_Avoid_: Interest ownership; entitlement to earnings alone does not determine release timing.

**Retained earnings**:
Deposit earnings that remain part of the tenancy's deposit assets.
_Avoid_: Withdrawable earnings.

**Redeemable value**:
The conservatively assessed amount of the deposit denomination obtainable from deposit assets under current redemption conditions.
_Avoid_: Nominal value, total supplied assets, quoted APR.

**Releasable earnings**:
The portion of earnings permitted for release by the policy, remaining security obligation, existing commitments and current redemption capacity.
_Avoid_: Total earnings, immediately available personal cash.

**Released earnings**:
Earnings whose transfer out of rental security into the tenant's personal ownership has completed.
_Avoid_: Pending release, accrued interest.

**Deposit shortfall**:
The amount by which deposit assets fail to cover required security and any separately committed amounts.

### Personal asset building

**Personal cash**:
The tenant's settled cash outside rental security, including released earnings, voluntary contributions and settled sale proceeds; committed amounts are unavailable for another use.
_Avoid_: Deposit balance, investment value.

**Personal portfolio**:
The tenant's personal cash and investment holdings, which remain theirs independently of tenancy closure.
_Avoid_: Landlord deposit total, rental security.

**Personal contribution**:
Money the tenant voluntarily adds to the personal portfolio independently of deposit earnings.
_Avoid_: Deposit funding, earned return.

**Investment holding**:
The tenant's settled position in a particular investment instrument, with the rights and restrictions of that instrument.
_Avoid_: Cash, direct property ownership unless those rights actually exist.

**Cash distribution**:
An investment payment actually credited as personal cash.
_Avoid_: Accumulating return.

**Accumulating return**:
An investment return retained within the holding or its represented exposure, without a separate cash payment to the tenant.
_Avoid_: Cash dividend received.

### Claims and completion

**Claim**:
A landlord's requested deduction from rental security, with an amount and supporting reason or evidence.
_Avoid_: Approved deduction, completed payment.

**Dispute**:
A contested claim awaiting resolution under the tenancy's agreed process.

**Settlement allocation**:
The agreed or validly arbitrated amounts assigned to the recorded recipients from remaining deposit assets.
_Avoid_: Payout receipt.

**Settlement**:
The completion of the authorized allocation of remaining deposit assets, including the landlord's approved deduction and the tenant's remainder.
_Avoid_: Decision recorded, transaction submitted.

**Personal cash withdrawal**:
A transfer of settled, uncommitted personal cash to the tenant's permitted destination.
_Avoid_: Earnings release, investment sale; those are separate actions.

### The workspace

**Area**:
One of the six places in the signed-in app (Today, Me, Home, Money, Places, Ideas). Each answers one question, and a feature is operated in exactly one area.
_Avoid_: Page, module, tab.

**Feature home**:
The one area, and the section inside it, where a person operates a feature. Every other area shows a reference to it.
_Avoid_: Owner, canonical page.

**Reference**:
One line and one link, in an area that is not a feature's home, pointing to that home. It never repeats a control, a calculator or a promotion.
_Avoid_: Teaser, shortcut, duplicate.

**Topic**:
A subject that groups capabilities and adapters for browsing: Identity & life, Home & living, Money & ownership, Energy & devices, Places & participation. A topic is not an area, and its subject can be operated in a different area.
_Avoid_: Section, category.

**Adapter**:
One way something enters the person's ledger: a wallet, a contract, a device, a public data source, or a roadmap idea. It states what it brings, reads, keeps, who can see it, what it needs and how to disconnect.
_Avoid_: Integration, plugin. A connector is the operator-side mechanism a hosted adapter may need.

**Capability**:
A feature of the product with a build status (planned, prototype, partly built, illustration, built), independent of which adapter supplies it.
_Avoid_: Idea, except as the name of the Ideas area.

**Reality level**:
How real something is: test-network execution, simulated input, live read-only data, on this device, your own statement, prototype, illustration or roadmap. Everything shown states one.
_Avoid_: Maturity. A capability's build status is not how real it is.

**Device reading**:
A live, read-only observation of something the person runs, such as home solar or a validator. It is outside the priced subtotal.
_Avoid_: Asset, holding.

**Local stake**:
A fictional test unit of a housing project or a workshop, bought with test cash. It grants no company, cooperative or property right.
_Avoid_: Investment, share, equity, home ownership.

**Priced test-asset subtotal**:
What the person holds in test assets that have a price, shown as four parts that add up to it: free to use, locked in the rental deposit, pledged as collateral, minus what is owed. The deposit is a locked part of it: counted, never spendable, never described as an investment. Local stakes and validator stake are outside it.
_Avoid_: Net worth, portfolio value, balance (a balance is spendable; the subtotal is not).
