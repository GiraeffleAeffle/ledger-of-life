'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ARRIVAL_INTERESTS, ARRIVAL_PHASES, ARRIVAL_SITUATIONS } from '../data/arrival/types.ts';
import type { ArrivalGuide, ArrivalInterest, ArrivalSituation, ArrivalSource } from '../data/arrival/types.ts';
import type { CityFeedItem } from '../server/city-signals.ts';
import { feedMatches, filterGroups, groupMatches, orderSteps, parseProfile, selectFeed, serializeProfile, stepMatches, welcomeStorageKey } from './arrival-logic.ts';
import { formatCityDate } from './city-coverage.ts';
import type { ArrivalProfile } from './arrival-logic.ts';
import { saveInterests, useInterests } from './personal-map-preferences';
import { interestWordList } from './personal-map-relevance.ts';

const situationLabels: Record<ArrivalSituation, string> = {
  'within-germany': 'Moving within Germany', 'from-abroad': 'Moving from abroad', 'with-children': 'With children',
  'working-or-studying': 'Working or studying', retired: 'Retired',
};
const interestLabels: Record<ArrivalInterest, string> = {
  sport: 'Sport', kids: 'Kids and family', shops: 'Shops and markets', health: 'Health',
  culture: 'Culture', nature: 'Nature and the lake', volunteering: 'Volunteering',
};
const phaseLabels = ['First two weeks', 'First month', 'Months two and three', 'Months four to six'];
const SITUATIONS_CHANGED_EVENT = 'ledger-welcome-situations-changed';
function subscribeSituations(update: () => void) {
  window.addEventListener(SITUATIONS_CHANGED_EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(SITUATIONS_CHANGED_EVENT, update); window.removeEventListener('storage', update); };
}
function useSituations(cityId: string): ArrivalSituation[] {
  const raw = useSyncExternalStore(subscribeSituations, () => {
    try { return localStorage.getItem(welcomeStorageKey(cityId)) ?? ''; }
    catch { return ''; }
  }, () => '');
  return useMemo(() => parseProfile(raw).situations, [raw]);
}

function Source({ source }: { source: ArrivalSource }) {
  return <span className="welcome-source">Source: <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> · checked {formatCityDate(source.checkedOn)}</span>;
}
function FeedList({ items, interests }: { items: CityFeedItem[]; interests: ArrivalInterest[] }) {
  return <ul className="welcome-list">{items.map((item) => <li className="welcome-item" key={item.id}>
    <strong><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a></strong>
    {feedMatches(item, interests).map((interest) => <span className="welcome-match" key={interest}>matches {interestLabels[interest].toLowerCase()}</span>)}
    <p className="welcome-meta">{item.kind === 'event' ? `Event: ${new Date(item.eventStart!).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })}${item.venue ? ` · ${item.venue}` : ' · venue not supplied'}` : `Published ${item.publishedAt.slice(0, 10)}`} · {item.publisher}</p>
  </li>)}</ul>;
}

