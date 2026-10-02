import Link from 'next/link';
import { receiptUrl, type CityStory, type StoryFact, type StoryKind } from '../server/city-story.ts';
import './reality-chip.css';
import './city-story.css';

const kindLabels: Record<StoryKind, { label: string; style: string }> = {
  recorded: { label: 'Recorded on a test network', style: 'testnet_real' },
  'app-record': { label: 'Recorded in the app', style: 'self_declared_local' },
  narrative: { label: 'Fiction', style: 'prototype' },
  'public-data': { label: 'Public city data', style: 'read_only_live' },
  illustrative: { label: 'Illustrative calculation', style: 'illustration' },
};

function Facts({ facts }: { facts?: StoryFact[] }) {
  return facts?.length ? <dl className="story-facts">{facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl> : null;
}

export function CityStoryView({ story }: { story: CityStory }) {
  return <main className="city-story">
    <header className="card story-hero">
      <span className="eyebrow">LEDGER OF LIFE · STRAUSBERG</span>
      <h1>Two people. One city.</h1>
      <p className="story-lede">Mara has put down roots. Jonas arrives for a job. Follow how a home, a workshop and everyday life can connect — with real receipts from test networks, and fiction clearly marked.</p>
      <p className="story-status">{story.evidenceStatus.includes('in_progress') ? 'Recording in progress. The timeline shows only the steps recorded so far.' : 'A recorded city story. Each step states what kind of evidence it contains.'}</p>
      <p className="small-copy">No account needed. No cookies, wallet SDK or signing. Explorer links open only when you choose them.</p>
      <a href="#story-timeline">Follow the story ↓</a>
    </header>

    <section className="story-people" aria-label="People in the story">{story.personas.map((persona) => <article className="card" key={persona.id}>
      <h2>{persona.name}</h2><p>{persona.role}</p>
      <p className="small-copy">Fictional person played by a test account.</p>
      {persona.note && <p className="small-copy">{persona.note}</p>}
      {persona.account && <a href={`${story.networks['robinhood-testnet'].explorerTx.replace(/tx\/$/, 'address/')}${persona.account}`} target="_blank" rel="noopener noreferrer" title={persona.account} aria-label={`${persona.name}'s test account: ${persona.account}`}><code>{persona.account.slice(0, 8)}…{persona.account.slice(-6)}</code> · test account ↗</a>}
    </article>)}</section>

    <section id="story-timeline" aria-labelledby="story-timeline-title">
      <h2 id="story-timeline-title">The city story, step by step</h2>
      <ol className="story-timeline">{story.steps.map((step, index) => {
        const kind = kindLabels[step.kind];
        return <li className="card story-step" id={`story-${step.id}`} key={step.id}>
          <div className="story-step-meta"><span className="story-number" aria-hidden="true">{index + 1}</span><strong>{story.personas.find((persona) => persona.id === step.actor)!.name}</strong><span className={`reality-chip ${kind.style}`}>{kind.label}</span></div>
          <h3>{step.title}</h3><p>{step.summary}</p>
          {step.startedAtUtc && <p className="small-copy">Recorded from <time dateTime={step.startedAtUtc}>{step.startedAtUtc.replace('T', ' ').replace('Z', ' UTC')}</time>{step.finishedAtUtc && <> to <time dateTime={step.finishedAtUtc}>{step.finishedAtUtc.replace('T', ' ').replace('Z', ' UTC')}</time></>}</p>}
          <Facts facts={step.facts} />
          {!!step.receipts?.length && <ul className="story-receipts" aria-label="Transaction receipts">{step.receipts.map((receipt, receiptIndex) => <li key={receiptIndex}>
            <a href={receiptUrl(story.networks[receipt.network], receipt.hash)} target="_blank" rel="noopener noreferrer" title={receipt.hash} aria-label={`${receipt.label}, ${story.networks[receipt.network].name}, transaction ${receipt.hash}`}><strong>{receipt.label} ↗</strong><span>{story.networks[receipt.network].name} · <code>{receipt.hash.slice(0, 10)}…{receipt.hash.slice(-8)}</code></span></a>
          </li>)}</ul>}
          {!!step.links?.length && <ul className="story-links" aria-label="Related pages">{step.links.map((link, linkIndex) => <li key={linkIndex}><a href={link.href} target={link.href.startsWith('https:') ? '_blank' : undefined} rel={link.href.startsWith('https:') ? 'noopener noreferrer' : undefined}>{link.label} ↗</a></li>)}</ul>}
        </li>;
      })}</ol>
    </section>

    {story.outcome && <section className="card" aria-labelledby="story-outcome-title"><h2 id="story-outcome-title">{story.outcome.title}</h2><p>{story.outcome.summary}</p><Facts facts={story.outcome.facts} /></section>}

    <figure className="card story-flywheel">
      <figcaption><h2>The idea: value circulates locally</h2><p>A conceptual flywheel, not a claim about recorded earnings. Solar is illustrative unless a step explicitly records it.</p></figcaption>
      <ol aria-label="Conceptual local value cycle">{['Early investment', 'Jobs and homes', 'Rent, AI answers, solar', 'Building income', 'Holders claim and reinvest'].map((label) => <li key={label}>{label}<span aria-hidden="true"> →</span></li>)}</ol>
      <p className="small-copy">Reinvestment returns to the beginning of the cycle.</p>
    </figure>

    <footer className="card story-footer"><h2>Evidence, not a promise</h2><p>{story.evidenceScope}</p><nav aria-label="Explore Ledger of Life"><Link href="/replay" prefetch={false}>Recorded tenancy</Link><Link href="/welcome/strausberg" prefetch={false}>Welcome to Strausberg</Link><Link href="/" prefetch={false}>Ledger of Life</Link></nav></footer>
  </main>;
}
