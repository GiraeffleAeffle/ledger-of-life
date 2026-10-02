import Link from 'next/link';
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
          <dd>The tenant locks the deposit as cash in a Solana devnet escrow. Labelled simulated yield defaults to 5 % a year and belongs to the tenant. At move-out, the deposit returns minus any agreed or decided deduction.</dd></div>
        <div><dt>Deposit lent out to earn <span className="deposit-availability">Needs a local setup</span></dt>
          <dd>A local rehearsal can lend the deposit to the shared loan pool. Older Circle devnet USDC tenancies lend on Solana devnet, which pays no interest. Deposit earnings belong to the tenant.</dd></div>
        <div><dt>Share-backed deposit <span className="deposit-availability available">Available on this site</span></dt>
          <dd>The tenant locks official test TSLA worth 150 % of the USD deposit on Robinhood Chain testnet. Settlement is in shares, without a forced sale. Proven here on 1 October with three fresh accounts.
            {' '}<Link href="/replay">See the recorded tenancy — no account needed →</Link>
            {go && <> <button type="button" className="text-button" onClick={() => goToSection(go, 'home', 'publish-home')}>Choose the deposit when publishing →</button></>}</dd></div>
      </dl>
    </section>
  );
}
