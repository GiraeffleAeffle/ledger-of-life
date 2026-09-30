import { RealityChips } from './reality-chip';
import './tenancy-walkthrough.css';

/**
 * The whole journey in words, for a person who cannot run it alone. Each line restates what the journey
 * screens (src/server/journey.ts) say and do; change one only after reading the other.
 */
const STEPS: { stage: string; who: string; what: string }[] = [
  { stage: 'Agreement', who: 'Landlord, tenant, arbitrator',
    what: 'The landlord posts a home and a tenant applies. Choosing a tenant cannot be undone. The landlord then sends a private link, valid once for 24 hours, to a neutral arbitrator. Tenant and landlord each accept the same terms: the home, the deposit and who keeps earnings.' },
  { stage: 'Deposit space', who: 'Landlord',
    what: 'One approval creates the deposit space on Solana devnet. It holds no money yet.' },
  { stage: 'Deposit secured', who: 'Tenant',
    what: 'One approval locks the deposit in test USDC and supplies it to lending. Devnet lending pays nothing, so any earnings you see are simulated.' },
  { stage: 'Living here', who: 'Nobody',
    what: 'Nothing to do. The tenant can claim earnings above the deposit when there are some (simulated on devnet).' },
  { stage: 'Move-out', who: 'Landlord, then tenant, then the arbitrator only if they disagree',
    what: 'The landlord proposes a deduction, zero is allowed, with a reason. The tenant agrees, which settles at once, or disputes it. The arbitrator then decides an amount up to the claim.' },
  { stage: 'Paid out', who: 'Automatic',
    what: 'One approval settles the deposit. Payouts go to each side’s own account. Today they are sent while one of the people involved has Home open.' },
];

export function TenancyWalkthrough({ testTools }: { testTools: boolean }) {
  return (
    <details className="card tenancy-walkthrough" open={!testTools}>
      <summary><strong>How a tenancy works</strong><span>three people, six steps</span></summary>
      <div className="tenancy-walkthrough-body">
        <RealityChips levels={['testnet_simulated']} />
        <p>
          {testTools
            ? 'The Test tools at the bottom of this page can play the other people, so one account can walk through all of it.'
            : 'A tenancy is between three people who each need their own account: a landlord, a tenant and a neutral arbitrator. This build has no test tools to play the other two, so on your own you can read the journey here, post a home, or apply to one.'}
        </p>
        <ol>
          {STEPS.map(({ stage, who, what }) => (
            <li key={stage}><strong>{stage}</strong><small>{who}</small><span>{what}</span></li>
          ))}
        </ol>
        <p className="small-copy">Nobody is notified when it is their turn: tell the other people yourself. Everything runs on Solana devnet with test USDC.</p>
      </div>
    </details>
  );
}
