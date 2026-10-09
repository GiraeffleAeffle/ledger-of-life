'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CIVIC_ELIGIBILITY, CIVIC_LIMITS, type CivicAction, type CivicPhase, type CivicTopic, type CivicTopicList } from '@/data/civic';
import { CIVIC_AI_LIMITS, hasCityAiTag, type CivicAiJob } from '@/data/civic-ai';
import { CIVIC_CITIES, isCivicCity } from '@/data/civic-cities';
import type { AuthorizedRequest } from './use-city-signals';
import { Hero, StatusLine } from './blocks';
import { CivicArguments, CivicAiAttribution, CivicAiSources } from './civic-arguments';
import { civicTopicUrl, civicShareUrl } from './civic-argument-layout';
import './city-participation.css';

const PHASE_LABEL: Record<CivicPhase, string> = { discussion: 'Discussion', ready: 'Ready for review', open: 'Opinion poll open', closed: 'Closed · frozen result' };
const cityName = (id: string) => CIVIC_CITIES.find((city) => city.id === id)?.name ?? id;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
type NewAction = CivicAction extends infer Action ? Action extends CivicAction ? Omit<Action, 'operationId'> : never : never;
type CivicSaved = (topic: CivicTopic, contributionId?: string) => void;
type Attempt = { body: CivicAction; complete: CivicSaved };
interface CivicWriteState {
  pending: boolean;
  error: string;
  conflict: boolean;
  uncertain: Attempt | null;
  blocked: boolean;
  run: (body: NewAction, complete: CivicSaved) => void;
  retry: () => void;
  refreshed: () => void;
}

/** An uncertain write is only retried by an explicit click, with the identical operation ID and payload. */
function useCivicWrite(request: AuthorizedRequest): CivicWriteState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const lock = useRef(false);
  async function send(attempt: Attempt) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      const { topic, contributionId } = await request<{ topic: CivicTopic; contributionId?: string }>('/api/civic', attempt.body);
      setUncertain(null);
      setConflict(false);
      attempt.complete(topic, contributionId);
    } catch (cause) {
      const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : 0;
      setError(errorMessage(cause));
      setConflict(status === 409);
      setUncertain(!status || status >= 500 ? attempt : null);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return {
    pending, error, conflict, uncertain,
    blocked: pending || conflict || uncertain !== null,
    run: (body: NewAction, complete: CivicSaved) => {
      if (lock.current || conflict || uncertain) return;
      void send({ body: { ...body, operationId: crypto.randomUUID() } as CivicAction, complete });
    },
    retry: () => { if (uncertain) void send(uncertain); },
    refreshed: () => { setConflict(false); if (!uncertain) setError(''); },
  };
}

function WriteFeedback({ state }: { state: CivicWriteState }) {
  return <>
    {state.pending && <p role="status">Saving… Please wait before leaving this topic.</p>}
    {state.error && <div className="civic-error" role="alert"><p>{state.error}</p>
      {state.conflict && <p>This topic changed, or this action is no longer available. Reload the latest topic and review it before submitting again. Your entered text is kept.</p>}
      {state.uncertain && <><p>Confirmation was not received. The action may already be saved. No write will be retried automatically; retrying this exact request cannot create a second operation.</p><button type="button" disabled={state.pending} onClick={state.retry}>Retry the same request</button></>}
    </div>}
  </>;
}

interface CivicAiEntry {
  topicId: string;
  contributionId: string | null;
  job: CivicAiJob | null;
  pending: boolean;
  error: string;
}
interface CivicAiState {
  entries: CivicAiEntry[];
  start: (topicId: string, contributionId: string | null) => void;
  check: (topicId: string, contributionId: string | null) => void;
}

