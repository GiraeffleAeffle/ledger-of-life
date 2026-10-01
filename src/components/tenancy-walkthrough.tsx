import { goToSection, type Area } from './areas';
import './tenancy-walkthrough.css';

/**
 * The answer to "can I hold the deposit with shares, or lend it?", visible without opening anything.
 * Cash and shares are available here; lending requires a local rehearsal. Nothing here signs.
 */
export function DepositIdeas({ go }: { go?: (area: Area) => void }) {
  return (
    <section className="card deposit-ideas-card" id="deposit-options" tabIndex={-1} aria-labelledby="deposit-options-title">
      <h2 id="deposit-options-title">Ways to hold the deposit</h2>
      <dl className="deposit-ideas">
        <div><dt>Test USDC deposit <span className="deposit-availability available">Available on this site</span></dt>
          <dd>The tenant locks the home&apos;s deposit in test USDC (tUSDC, minted by this site for tests, no value) in a Solana devnet escrow. It stays as cash, not lent. This site pays labelled simulated yield at 5 % a year by default; earnings belong to the tenant. At move-out the deposit comes back, minus any agreed or decided deduction.</dd></div>
        <div><dt>Deposit lent out to earn <span className="deposit-availability">Needs a local setup</span></dt>
          <dd>Earning on a deposit runs only in a local rehearsal, where it is lent to the shared loan pool for test dollars. Older tenancies here that use Circle&apos;s devnet USDC are lent on Solana devnet, which pays nothing. Earnings on a rental deposit belong to the tenant.</dd></div>
        <div><dt>Share-backed deposit <span className="deposit-availability available">Available on this site</span></dt>
          <dd>Choose &ldquo;Shares · test TSLA&rdquo; when publishing a home. The tenant locks official test TSLA worth 150 % of the USD deposit in an escrow on Robinhood Chain testnet. Settlement is in TSLA, with no forced sale. The first three-party run on this site is pending.
            {go && <> <button type="button" className="text-button" onClick={() => goToSection(go, 'home', 'home-options')}>Choose the deposit when publishing →</button></>}</dd></div>
      </dl>
    </section>
  );
}

export function TenancyWalkthrough({ testTools }: { testTools: boolean }) {
  return (
    <details className="card tenancy-walkthrough">
      <summary>How it works</summary>
      <div className="tenancy-walkthrough-body">
        <p>The landlord chooses a tenant and invites a neutral arbitrator. Choosing creates an agreement and cannot be undone here. Tenant and landlord accept the same deposit terms; these do not cover monthly rent or tenancy dates.</p>
        <p>To secure the deposit, the landlord prepares an empty escrow, then the tenant funds it. At move-out, the landlord proposes a deduction with a reason; the tenant agrees or disputes it. Only a dispute needs the arbitrator, whose decision cannot exceed the proposed deduction.</p>
        <p>The tenant keeps deposit assets above an approved deduction at settlement. Site-minted tUSDC stays as cash, not lent; this site separately pays labelled simulated yield in tUSDC (5 % a year by default), accruing from confirmed funding until settlement. The agreement determines whether yield can be claimed during the tenancy or only after settlement. Any deposit earnings belong to the tenant; test tokens have no value.</p>
        <p>Deposit options are listed under &ldquo;Ways to hold the deposit&rdquo; above.</p>
        <p className="small-copy">Payouts go to each party’s own wallet. Keep Home open during payout; failed attempts retry here.</p>
        {testTools && <p className="small-copy">In this local setup, the rehearsal tools at the bottom can use sample parties. They are outside the hosted tenancy path.</p>}
      </div>
    </details>
  );
}
