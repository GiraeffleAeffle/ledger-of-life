'use client';
import { NetPosition } from './net-position';
import { netPositionTotal, usd, type NetPositionParts } from './money-valuation';
import { DepositIdeas } from './tenancy-walkthrough';
import { Figure, Figures, Hero, MoreRow, ScreenNote, StatusLine } from './blocks';
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
        <h1>How should it look?</h1>
        <p role="note">Every figure here is invented for this page. None of it is your account, and none of it is on a chain.</p>
      </header>
      <section aria-labelledby="lab-holdings">
        <h2 id="lab-holdings">Money → Holdings</h2>
        <p>A total, a compact balance bar and labelled rows for details.</p>
        {HOLDINGS.map(({ name, note, parts }) => (
          <article className="design-lab-example" key={name}>
            <h3>{name}</h3>
            <Hero title="Total test value" status={<StatusLine tone="ok">Your test balances are up to date</StatusLine>}>
              <Figures><Figure label="What you own, less what you owe" value={usd(netPositionTotal(parts))} /></Figures>
              <NetPosition parts={parts} />
            </Hero>
            <section className="card">
              <h3>What you own</h3>
              <div className="design-lab-holding"><span>Test dollars</span><strong>{usd(parts.free)}</strong><span>Free to use</span></div>
              <div className="design-lab-holding"><span>Rental deposit</span><strong>{usd(parts.locked)}</strong><span>Locked</span></div>
            </section>
            <MoreRow title="Valuation details" meta="Prices and exact balances"><p>{note}</p></MoreRow>
            <ScreenNote>Illustration only. These invented test balances have no monetary value.</ScreenNote>
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
