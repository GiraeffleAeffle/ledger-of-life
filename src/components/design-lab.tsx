'use client';
import { NetPosition, NetPositionStrip } from './net-position';
import { netPositionTotal, usd, type NetPositionParts } from './money-valuation';
import { DepositIdeas } from './tenancy-walkthrough';
import './design-lab.css';

const HOLDINGS: { name: string; note: string; parts: NetPositionParts }[] = [
  { name: 'A new account', note: 'Signed in, nothing funded yet.', parts: { free: 0, locked: 0, pledged: 0, lent: 0, owed: 0 } },
  { name: 'A living tenancy', note: 'A 1 test-USDC deposit is locked and a little test cash is free.', parts: { free: 7.31, locked: 1, pledged: 0, lent: 0, owed: 0 } },
  { name: 'Collateral, a loan and lending', note: 'Everything at once: a deposit, test TSLA posted as collateral in the shared pool, test dollars borrowed against it, and test dollars lent to the pool.', parts: { free: 812.34, locked: 10, pledged: 2200, lent: 500, owed: 300 } },
];


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
      <section aria-labelledby="lab-deposits">
        <h2 id="lab-deposits">Home: ways to hold the deposit</h2>
        <p>One compact deposit comparison follows the listing browser for people looking for a home.</p>
        <DepositIdeas />
      </section>
    </main>
  );
}
