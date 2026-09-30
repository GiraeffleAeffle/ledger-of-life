'use client';
import { goToSection, openShareWorkflow, type Area } from './areas';

/** Optional destinations, not a borrowing-to-invest sequence or an account checklist. */
export function OwnershipJourney({ go }: { go: (area: Area) => void }) {
  return <section className="card ownership-journey" aria-label="Optional test-money choices">
    <h2>Explore test money, if you want</h2>
    <p>These are independent choices. Neither borrowing nor investing is required for your home. Test networks · no real money.</p>
    <ul className="ownership-choices">
      <li><span>Use official test TSLA as loan collateral.</span><button type="button" className="text-button" onClick={() => openShareWorkflow(go, 'borrow')}>Loan against shares</button></li>
      <li><span>Supply test dollars to the shared pool; no TSLA needed.</span><button type="button" className="text-button" onClick={() => openShareWorkflow(go, 'lend')}>Lend test dollars</button></li>
      <li><span>Buy fictional units with test dollars; no property or company rights.</span><button type="button" className="text-button" onClick={() => goToSection(go, 'money', 'local-investments')}>Local stakes</button></li>
    </ul>
  </section>;
}
