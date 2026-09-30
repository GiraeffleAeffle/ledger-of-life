import { goToSection, type Area } from './areas';
import './tenancy-walkthrough.css';

/**
 * The answer to "can I hold the deposit with shares, or lend it?", visible without opening anything.
 * Only the first way can be used on this site; the others say plainly where they exist. Nothing here signs.
 */
export function DepositIdeas({ go }: { go?: (area: Area) => void }) {
  return (
    <section className="card deposit-ideas-card" id="deposit-options" tabIndex={-1} aria-labelledby="deposit-options-title">
      <h2 id="deposit-options-title">Ways to hold the deposit</h2>
      <dl className="deposit-ideas">
        <div><dt>Test-USDC deposit <span className="deposit-availability available">Available on this site</span></dt>
          <dd>The tenant locks the home&apos;s test-USDC deposit in a Solana devnet escrow. At move-out it comes back, minus any agreed or decided deduction.</dd></div>
        <div><dt>Deposit lent out to earn <span className="deposit-availability">Needs a local setup</span></dt>
          <dd>On this site the escrow lends the deposit on Solana devnet, which pays no interest. Earnings, in test dollars, exist only in a local rehearsal, where the deposit is lent to the shared loan pool. On a rental deposit they belong to the tenant.</dd></div>
        <div><dt>Share-backed deposit <span className="deposit-availability">Contract prototype</span></dt>
          <dd>A contract and a calculator exist; nothing is offered or signed here, and buying or borrowing against shares does not replace the deposit.
            {go && <> <button type="button" className="text-button" onClick={() => goToSection(go, 'ideas', 'stock-deposit-illustration')}>See the illustration →</button></>}</dd></div>
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
        <p>The tenant keeps deposit assets above an approved deduction at settlement. The agreement determines whether surplus can be claimed while living here. Devnet lending pays no interest; any separately credited earnings are simulated test tokens.</p>
        <p>Deposit options are listed under &ldquo;Ways to hold the deposit&rdquo; above.</p>
        <p className="small-copy">Payouts go to each party’s own wallet. Keep Home open during payout; failed attempts retry here.</p>
        {testTools && <p className="small-copy">In this local setup, the rehearsal tools at the bottom can use sample parties. They are outside the hosted tenancy path.</p>}
      </div>
    </details>
  );
}
