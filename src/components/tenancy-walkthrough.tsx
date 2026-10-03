import Link from 'next/link';
import { openPublishHome, type Area } from './areas';
import './tenancy-walkthrough.css';

/** Deposit choices stay reachable without competing with the home's status. Nothing here signs. */
export function DepositIdeas({ go }: { go?: (area: Area) => void }) {
  return (
    <div className="deposit-options" aria-label="Ways to hold the deposit">
      <dl className="deposit-ideas">
        <div><dt>Cash deposit <span className="deposit-availability available">Available</span></dt>
          <dd>Lock cash in escrow. Simulated earnings belong to the tenant. At move-out, the deposit returns minus any agreed or decided deduction.</dd></div>
        <div><dt>Deposit lent out to earn <span className="deposit-availability">Needs a local setup</span></dt>
          <dd>A local rehearsal can lend the deposit to the shared loan pool. Older cash tenancies on this site can lend, but pay no interest. Any deposit earnings belong to the tenant.</dd></div>
        <div><dt>Share-backed deposit <span className="deposit-availability available">Available</span></dt>
          <dd>Lock test shares worth 150% of the deposit. Settlement returns shares, without a forced sale.
            {' '}<Link href="/replay">See a recorded tenancy →</Link>
            {go && <> <button type="button" className="text-button" onClick={() => openPublishHome(go)}>Choose the deposit when publishing →</button></>}</dd></div>
      </dl>
    </div>
  );
}