function useCityAi(request: AuthorizedRequest): CivicAiState {
  const [entries, setEntries] = useState<CivicAiEntry[]>([]);
  const inFlight = useRef(new Set<string>());
  async function load(topicId: string, contributionId: string | null, start: boolean) {
    const key = `${topicId}:${contributionId ?? 'context'}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const matches = (entry: CivicAiEntry) => entry.topicId === topicId && entry.contributionId === contributionId;
    setEntries((previous) => previous.some(matches)
      ? previous.map((entry) => matches(entry) ? { ...entry, pending: true, error: '' } : entry)
      : [...previous, { topicId, contributionId, job: null, pending: true, error: '' }]);
    try {
      const query = `?topicId=${encodeURIComponent(topicId)}${contributionId ? `&contributionId=${encodeURIComponent(contributionId)}` : ''}`;
      const result = await request<{ job: CivicAiJob | null }>(`/api/civic-ai${start ? '' : query}`, start ? { topicId, contributionId } : undefined);
      setEntries((previous) => previous.map((entry) => matches(entry) ? { ...entry, job: result.job, pending: false, error: '' } : entry));
    } catch (cause) {
      setEntries((previous) => previous.map((entry) => matches(entry) ? { ...entry, pending: false, error: errorMessage(cause) } : entry));
    } finally { inFlight.current.delete(key); }
  }
  useEffect(() => {
    const active = entries.filter((entry) => !entry.pending && !entry.error && (entry.job?.status === 'pending' || entry.job?.status === 'running'));
    if (!active.length) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(active.map(async (entry) => {
        const query = `?topicId=${encodeURIComponent(entry.topicId)}${entry.contributionId ? `&contributionId=${encodeURIComponent(entry.contributionId)}` : ''}`;
        try {
          const result = await request<{ job: CivicAiJob | null }>(`/api/civic-ai${query}`);
          return { ...entry, job: result.job };
        } catch (cause) { return { ...entry, error: errorMessage(cause) }; }
      })).then((updates) => {
        if (!cancelled) setEntries((previous) => previous.map((entry) => updates.find((update) => update.topicId === entry.topicId && update.contributionId === entry.contributionId) ?? entry));
      });
    }, 3000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [entries, request]);
  return {
    entries,
    start: (topicId, contributionId) => { void load(topicId, contributionId, true); },
    check: (topicId, contributionId) => { void load(topicId, contributionId, false); },
  };
}

function CityAiConsent() {
  return <p className="small-copy civic-ai-consent">Insert <strong>@city-ai</strong> to ask City AI. Saving tagged text explicitly requests a public model-generated reply using this topic and server-selected dated sources. Do not include personal data. This hosted service needs a connection; it is not offline AI. Free within shared limits ({CIVIC_AI_LIMITS.accountPerDay} requests per account/day, {CIVIC_AI_LIMITS.topicPerDay} per topic/day); no wallet payment. Availability is not guaranteed. AI has no municipal authority; check its claims.</p>;
}

function CivicAiJobs({ state, topic }: { state: CivicAiState; topic: CivicTopic }) {
  const entries = state.entries.filter((entry) => entry.topicId === topic.id);
  if (!entries.length) return null;
  return <section className="civic-row civic-ai-jobs" aria-label="City AI requests"><h3>City AI</h3>
    {entries.map((entry) => <article key={entry.contributionId ?? 'context'} className="civic-ai-job">
      <p role="status">{entry.pending ? 'Contacting City AI…' : entry.error ? 'City AI status could not be confirmed' : entry.job ? `City AI · ${entry.job.status.replaceAll('_', ' ')}` : 'No City AI job is recorded for this tag yet.'}</p>
      <p className="small-copy">{entry.contributionId ? 'Requested from a tagged contribution.' : 'Requested from the topic context.'} AI is not a resident, vote or municipal decision.</p>
      {entry.error && <p role="alert">{entry.error} Your saved text is unchanged. No AI start is retried automatically.</p>}
      {entry.job?.message && <p>{entry.job.message}</p>}
      {(entry.job?.status === 'pending' || entry.job?.status === 'running') && !entry.error && <p className="small-copy">Checking the existing job until a response or terminal status is returned. This does not submit another AI request.</p>}
      {entry.job?.status === 'completed' && entry.job.answer && !topic.contributions.some((item) => item.ai?.jobId === entry.job!.id) && <><p className="small-copy">Model-generated · {entry.job.model ?? 'model not reported'} · check important facts</p><p className="civic-user-text">{entry.job.answer}</p><CivicAiSources sources={entry.job.sources} /></>}
      {entry.job?.status === 'completed' && <p>The model response is stored with the topic. Reload the topic if it is not yet visible below.</p>}
      {!entry.pending && <div className="civic-toolbar"><button type="button" onClick={() => state.check(entry.topicId, entry.contributionId)}>Check this AI job</button>
        {topic.phase === 'discussion' && (!entry.job || entry.job.retryable) && <button type="button" onClick={() => state.start(entry.topicId, entry.contributionId)}>{entry.job ? 'Retry this same AI job' : 'Ask City AI for this saved tag'}</button>}
      </div>}
    </article>)}
  </section>;
}

function CivicPrivacy() {
  return <div className="civic-disclosure small-copy"><p>{CIVIC_ELIGIBILITY}</p><p>Topics and contributions are public to signed-in accounts. Do not include names, addresses or other personal data. Individual voters and account identifiers are not shown here; the operator can read stored votes. This is not cryptographic ballot anonymity. A source-linked topic is a user-authored opinion, never a municipal decision.</p></div>;
}

function CreateTopic({ request, cityId, seed, onCreated, onCancel, ai }: {
  request: AuthorizedRequest; cityId: string; seed: { title: string; source: string }; onCreated: (topic: CivicTopic) => void; onCancel: () => void; ai: CivicAiState;
}) {
  const [title, setTitle] = useState(seed.title);
  const [context, setContext] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [source, setSource] = useState(seed.source);
  const mutation = useCivicWrite(request);
  return <section className="civic-row">
    <h3>Start a topic in {cityName(cityId)}</h3>
    <p>Describe a question people can discuss. You choose the poll question and options now; they cannot be edited after creation. Add arguments before marking it ready.</p>
    <form onSubmit={(event) => { event.preventDefault(); mutation.run({ action: 'create', cityId, title, context, question, options, ...(source.trim() ? { sourceUrl: source.trim() } : {}) }, (created) => { onCreated(created); if (hasCityAiTag(context) && created.canRequestAi) ai.start(created.id, null); }); }}>
      <fieldset disabled={mutation.blocked} className="civic-form-fields">
        <legend className="sr-only">New topic</legend>
        <label>Topic title<input required maxLength={CIVIC_LIMITS.title} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Context and reasons<textarea required rows={4} maxLength={CIVIC_LIMITS.context} value={context} onChange={(event) => setContext(event.target.value)} /></label>
        <button type="button" disabled={hasCityAiTag(context) || context.length + 10 > CIVIC_LIMITS.context} onClick={() => setContext(`${context}${context ? '\n' : ''}@city-ai `)}>Insert @city-ai in context</button>
        <CityAiConsent />
        <label>Source link (optional, HTTPS)<input type="url" maxLength={2048} value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <p className="small-copy">The source provides context only. Its publisher does not endorse this topic or its poll.</p>
        <label>Opinion-poll question<input required maxLength={CIVIC_LIMITS.question} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
        {options.map((option, index) => <label key={index}>Option {index + 1}<input required maxLength={CIVIC_LIMITS.option} value={option} onChange={(event) => setOptions(options.map((value, at) => at === index ? event.target.value : value))} /></label>)}
        <p className="small-copy">Provide 2–{CIVIC_LIMITS.options} distinct options. Include an undecided option if useful.</p>
        <div className="civic-toolbar">{options.length < CIVIC_LIMITS.options && <button type="button" onClick={() => setOptions([...options, ''])}>Add option</button>}{options.length > 2 && <button type="button" onClick={() => setOptions(options.slice(0, -1))}>Remove last option</button>}</div>
        <button type="submit" className="button primary">Create topic</button>
      </fieldset>
    </form>
    <WriteFeedback state={mutation} />
    {mutation.conflict && <button type="button" onClick={mutation.refreshed}>Review the entered topic again</button>}
    <button type="button" disabled={mutation.pending || !!mutation.uncertain} onClick={onCancel}>Discard new topic draft</button>
  </section>;
}

function TopicDetail({ request, topic, onUpdated, onBack, ai }: {
  request: AuthorizedRequest; topic: CivicTopic; onUpdated: (topic: CivicTopic) => void; onBack: () => void; ai: CivicAiState;
}) {
  const mutation = useCivicWrite(request);
  const [discussion, setDiscussion] = useState('');
  const [argument, setArgument] = useState('');
  const [stance, setStance] = useState<'pro' | 'con'>('pro');
  const [parentId, setParentId] = useState<string | null>(null);
  const [linkCity, setLinkCity] = useState('');
  const [choice, setChoice] = useState<number | null>(null);
  const [review, setReview] = useState<{ choice: number; version: number } | null>(null);
  const [confirmStage, setConfirmStage] = useState<'ready' | 'close' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [shareUrl] = useState(() => typeof window === 'undefined' ? '' : civicShareUrl(window.location.href, topic.id));
  const argumentInput = useRef<HTMLTextAreaElement>(null);
  const detailTop = useRef<HTMLHeadingElement>(null);
  const blocked = mutation.blocked || refreshing;
  const parent = topic.contributions.find((item) => item.id === parentId);
  const eligibleLinks = CIVIC_CITIES.filter((city) => city.id !== topic.cityId && !topic.linkedCityIds.includes(city.id));
  const hasBothSides = topic.contributions.some((item) => item.stance === 'pro') && topic.contributions.some((item) => item.stance === 'con');
  const saved = (updated: CivicTopic) => { onUpdated(updated); setNotice('Saved. The latest topic is shown.'); setConfirmStage(null); };
  async function reload() {
    setRefreshing(true); setReadError('');
    try {
      const result = await request<{ topic: CivicTopic }>(`/api/civic?topic=${encodeURIComponent(topic.id)}`);
      onUpdated(result.topic); mutation.refreshed(); setReview(null); setConfirmStage(null); setNotice('Latest topic loaded. Review any changes before submitting.');
    } catch (error) { setReadError(errorMessage(error)); }
    finally { setRefreshing(false); }
  }
  const transition = (action: 'ready' | 'open' | 'close') => mutation.run({ action, topicId: topic.id, version: topic.version }, saved);
  return <>
    <div className="civic-toolbar"><button type="button" disabled={mutation.pending || !!mutation.uncertain} onClick={onBack}>Back to {cityName(topic.cityId)} topics</button><button type="button" disabled={mutation.pending || refreshing} onClick={() => void reload()}>{refreshing ? 'Reloading…' : 'Reload latest topic'}</button></div>
    <h3 ref={detailTop} tabIndex={-1} className="civic-section-heading">Topic context</h3>
    <p className="civic-user-text">{topic.context}</p>
    {topic.canRequestAi && <button type="button" disabled={blocked} onClick={() => ai.start(topic.id, null)}>Ask or resume City AI for this saved context</button>}
    {topic.sourceUrl && <p><a href={topic.sourceUrl} target="_blank" rel="noopener noreferrer">Read the topic’s source context</a> · user-provided reference, not endorsement</p>}
    <p className="small-copy">Origin: {cityName(topic.cityId)} · content revision {topic.version}. {topic.phase !== 'discussion' && 'The question, options and contributions are frozen.'}</p>
    {notice && <p role="status">{notice}</p>}
    {readError && <p role="alert" className="civic-error">{readError}</p>}
    <WriteFeedback state={mutation} />
    <CivicAiJobs state={ai} topic={topic} />
    <section className="civic-row" aria-label="General discussion">
      <h3>Discussion</h3>
      {!topic.contributions.some((item) => item.stance === 'discussion') && <p>No general discussion yet.</p>}
      <ol className="civic-discussion-list">{topic.contributions.filter((item) => item.stance === 'discussion').map((item) => <li key={item.id}>
        {item.ai && <CivicAiAttribution metadata={item.ai} />}
        <p className="civic-user-text">{item.text}</p><small>{new Date(item.createdAt).toLocaleString()}</small>
        {item.canRequestAi && <button type="button" disabled={blocked} onClick={() => ai.start(topic.id, item.id)}>Ask or resume City AI for this saved tag</button>}
      </li>)}</ol>
      {topic.phase === 'discussion' && <form onSubmit={(event) => {
        event.preventDefault();
        mutation.run({ action: 'contribute', topicId: topic.id, version: topic.version, stance: 'discussion', text: discussion, parentId: null }, (updated, contributionId) => {
          saved(updated); setDiscussion('');
          if (contributionId && hasCityAiTag(discussion) && updated.contributions.some((item) => item.id === contributionId && item.canRequestAi)) ai.start(updated.id, contributionId);
        });
      }}>
        <fieldset disabled={blocked} className="civic-form-fields"><legend className="sr-only">Add discussion</legend>
          <label>General comment or question<textarea required rows={3} maxLength={CIVIC_LIMITS.contribution} value={discussion} onChange={(event) => setDiscussion(event.target.value)} /></label>
          <button type="button" disabled={hasCityAiTag(discussion) || discussion.length + 10 > CIVIC_LIMITS.contribution} onClick={() => setDiscussion(`${discussion}${discussion ? '\n' : ''}@city-ai `)}>Insert @city-ai in comment</button>
          <CityAiConsent />
          <button type="submit">Add to discussion</button>
        </fieldset>
      </form>}
    </section>
    <CivicArguments contributions={topic.contributions} canReply={topic.phase === 'discussion' && !blocked} onReply={(id) => { setParentId(id); argumentInput.current?.focus(); }} />
    {topic.contributions.some((item) => item.stance !== 'discussion' && item.canRequestAi) && <div className="civic-ai-recovery"><h4>Your tagged arguments</h4>{topic.contributions.filter((item) => item.stance !== 'discussion' && item.canRequestAi).map((item) => <div key={item.id}><p className="civic-user-text">{item.text}</p><button type="button" disabled={blocked} onClick={() => ai.start(topic.id, item.id)}>Ask or resume City AI for this argument</button></div>)}</div>}
    {topic.phase === 'discussion' && <section className="civic-row"><h3>Add a pro or con argument</h3>
      <p>Classify the argument relative to the poll question: <strong>{topic.question}</strong></p>
      <form onSubmit={(event) => {
        event.preventDefault();
        mutation.run({ action: 'contribute', topicId: topic.id, version: topic.version, stance, text: argument, parentId }, (updated, contributionId) => {
          saved(updated); setArgument(''); setParentId(null);
          if (contributionId && hasCityAiTag(argument) && updated.contributions.some((item) => item.id === contributionId && item.canRequestAi)) ai.start(updated.id, contributionId);
        });
      }}>
        <fieldset disabled={blocked} className="civic-form-fields"><legend className="sr-only">Structured argument</legend>
          {parent ? <div><p>Replying to: <span className="civic-user-text">{parent.text}</span></p><button type="button" onClick={() => setParentId(null)}>Make this a top-level argument</button></div> : <p>Top-level argument. Select an existing argument to reply to it.</p>}
          <label>Argument position<select value={stance} onChange={(event) => setStance(event.target.value as 'pro' | 'con')}><option value="pro">Pro · in favour</option><option value="con">Con · against</option></select></label>
          <label>Argument and reasoning<textarea ref={argumentInput} required rows={3} maxLength={CIVIC_LIMITS.contribution} value={argument} onChange={(event) => setArgument(event.target.value)} /></label>
          <button type="button" disabled={hasCityAiTag(argument) || argument.length + 10 > CIVIC_LIMITS.contribution} onClick={() => { setArgument(`${argument}${argument ? '\n' : ''}@city-ai `); argumentInput.current?.focus(); }}>Insert @city-ai in argument</button>
          <CityAiConsent />
          <button type="submit">Add {stance} argument</button>
        </fieldset>
      </form>
    </section>}
    <section className="civic-row" aria-label="Opinion poll">
      <h3>{topic.phase === 'closed' ? 'Frozen opinion-poll result' : 'Review the opinion poll'}</h3>
      <p><strong>{topic.question}</strong></p>
      <ol>{topic.options.map((option, index) => <li key={index}>{option}</li>)}</ol>
      <p className="small-copy">{CIVIC_ELIGIBILITY} Votes are stored by the operator, not cryptographically anonymous.</p>
      {topic.phase === 'discussion' && <>
        <p>Readiness needs at least one pro and one con argument. Marking ready permanently freezes the question, options and all contributions. There is no edit or reopen step. Finish reviewing any requested City AI response first: a pending response cannot be appended after freezing.</p>
        {!hasBothSides && <p>Add the missing pro or con position before marking ready.</p>}
        {topic.canManage ? confirmStage === 'ready' ? <div className="civic-review"><p>Have you reviewed the question, every option and both sides above? Freeze this exact revision {topic.version}?</p><button type="button" disabled={blocked} onClick={() => transition('ready')}>Confirm ready and freeze content</button><button type="button" disabled={blocked} onClick={() => setConfirmStage(null)}>Keep discussing</button></div> : <button type="button" disabled={blocked || !hasBothSides} onClick={() => setConfirmStage('ready')}>Review readiness</button> : <p>The topic author decides when it is ready.</p>}
      </>}
      {topic.phase === 'ready' && <><p>Content is frozen. Review the arguments and options before the opinion poll opens.</p>{topic.canManage ? <button type="button" disabled={blocked} onClick={() => transition('open')}>Open this opinion poll</button> : <p>Waiting for the topic author to open the opinion poll.</p>}</>}
      {topic.phase === 'open' && <>
        <p>{topic.voteCount} account choice{topic.voteCount === 1 ? '' : 's'} recorded so far. Tallies are published only on close.</p>
        {topic.ownVote !== null ? <p role="status">Your recorded choice: <strong>{topic.options[topic.ownVote]}</strong>. Each account can vote once; it cannot change its choice.</p> : <form onSubmit={(event) => { event.preventDefault(); if (choice !== null) setReview({ choice, version: topic.version }); }}>
          <fieldset disabled={blocked || review !== null} className="civic-form-fields"><legend>Your one account choice</legend>{topic.options.map((option, index) => <label className="civic-choice" key={index}><input type="radio" name={`civic-choice-${topic.id}`} required checked={choice === index} onChange={() => setChoice(index)} />{option}</label>)}<button type="submit" disabled={choice === null}>Review my choice</button></fieldset>
          {review && <div className="civic-review"><h4>Confirm your choice</h4><p>{topic.question}</p><p><strong>{topic.options[review.choice]}</strong> · revision {review.version}</p><p>This choice cannot be changed. No wallet transaction is required.</p><button type="button" disabled={blocked} onClick={() => mutation.run({ action: 'vote', topicId: topic.id, version: review.version, choice: review.choice }, (updated) => { saved(updated); setReview(null); })}>Cast this one choice</button><button type="button" disabled={blocked} onClick={() => setReview(null)}>Change before casting</button></div>}
        </form>}
        {topic.canManage && <div className="civic-close"><p>As the topic author, you can close voting and freeze the result. Closing cannot be undone.</p>{confirmStage === 'close' ? <><p>Close now? The server includes all choices recorded before closure, which may exceed this last loaded count.</p><button type="button" disabled={blocked} onClick={() => transition('close')}>Confirm close and freeze result</button><button type="button" disabled={blocked} onClick={() => setConfirmStage(null)}>Keep voting open</button></> : <button type="button" disabled={blocked} onClick={() => setConfirmStage('close')}>Review closing this poll</button>}</div>}
      </>}
      {topic.phase === 'closed' && topic.result && <>
        <p>Closed {new Date(topic.result.closedAt).toLocaleString()} · <strong>{topic.result.total} recorded account choices</strong> (the denominator, not eligible residents).</p>
        <dl className="civic-tally">{topic.options.map((option, index) => <div key={index}><dt>{option}</dt><dd>{topic.result!.counts[index]} / {topic.result!.total}{topic.result!.total > 0 ? ` · ${(topic.result!.counts[index] / topic.result!.total * 100).toFixed(1)}%` : ' · no choices recorded'}</dd></div>)}</dl>
        <p>Snapshot hash (SHA-256)</p><code className="civic-hash">{topic.result.hash}</code>
        <p className="small-copy">Integrity digest of the frozen content and tally, not an onchain anchor, signature, proof of anonymity or official decision. Linking another city does not change this ballot or result.</p>
        <button type="button" onClick={() => { detailTop.current?.focus(); detailTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Back to topic context</button>
      </>}
    </section>
    <section className="civic-row" aria-label="City exchange and sharing"><h3>One topic, shared across cities</h3>
      <p>Origin: {cityName(topic.cityId)}. Also listed in: {topic.linkedCityIds.length ? topic.linkedCityIds.map(cityName).join(', ') : 'no other cities yet'}.</p>
      <p>The author can link this topic into another city’s list. Everyone can share its public topic link below. The topic ID, arguments and opinion poll stay the same; this does not create another ballot or imply a city’s endorsement.</p>
      {topic.canManage && eligibleLinks.length > 0 && topic.linkedCityIds.length < CIVIC_LIMITS.linkedCities && <form onSubmit={(event) => { event.preventDefault(); if (linkCity) mutation.run({ action: 'link-city', topicId: topic.id, version: topic.version, cityId: linkCity }, (updated) => { saved(updated); setLinkCity(''); }); }}><fieldset disabled={blocked} className="civic-form-fields"><legend className="sr-only">Link existing topic to another city</legend><label>Link to city<select required value={linkCity} onChange={(event) => setLinkCity(event.target.value)}><option value="">Choose another city</option>{eligibleLinks.map((city) => <option value={city.id} key={city.id}>{city.name}</option>)}</select></label><button type="submit">Link this topic to city</button></fieldset></form>}
      <label>Canonical topic ID<input readOnly value={topic.id} /></label>
      <label>Share this topic (sign-in required)<input readOnly value={shareUrl} onFocus={(event) => event.target.select()} /></label>
      <button type="button" onClick={() => {
        if (!navigator.clipboard) { setNotice('Copy was unavailable. Select and copy the share link above.'); return; }
        void navigator.clipboard.writeText(shareUrl).then(() => setNotice('Topic link copied. Recipients must sign in.'), () => setNotice('Copy was unavailable. Select and copy the share link above.'));
      }}>Copy topic link</button>
    </section>
    <button type="button" disabled={mutation.pending || !!mutation.uncertain} onClick={onBack}>Back to {cityName(topic.cityId)} topics</button>
  </>;
}

export function NativeCivicPanel({ request, cityId }: { request: AuthorizedRequest; cityId: string }) {
  const search = useSearchParams();
  const urlTopic = search?.get('civicTopic') ?? null;
  const urlCity = search?.get('civicCity') ?? null;
  const urlSource = search?.get('civicSource') ?? null;
  const urlTitle = search?.get('civicTitle') ?? '';
  const [scope, setScope] = useState(isCivicCity(cityId) ? cityId : '');
  const [topicId, setTopicId] = useState<string | null>(null);
  const [topic, setTopic] = useState<CivicTopic | null>(null);
  const [list, setList] = useState<CivicTopicList>({ topics: [], nextCursor: null });
  const [creating, setCreating] = useState(false);
  const [seed, setSeed] = useState({ title: '', source: '' });
  const [seedKey, setSeedKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const ai = useCityAi(request);
  const completedAi = ai.entries.filter((entry) => entry.topicId === topicId && entry.job?.status === 'completed').map((entry) => entry.job!.id).join(',');
  const [seenLocation, setSeenLocation] = useState('');
  const locationKey = JSON.stringify([urlTopic, urlCity, urlSource, urlTitle]);
  if (seenLocation !== locationKey) {
    setSeenLocation(locationKey);
    setTopicId(urlTopic);
    setTopic((previous) => previous?.id === urlTopic ? previous : null);
    if (urlCity && isCivicCity(urlCity)) setScope(urlCity);
    if (!urlTopic && urlSource !== null) {
      setSeed({ title: urlTitle.slice(0, CIVIC_LIMITS.title), source: urlSource.slice(0, 2048) });
      setSeedKey((value) => value + 1); setCreating(true);
    } else setCreating(false);
  }
  if (!scope && !urlCity && !urlTopic && isCivicCity(cityId)) setScope(cityId);
  const readKey = JSON.stringify([scope, topicId, revision]);
  const [readIdentity, setReadIdentity] = useState({ request, key: '' });
  if (readIdentity.request !== request || readIdentity.key !== readKey) {
    setReadIdentity({ request, key: readKey });
    setLoading(Boolean(topicId || isCivicCity(scope))); setError('');
    if (!topicId) setList({ topics: [], nextCursor: null });
  }
  useEffect(() => {
    if (!topicId && !isCivicCity(scope)) return;
    let cancelled = false;
    const ticket = ++generation.current;
    if (topicId) {
      void request<{ topic: CivicTopic }>(`/api/civic?topic=${encodeURIComponent(topicId)}`).then((result) => {
        if (cancelled || ticket !== generation.current) return;
        setTopic(result.topic);
      }).catch((cause) => { if (!cancelled && ticket === generation.current) setError(errorMessage(cause)); }).finally(() => { if (!cancelled && ticket === generation.current) setLoading(false); });
    } else {
      void request<CivicTopicList>(`/api/civic?city=${encodeURIComponent(scope)}`).then((result) => {
        if (!cancelled && ticket === generation.current) setList(result);
      }).catch((cause) => { if (!cancelled && ticket === generation.current) setError(errorMessage(cause)); }).finally(() => { if (!cancelled && ticket === generation.current) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [request, scope, topicId, revision]);
  useEffect(() => {
    if (!topicId || !completedAi) return;
    const ticket = generation.current;
    let cancelled = false;
    void request<{ topic: CivicTopic }>(`/api/civic?topic=${encodeURIComponent(topicId)}`).then((result) => {
      if (!cancelled && ticket === generation.current) setTopic(result.topic);
    }).catch((cause) => { if (!cancelled && ticket === generation.current) setError(`City AI finished, but the topic could not be refreshed: ${errorMessage(cause)}`); });
    return () => { cancelled = true; };
  }, [completedAi, request, topicId]);
  function navigate(id: string | null, city = scope) {
    generation.current++; setTopicId(id); setTopic(null); setCreating(false); setError('');
    const url = new URL(civicTopicUrl(window.location.href, id));
    url.searchParams.set('civicCity', city);
    url.searchParams.delete('civicSource'); url.searchParams.delete('civicTitle');
    window.history.pushState(window.history.state, '', url);
  }
  function openTopic(selected: CivicTopic) { navigate(selected.id); setTopic(selected); }
  async function loadMore() {
    if (loading || !list.nextCursor) return;
    const ticket = generation.current;
    setLoading(true); setError('');
    try {
      const page = await request<CivicTopicList>(`/api/civic?city=${encodeURIComponent(scope)}&cursor=${encodeURIComponent(list.nextCursor)}`);
      if (ticket === generation.current) setList((current) => ({ topics: [...current.topics, ...page.topics.filter((item) => !current.topics.some((old) => old.id === item.id))], nextCursor: page.nextCursor }));
    } catch (cause) { if (ticket === generation.current) setError(errorMessage(cause)); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  const current = topic?.id === topicId ? topic : null;
  return <section id="native-civic" tabIndex={-1} className="city-participation native-civic" aria-label="Native city discussion and opinion polls">
    <Hero title={current?.title ?? (topicId ? 'City topic' : scope ? `Have your say · ${cityName(scope)}` : 'Choose a city to discuss')} status={<StatusLine tone={current?.phase === 'open' ? 'action' : 'neutral'}>{current ? PHASE_LABEL[current.phase] : 'Native city discussion · account opinion polls'}</StatusLine>}>
      <p>{current ? 'Discuss the question, weigh its arguments and inspect the same opinion poll across city contexts.' : 'Start with a local question. Discuss, compare pros and cons, then record an account opinion.'}</p>
    </Hero>
    <CivicPrivacy />
    {error && <div role="alert" className="civic-error"><p>{error}</p><button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Reload {topicId ? 'topic' : 'city topics'}</button></div>}
    {loading && <p role="status">Loading {topicId ? 'topic' : 'city topics'}…</p>}
    {topicId ? current ? <TopicDetail key={current.id} request={request} topic={current} ai={ai} onUpdated={(updated) => { generation.current++; setLoading(false); setTopic(updated); }} onBack={() => { setScope(current.cityId); navigate(null, current.cityId); }} /> : <button type="button" onClick={() => navigate(null)}>Back to city topics</button> : <>
      <div className="civic-row"><label>Browse a city’s topics<select value={scope} disabled={creating} onChange={(event) => { generation.current++; setScope(event.target.value); setCreating(false); const url = new URL(window.location.href); url.searchParams.set('civicCity', event.target.value); url.searchParams.delete('civicSource'); url.searchParams.delete('civicTitle'); window.history.replaceState(window.history.state, '', url); }}><option value="" disabled>Choose a discussion city</option>{CIVIC_CITIES.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}</select></label><p className="small-copy">This browsing choice does not change your saved home city, establish residency or imply published map coverage.{creating && ' Finish or explicitly discard this draft before changing city or opening another topic.'}</p></div>
      {!creating && <button type="button" className="button primary" disabled={!isCivicCity(scope)} onClick={() => { setSeed({ title: '', source: '' }); setSeedKey((value) => value + 1); setCreating(true); }}>Start a topic</button>}
      {creating && <CreateTopic key={`${scope}-${seedKey}`} request={request} cityId={scope} seed={seed} ai={ai} onCreated={openTopic} onCancel={() => setCreating(false)} />}
      <section className="civic-row" aria-label="City topics"><h3>Topics in {cityName(scope)}</h3>
        {!loading && !error && list.topics.length === 0 && <p>{!scope ? 'Choose a city above to browse or start a topic.' : list.nextCursor ? 'No matching topics in this page. Continue loading to check the remaining topics.' : 'No topics found in this city. Start the first question.'}</p>}
        <ul className="civic-topic-list">{list.topics.map((item) => <li key={item.id}><button type="button" disabled={creating} onClick={() => openTopic(item)}><strong>{item.title}</strong><span>{PHASE_LABEL[item.phase]} · {item.contributions.length} contributions{item.phase === 'closed' && item.result ? ` · ${item.result.total} account choices` : ''}</span><small>{item.cityId === scope ? 'Originating here' : `Shared from ${cityName(item.cityId)} · same topic and poll`}</small></button></li>)}</ul>
        {list.nextCursor && <button type="button" disabled={loading || creating} onClick={() => void loadMore()}>Load more city topics</button>}
        <button type="button" disabled={loading || creating || !scope} onClick={() => setRevision((value) => value + 1)}>Refresh city topics</button>
      </section>
    </>}
  </section>;
}
