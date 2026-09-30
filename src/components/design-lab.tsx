'use client';
import { NetPosition, NetPositionStrip } from './net-position';
import { netPositionTotal, usd, type NetPositionParts } from './money-valuation';
import { RecoveryCard, RecoveryStepView, type RecoveryView } from './recovery-step';
import { TenancyWalkthrough } from './tenancy-walkthrough';
import './design-lab.css';

const HOLDINGS: { name: string; note: string; parts: NetPositionParts }[] = [
  { name: 'A new account', note: 'Signed in, nothing funded yet.', parts: { free: 0, locked: 0, pledged: 0, lent: 0, owed: 0 } },
  { name: 'A living tenancy', note: 'A 1 test-USDC deposit is locked and a little test cash is free.', parts: { free: 7.31, locked: 1, pledged: 0, lent: 0, owed: 0 } },
  { name: 'Collateral, a loan and lending', note: 'Everything at once: a deposit, test TSLA posted as collateral in the shared pool, test dollars borrowed against it, and test dollars lent to the pool.', parts: { free: 812.34, locked: 10, pledged: 2200, lent: 500, owed: 300 } },
];

const noop = () => {};
const RECOVERY: { status: RecoveryView['status']; note: string }[] = [
  { status: 'needs_baseline', note: 'Nothing done yet' },
  { status: 'use_another_browser', note: 'Waiting for the other browser' },
  { status: 'sign_in_again', note: 'This browser still holds the setup session' },
  { status: 'ready', note: 'Signed in with the backup email in the other browser' },
  { status: 'verified', note: 'Done' },
  { status: 'wallet_changed', note: 'The wallets differ from the recorded ones' },
  { status: 'needs_setup', note: 'Account setup is incomplete' },
];
const recoveryView = (status: RecoveryView['status']): RecoveryView => ({
  status, email: 'maria@example.org', origin: 'https://ledger.example', busy: false, error: '', copied: false,
  onEnroll: noop, onVerify: noop, onCopy: noop, onSignInAgain: noop,
});

/**
 * Real components with invented numbers, so a layout can be judged without funds or an account.
 * Add a section per screen under discussion; each carries the name people use when choosing between options.
 */
export function DesignLab() {
  return (
    <main className="design-lab">
      <header>
        <span className="eyebrow">DESIGN LAB · DEVELOPMENT ONLY</span>
        <h1>How should it look?</h1>
        <p role="note">Every figure here is invented for this page. None of it is your account, and none of it is on a chain.</p>
      </header>
      <section aria-labelledby="lab-holdings">
        <h2 id="lab-holdings">Money → Holdings: what the subtotal is made of</h2>
        <p>Rules applied: bars start from one zero line and are drawn strictly in proportion; parts are labelled where they are, so no legend is needed; a part that is zero is not listed; the parts add up to the total shown.</p>
        {HOLDINGS.map(({ name, note, parts }) => (
          <article className="card" key={name}>
            <span className="eyebrow">{name.toUpperCase()} · SUBTOTAL {usd(netPositionTotal(parts))}</span>
            <p>{note}</p>
            <h3>In Money → Holdings</h3>
            <NetPosition parts={parts} go={() => {}} depositSection="home-tenancies" />
            <h3>On Today</h3>
            <NetPositionStrip parts={parts} />
          </article>
        ))}
      </section>
      <section aria-labelledby="lab-recovery">
        <h2 id="lab-recovery">First run: setup ends after the wallets, recovery comes later</h2>
        <p>The card sits on Today until the proof is done, and the same steps appear inside a tenancy the first time a wallet acts. Each state below is one thing the server can report.</p>
        <RecoveryCard><RecoveryStepView {...recoveryView('needs_baseline')} /></RecoveryCard>
        {RECOVERY.map(({ status, note }) => (
          <article className="card" key={status}>
            <span className="eyebrow">{status!.toUpperCase()} · {note}</span>
            <RecoveryStepView {...recoveryView(status)} />
          </article>
        ))}
      </section>
      <section aria-labelledby="lab-walkthrough">
        <h2 id="lab-walkthrough">Home: a person with no tenancy yet</h2>
        <p>Shown above the listings until a tenancy exists. Open when nothing can play the other people; closed when test tools exist.</p>
        <TenancyWalkthrough testTools={false} />
        <TenancyWalkthrough testTools />
      </section>
    </main>
  );
}
