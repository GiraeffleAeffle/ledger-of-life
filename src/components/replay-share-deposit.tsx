import Link from 'next/link';
import { alsoRecorded, replayFacts, replaySources, replaySteps } from '../data/replay-share-deposit.ts';

function TxLink({ hash, explorer }: { hash: string; explorer: string }) {
  return <a className="replay-tx" href={explorer} target="_blank" rel="noopener noreferrer"><span>View transaction ↗</span><code>{hash}</code></a>;
}

export function ShareDepositReplay() {
  return <main className="replay-page">
    <header className="card replay-hero">
      <span className="eyebrow">LEDGER OF LIFE · RECORDED TEST RUN</span>
      <h1>A tenancy, from finding a home to getting the shares back.</h1>
      <p className="replay-lede">Three fresh accounts. A share-backed deposit. A disputed deduction and two payouts. Follow the recorded {replayFacts.date} run without an account.</p>
      <p className="replay-reality"><strong>Test networks only. Not a live tenancy. Test tokens have no monetary value or real-world rights.</strong></p>
      <p className="small-copy">No wallet SDK or sign-in required. This page sets no cookies. Nothing to sign. Explorer and evidence links leave this site only when you open them.</p>
      <nav className="replay-jumps" aria-label="Recorded Home steps">{replaySteps.map((step, index) => <a key={step.id} href={`#replay-${step.id}`}><span>{index + 1}</span>{step.title}</a>)}</nav>
    </header>

    <section className="card replay-context" aria-labelledby="replay-context-title">
      <h2 id="replay-context-title">What was recorded</h2>
      <dl className="replay-facts">
        <div><dt>Network</dt><dd>{replayFacts.network} · {replayFacts.chainId}</dd></div>
        <div><dt>Nominal security</dt><dd>${replayFacts.securityUsd} USD</dd></div>
        <div><dt>Recorded quote</dt><dd>${replayFacts.quoteUsd} per test TSLA</dd></div>
        <div><dt>Final escrow state</dt><dd>{replayFacts.finalState} · {replayFacts.finalEscrowTsla} test TSLA held</dd></div>
      </dl>
      <p className="small-copy">USD equivalents below are arithmetic at the quote recorded with the claim, not money paid, a current market price or guaranteed value. No shares were sold to settle the deposit.</p>
      <p className="small-copy">The seven Home stages group the recorded calls. Off-chain screens are not preserved. Intermediate states are inferred from successful calls and the contract lifecycle, not separate historical RPC reads. The final state is a recorded read, not read live.</p>
      <details className="replay-details"><summary>Recorded parties and escrow</summary>
        <ul>{Object.entries(replayFacts.accounts).map(([role, address]) => <li key={role}><strong>{role}</strong><code>{address}</code></li>)}</ul>
        <p>Escrow: <a href={replayFacts.escrowExplorer} target="_blank" rel="noopener noreferrer"><code>{replayFacts.escrow}</code></a></p>
      </details>
    </section>

    <ol className="replay-timeline" aria-label="Seven recorded Home steps">{replaySteps.map((step, index) => <li className="card replay-step" id={`replay-${step.id}`} key={step.id}>
      <div className="replay-step-heading"><span className="replay-number" aria-hidden="true">{index + 1}</span><h2>{step.title}</h2><span className="replay-role">{step.roles.join(' · ')}</span></div>
      <p>{step.action}</p>
      <dl className="replay-step-facts"><div><dt>Amounts</dt><dd>{step.amounts}</dd></div><div><dt>Escrow after</dt><dd>{step.stateAfter}</dd></div></dl>
      {step.note && <p className="small-copy">{step.note}</p>}
      {step.transactions.length ? <ul className="replay-transactions">{step.transactions.map((tx) => <li key={tx.hash}>
        <p><strong>{tx.actor}</strong> · {tx.action}{tx.amount && <> · {tx.amount}</>}</p>
        <TxLink hash={tx.hash} explorer={tx.explorer} />
        <p className="small-copy">Escrow after this call: {tx.stateAfter}</p>
      </li>)}</ul> : <p className="replay-no-tx">Transaction: none separately recorded for this stage.</p>}
    </li>)}</ol>

    <section className="card" aria-labelledby="replay-also-title">
      <h2 id="replay-also-title">Also recorded on 1 Oct</h2>
      <p className="small-copy">Separate test runs on the same test network, not earnings of this share-deposit tenancy.</p>
      <div className="replay-related">{alsoRecorded.map((run) => <article key={run.title}><h3>{run.title}</h3><p>{run.summary}</p><ul className="replay-transactions">{run.transactions.map((tx) => <li key={tx.hash}><p><strong>{tx.label}</strong> · {tx.amount}</p><TxLink hash={tx.hash} explorer={tx.explorer} /></li>)}</ul></article>)}</div>
    </section>

    <footer className="card replay-footer">
      <h2>Evidence, not a promise</h2><p>{replayFacts.scope}</p>
      <nav aria-label="Recorded evidence sources">{replaySources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.label} ↗</a>)}</nav>
      <p className="small-copy">This is a technical demonstration, not an offer of investments or legal advice. Fictional tHOME units grant no property, income or other legal rights.</p>
      <p><Link href="/story" prefetch={false}>Two people, one city — a story with receipts</Link></p>
      <Link href="/" prefetch={false}>Back to Ledger of Life</Link>
    </footer>
  </main>;
}
