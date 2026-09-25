'use client';

import { Building2, LineChart, Sparkles } from 'lucide-react';
import { networks } from '@/domain/assets';
import { summary, type WorkspaceState } from '@/domain/workflow';
import { Badge, money } from './workspace-panels';

/** Fictional reference home used only to illustrate fractional ownership. */
const EXAMPLE_HOME = {
  name: 'Cedar Court (example building)',
  value: 250_000_000_000n,
  tokenPrice: 50_000_000n,
  netRentPerMonth: 900_000_000n,
};
const TILES = 100;
const friendly: Record<string, string> = {
  'Example accumulating return': 'Holding value grew 5% (example)',
  'Example earnings added': 'Deposit earned $10 in lending (example)',
  'Release reconciled': 'Earnings moved to your personal cash',
  'Buy reconciled': 'You bought a sample holding',
  'Sell reconciled': 'You sold your sample holding',
};

const returnEvents = new RegExp(`^(${Object.keys(friendly).join('|')})$`);

function shares(state: WorkspaceState): string {
  const decimals = networks[state.network].investmentDecimals;
  const exposure = (BigInt(state.personal.units) * BigInt(state.personal.multiplier)) / 10n ** 18n;
  const whole = exposure / 10n ** BigInt(decimals);
  const fraction = (exposure % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 4);
  return `${whole}.${fraction}`;
}

/** Visual summary of what the tenant owns; every number is derived from the fictional walkthrough state. */
export function HoldingsShowcase({ state }: { state: WorkspaceState }) {
  const totals = summary(state);
  const invested = BigInt(state.personal.spent);
  const value = BigInt(totals.investmentValue);
  const gain = value - invested;
  const gainBps = invested > 0n ? Number((gain * 10_000n) / invested) : 0;
  const portfolio = BigInt(totals.portfolioValue);
  // Illustration only: how many $50 tokens of the example building this portfolio would equal.
  const hundredthTokens = (portfolio * 100n) / EXAMPLE_HOME.tokenPrice;
  const tokens = `${hundredthTokens / 100n}.${(hundredthTokens % 100n).toString().padStart(2, '0')}`;
  const filled = Number(hundredthTokens % 100n);
  const tokenCount = EXAMPLE_HOME.value / EXAMPLE_HOME.tokenPrice;
  const monthlyShare = (EXAMPLE_HOME.netRentPerMonth * portfolio) / EXAMPLE_HOME.value;
  const events = state.activity.filter((item) => returnEvents.test(item.title)).slice(0, 5);

  return (
    <section className="card holdings-showcase">
      <div className="section-heading">
        <span className="card-label">
          <Sparkles size={17} />
          WHAT YOU OWN
        </span>
        <Badge tone="neutral">Example data · not an offer</Badge>
      </div>
      <div className="holdings-grid">
        <article className="holding-tile">
          <header>
            <LineChart size={20} />
            <div>
              <strong>Sample S&amp;P 500 tracker</strong>
              <span>{shares(state)} represented shares</span>
            </div>
          </header>
          <div className="holding-value">{money(totals.investmentValue)}</div>
          <div className={`holding-change ${gain >= 0n ? 'up' : 'down'}`}>
            {invested === 0n
              ? 'No holding yet — release earnings, then invest them.'
              : `${gain >= 0n ? '+' : '−'}${money((gain < 0n ? -gain : gain).toString())} (${(gainBps / 100).toFixed(2)}%) since purchase`}
          </div>
          <div className="holding-bar" aria-hidden>
            <span style={{ width: `${invested === 0n ? 0 : Math.min(100, Number((invested * 100n) / (value > invested ? value : invested)))}%` }} />
          </div>
          <p className="small-copy">Bar: amount you paid (dark) versus current example value.</p>
        </article>

        <article className="holding-tile">
          <header>
            <Building2 size={20} />
            <div>
              <strong>{EXAMPLE_HOME.name}</strong>
              <span>Concept: fractional home ownership</span>
            </div>
          </header>
          <div className="home-tiles" role="img" aria-label={`${filled} percent of the way to the next example home token`}>
            {Array.from({ length: TILES }, (_, index) => (
              <span key={index} className={index < filled ? 'owned' : ''} />
            ))}
          </div>
          <div className="holding-value">{tokens} home tokens</div>
          <p className="small-copy">
            Squares fill toward your next {money(EXAMPLE_HOME.tokenPrice.toString())} token of a{' '}
            {money(EXAMPLE_HOME.value.toString())} building split into {tokenCount.toLocaleString('en-US')} tokens. At that
            size your portfolio would receive about {money(monthlyShare.toString())} of its monthly net rent.
            Tokenized real estate is not part of this version; this is an illustration only.
          </p>
        </article>
      </div>

      <div className="distribution-timeline">
        <h3>Returns &amp; distributions</h3>
        {events.length === 0 ? (
          <p className="small-copy">Released deposit earnings and example returns will appear here.</p>
        ) : (
          <ol>
            {events.map((item) => (
              <li key={item.id}>
                <span className="timeline-dot" />
                <div>
                  <strong>{friendly[item.title]}</strong>
                  <span>{new Date(item.at).toLocaleDateString()}</span>
                  <p>{item.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