export function ArrivalGuideView({ guide, feed, now }: { guide: ArrivalGuide; feed: { items: CityFeedItem[]; generatedAt: string | null }; now: string }) {
  const situations = useSituations(guide.cityId);
  const interests = useInterests();
  const profile: ArrivalProfile = { situations, interests };
  const [search, setSearch] = useState('');
  const [onlyMatchingGroups, setOnlyMatchingGroups] = useState(false);
  function updateSituations(next: ArrivalSituation[]) {
    try {
      localStorage.setItem(welcomeStorageKey(guide.cityId), serializeProfile({ situations: next, interests: [] }));
      window.dispatchEvent(new Event(SITUATIONS_CHANGED_EVENT));
    } catch { /* Private mode may block storage. */ }
  }
  function forget() {
    setSearch('');
    setOnlyMatchingGroups(false);
    try {
      localStorage.removeItem(welcomeStorageKey(guide.cityId));
      window.dispatchEvent(new Event(SITUATIONS_CHANGED_EVENT));
    } catch { /* Storage was unavailable. */ }
    try { saveInterests([]); } catch { /* Storage was unavailable. */ }
  }
  const selected = selectFeed(feed.items, new Date(now), interests);
  const groups = filterGroups(guide.groups, interests, search, onlyMatchingGroups);
  return <main className="welcome-page">
    <header className="welcome-hero card">
      <span className="eyebrow">WELCOME TO {guide.cityName.toUpperCase()}</span>
      <h1>Welcome to {guide.cityName}</h1>
      <p>A community guide, not an official city service. Each item links to its source. Prepared on {formatCityDate(guide.preparedOn)}.</p>
      <p>Nothing you tick here leaves this device. No account is needed.</p>
    </header>

    <section className="card welcome-section" aria-labelledby="welcome-about">
      <h2 id="welcome-about">About you <span className="welcome-optional">(optional)</span></h2>
      <p>Choose what applies. This only changes the order and highlighting of the guide. You can leave everything unselected.</p>
      <h3>Situation</h3><div className="welcome-chips">{ARRIVAL_SITUATIONS.map((item) => <button key={item} type="button" className="button secondary welcome-chip" aria-pressed={situations.includes(item)} onClick={() => updateSituations(situations.includes(item) ? situations.filter((entry) => entry !== item) : [...situations, item])}>{situationLabels[item]}</button>)}</div>
      <h3>Interests</h3><div className="welcome-chips">{ARRIVAL_INTERESTS.map((item) => <button key={item} type="button" className="button secondary welcome-chip" aria-pressed={interests.includes(item)} onClick={() => { try { saveInterests(interests.includes(item) ? interests.filter((entry) => entry !== item) : [...interests, item]); } catch { /* Storage was unavailable. */ } }}>{interestLabels[item]}</button>)}</div>
      <button type="button" className="button secondary welcome-forget" onClick={forget}>Forget my choices</button>
    </section>

    <section className="card welcome-section welcome-print" aria-labelledby="welcome-plan">
      <h2 id="welcome-plan">Your first months</h2>
      {guide.steps.length === 0 ? <p>There are no checked steps in this guide yet. Check the sources and contacts below for current help.</p> : ARRIVAL_PHASES.map((phase, index) => <section key={phase} className="welcome-phase" aria-labelledby={`welcome-${phase}`}>
        <h3 id={`welcome-${phase}`}>{phaseLabels[index]}</h3>
        {guide.steps.filter((step) => step.phase === phase).length === 0 ? <p>No checked steps for this period yet.</p> : <ol className="welcome-list">{orderSteps(guide.steps.filter((step) => step.phase === phase), profile).map((step) => <li className={`welcome-item${stepMatches(step, profile) ? ' welcome-highlight' : ''}`} key={step.id}>
          <div className="welcome-item-heading"><h4>{step.title}</h4><span className="badge welcome-badge">{step.official ? 'Official' : 'Community'}</span>{stepMatches(step, profile) && <span className="welcome-match">Matches your choices</span>}</div>
          <p>{step.why}</p><p><strong>What to do:</strong> {step.whatToDo}</p>
          {step.caveat && <p className="welcome-caveat">Note: {step.caveat}</p>}
          <Source source={step.source} />
        </li>)}</ol>}
      </section>)}
    </section>

    <section className="card welcome-section" aria-labelledby="welcome-soon">
      <h2 id="welcome-soon">Happening soon</h2>
      <p>Events in the next 21 days and the latest three news items in the published city feed. This is a snapshot, not a complete calendar.{feed.generatedAt && ` Published ${formatCityDate(feed.generatedAt.slice(0, 10))}.`}</p>
      <details className="welcome-keywords"><summary>How interest matches work</summary><p>We check published titles for the same case-insensitive words used in Places, on this device. A match is not a recommendation:</p><ul>{ARRIVAL_INTERESTS.map((interest) => <li key={interest}>{interestLabels[interest]}: {interestWordList(interest).join(', ')}</li>)}</ul></details>
      <h3>Events</h3>{selected.events.length ? <FeedList items={selected.events} interests={interests} /> : <p>No upcoming dated events in this published feed for the next 21 days.</p>}
      <h3>City news</h3>{selected.news.length ? <FeedList items={selected.news} interests={interests} /> : <p>No dated news items in this published feed.</p>}
    </section>

    <section className="card welcome-section" aria-labelledby="welcome-groups">
      <h2 id="welcome-groups">Clubs, places and groups</h2>
      <p>Groups matching your interests appear first. All groups stay visible unless you choose to narrow the list. Search filters by text.</p>
      <label className="welcome-search">Search groups <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, place or activity" /></label>
      <label className="welcome-group-toggle"><input type="checkbox" checked={onlyMatchingGroups} onChange={(event) => setOnlyMatchingGroups(event.target.checked)} /> Only show groups for my interests</label>
      {groups.length ? <ul className="welcome-list">{groups.map((group) => <li className={`welcome-item${groupMatches(group, interests) ? ' welcome-highlight' : ''}`} key={group.id}>
        <h3>{group.name}</h3><span className="welcome-meta">{group.kind}</span>{groupMatches(group, interests) && <span className="welcome-match">Matches your interests</span>}<p>{group.summary}</p>
        {group.address && <p>Address: {group.address}</p>}{group.tryFirst && <p>Try it: {group.tryFirst}</p>}
        {group.url && <p><a href={group.url} target="_blank" rel="noopener noreferrer">Visit organisation website</a></p>}
        <Source source={group.source} />
      </li>)}</ul> : <p>No groups match this search or the optional interest filter. Try clearing the search or turning off the filter.</p>}
    </section>

    <section className="card welcome-section welcome-print" aria-labelledby="welcome-contacts">
      <h2 id="welcome-contacts">Who to ask</h2>
      {guide.contacts.length ? <ul className="welcome-list">{guide.contacts.map((contact) => <li className="welcome-item" key={contact.id}>
        <h3>{contact.name}</h3><p>{contact.role}</p>{contact.address && <p>Address: {contact.address}</p>}{contact.hours && <p>Hours: {contact.hours}</p>}
        <p><a href={contact.url} target="_blank" rel="noopener noreferrer">Contact information</a></p><Source source={contact.source} />
      </li>)}</ul> : <p>No verified contacts are listed yet.</p>}
    </section>
    <footer className="welcome-footer"><button type="button" className="button primary" onClick={() => window.print()}>Print plan and contacts</button><Link href="/">Back to Ledger of Life</Link></footer>
  </main>;
}
