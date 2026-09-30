'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { civicOutcomeEvidence, MUNSTER_BUS_TRIAL_ID, type CivicOutcomeEvidence } from '@/data/civic-outcome-evidence';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import type { CityFeature, Signal } from '@/server/city-signals';
import { displayStatus, PRECISION_LABELS, REVIEW_LABELS } from './personal-map-relevance';
import { PersonalMap } from './personal-map';
import { CITY_CHANGED_EVENT, useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { CityFeedList, eventTimeState, useCityFeed, useEventClock } from './city-feed';
import { CivicLoop } from './civic-loop';
import { SYSTEM_NODES, type SystemNodeId } from './civic-system';
import { CIVIC_NAVIGATION_INTENT, openLocalInvestment, type Area } from './areas';
import { caseForTarget, targetForSignal, targetKey, type FollowTarget, type ProjectChange } from './project-following';
import { readCurrentProjectSnapshot, readPublicSignal, useProjectFollowing } from './use-project-following';
import { ProjectFollowButton } from './project-follow-button';
import { projectDisplayName } from './project-display-name';
import { strausbergOrganizations } from '@/data/cities/strausberg-organizations';
import { OrganizationDetail, OrganizationShelf } from './organization-profile';
import { consultationGroups, displayCityText, formatCityDate, formatCityEventDate, shortlistFeatures } from './city-coverage';

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const noFeatures: CityFeature[] = [];
function quantity(value: number | string, unit?: string) {
  return `${typeof value === 'number' ? unit === 'EUR' ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value) : number.format(value) : value}${unit && unit !== 'EUR' ? ` ${unit}` : ''}`;
}
function Evidence({ caseStudy, feature }: { caseStudy?: CivicOutcomeEvidence; feature?: Signal }) {
  return <details className="civic-evidence"><summary>Evidence, review &amp; geometry</summary>
    {feature && <><p>{displayCityText(feature.properties.statement)}</p><p>Source status (original wording): {displayCityText(feature.properties.status || 'not established')} · as of {formatCityDate(feature.properties.asOf)} · review: {REVIEW_LABELS[feature.properties.reviewState]} · location: {PRECISION_LABELS[feature.properties.geometryPrecision]} ({feature.geometry?.type ?? 'unlocated'}).</p>
      {feature.properties.sources.map((source, index) => <p key={`${source.url}\0${source.locator}\0${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher} ↗</a> · {source.publisher} · {source.locator} · retrieved {formatCityDate(source.retrievedAt)} · {source.licence} ({source.reuse})</p>)}
      {feature.properties.unknowns.length > 0 && <p>Unresolved: {feature.properties.unknowns.join('; ')}</p>}</>}
    {caseStudy && <><p>{caseStudy.geometryNote}</p><p>{caseStudy.comparisonCaveat}</p><p><strong>Evidence needed:</strong> {caseStudy.missingEvidence.join('; ')}. Missing in these reviewed records does not mean nobody measured it elsewhere.</p><p>Research checked {formatCityDate(caseStudy.checkedAt)}. Source publications and automated checks are not human review.</p>
      {[...caseStudy.outputs, ...caseStudy.metrics, ...(caseStudy.relations ?? []), ...(caseStudy.spending ? [caseStudy.spending.planned, caseStudy.spending.recorded] : []), ...(caseStudy.indicator ? [{ ...caseStudy.indicator.baseline, label: 'Full-route before-trial measurement' }, { ...caseStudy.indicator.followUp, label: 'Full-route during-trial measurement' }] : [])].map((item, index) => <p key={`${index}:${item.locator}`}><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{'from' in item ? `${item.from} → ${item.predicate} → ${item.to}` : item.label} ↗</a> · {item.locator}{'basis' in item ? ` · ${item.basis}` : ''}{'date' in item && item.date ? ` · ${formatCityDate(item.date)}` : ''}{'period' in item && item.period ? ` · ${item.period}` : ''}</p>)}</>}
    {!caseStudy && !feature && <p>No source record or mapped geometry for this selection.</p>}
  </details>;
}
function ObservedIndicator({ indicator }: { indicator: NonNullable<CivicOutcomeEvidence['indicator']> }) {
  const { baseline, followUp } = indicator;
  const difference = followUp.value - baseline.value;
  const max = Math.max(baseline.value, followUp.value, 1);
  return <section className="civic-indicator" aria-label="Before and during measured bus travel time">
    <span className="eyebrow">OBSERVED · SAME FULL ROUTE</span><h3>{indicator.label}</h3>
    <div className="civic-indicator-bars">{[
      { label: 'Before trial', sample: baseline },
      { label: 'During trial', sample: followUp },
    ].map(({ label, sample }) => <div key={label}>
      <span>{label} · {sample.period}</span><div className="civic-indicator-bar"><i style={{ width: `${Math.max(0, sample.value) / max * 100}%` }} /></div>
      <strong>{sample.value} {indicator.unit}</strong><small>{Math.floor(sample.value / 60)}:{String(sample.value % 60).padStart(2, '0')} min</small>
    </div>)}</div>
    <p><strong>{difference === 0 ? 'No change' : `${Math.abs(difference)} seconds ${difference > 0 ? 'higher' : 'lower'} observed mean`}</strong>{baseline.value > 0 ? ` (${(Math.abs(difference) / baseline.value * 100).toFixed(1)}%)` : ''}; not an isolated intervention effect.</p>
    <details><summary>Measurement method &amp; tradeoffs</summary><p>{indicator.boundary} {indicator.method}</p><p>{indicator.caveat}</p></details>
  </section>;
}
function Outcomes({ caseStudy, feature }: { caseStudy?: CivicOutcomeEvidence; feature?: CityFeature }) {
  const outputs = caseStudy?.outputs ?? [];
  const metrics = caseStudy?.metrics.filter((metric) => !outputs.some((output) =>
    metric.value === output.value && metric.unit === output.unit && metric.basis === output.basis)) ?? [];
  return <div className="civic-outcomes" aria-label="Project outputs and outcomes">
    <div className="civic-lifecycle" aria-label="Lifecycle stages; only the published stage below is evidenced"><span className="civic-state">① Plan</span><span className="civic-state">② Decision</span><span className="civic-state">③ Delivery</span><span className={`civic-state${caseStudy?.indicator ? ' is-observed' : ' is-unknown'}`}>{caseStudy?.indicator ? '④ Before/during' : '④ Outcome?'}</span></div>
    <p className="civic-stage">Published stage: <strong>{feature ? displayStatus(feature) : outputs.length ? `${outputs[0].basis === 'planned' ? 'Planned' : 'Reported'} · ${outputs[0].label}` : 'not established'}</strong> <span>≠ measured success</span></p>
    {outputs.map((output) => <div className={`civic-output civic-${output.basis}`} key={`${output.label}:${output.locator}`}><span>{output.basis === 'planned' ? '◌ Plan' : '■ Reported physical output'}</span><strong>{quantity(output.value, output.unit)}</strong><small>{output.label}</small></div>)}
    {caseStudy?.spending && <section className="civic-spending" aria-label="Planned and provisional trial expenditure"><span className="eyebrow">COST · NOT A FUNDING LINEAGE</span><div><p><strong>{quantity(caseStudy.spending.planned.value, caseStudy.spending.planned.unit)}</strong> forecast</p><p><strong>{caseStudy.spending.recorded.value}</strong> recorded through 2021</p></div><small>{caseStudy.spending.caveat}</small></section>}
    {caseStudy?.indicator && <ObservedIndicator indicator={caseStudy.indicator} />}
    <div className="civic-metrics">{metrics.map((metric) => {
      const peers = metrics.filter((candidate) => candidate.unit === metric.unit && candidate.label === metric.label);
      const max = Math.max(0, ...peers.map((candidate) => candidate.value));
      return <div className={`civic-metric civic-${metric.basis}`} key={metric.id}><span>{metric.basis === 'observed' ? '━ Measured' : metric.basis === 'planned' ? '┄ Planned' : '■ Reported output'}</span><strong>{quantity(metric.value, metric.unit)}</strong><small>{metric.label}{metric.period ? ` · ${metric.period}` : ''}</small>{peers.length > 1 && max > 0 && <div className="civic-meter" aria-hidden="true"><i style={{ width: `${metric.value / max * 100}%` }} /></div>}</div>;
    })}</div>
    <div className="civic-gap"><span aria-hidden="true">◇ {caseStudy?.indicator ? '≠' : '?'}</span><div><strong>{caseStudy?.indicator ? 'Observed change ≠ proven causal benefit' : 'Outcome evidence missing'}</strong><small>{caseStudy?.benefitIndicatorMissing?.replace(/\bbaseline\b/gi, 'before measurement') ?? 'Before and after benefit measurements · not in reviewed sources'}</small></div></div>
    {!feature?.geometry && <p className="civic-unlocated">No verified geometry · this selection has no map pin or affected-area claim.</p>}
  </div>;
}
export function CivicPlaceLenses({ request, accountId, onExplorationCityChange, onCityChange, go }: { request: AuthorizedRequest; accountId: string; onExplorationCityChange?: (cityId: string) => void; onCityChange?: () => void; go: (area: Area) => void }) {
  const eventClock = useEventClock();
  const [explorationCity, setExplorationCity] = useState('');
  const { cityId, result, error, cityDisplayName, selectedCity } = useCitySignals(request, explorationCity || undefined);
  const [nearest, setNearest] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (result?.state !== 'not_covered' || !cityDisplayName || explorationCity) return;
    let active = true;
    request<{ nearest: { id: string; name: string } | null }>('/api/places/nearest')
      .then(({ nearest }) => { if (active) setNearest(nearest); })
      .catch(() => { if (active) setNearest(null); });
    return () => { active = false; };
  }, [request, result?.state, cityDisplayName, explorationCity]);
  useEffect(() => { onExplorationCityChange?.(result?.state === 'covered' ? cityId : ''); }, [cityId, result?.state, onExplorationCityChange]);
  const { result: feedResult, error: feedError } = useCityFeed(request, cityId);
  const events = useMemo(() => feedResult?.state === 'available' ? feedResult.feed.items.filter((item) => item.kind === 'event') : [], [feedResult]);
  const [eventSelection, setEventSelection] = useState<{ cityId: string; id: string } | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ cityId: string; id: string; signalId?: string } | null>(null);
  const [investmentId, setInvestmentId] = useState<TestCityInvestmentId | null>(null);
  useEffect(() => {
    const reset = () => { setExplorationCity(''); setSelection(null); setInvestmentId(null); };
    window.addEventListener(CITY_CHANGED_EVENT, reset);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, reset);
  }, []);
  const [showInvestments, setShowInvestments] = useState(false);
  const [lens, setLens] = useState<'map' | 'outcomes' | 'connections'>('map');
  const [mode, setMode] = useState<'observed' | 'scenario'>('observed');
  const [node, setNode] = useState<SystemNodeId>('public');
  const [full, setFull] = useState<{ cityId: string; id: string; revision: number; feature?: Signal; error?: string; loading?: boolean } | null>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  const reviewGeneration = useRef(0);
  const advanceReview = useCallback(() => {
    reviewGeneration.current += 1;
    setReviewRevision(reviewGeneration.current);
  }, []);
  const following = useProjectFollowing(accountId, request);
  const [followingTarget, setFollowingTarget] = useState<string | null>(null);
  const [followError, setFollowError] = useState('');
  const active = useRef(true);
  const latestAccount = useRef(accountId);
  const latestSelection = useRef<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const revealDetail = useRef(false);
  useEffect(() => { latestAccount.current = accountId; return () => { latestAccount.current = ''; }; }, [accountId]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    function consumeIntent() {
      const raw = sessionStorage.getItem(CIVIC_NAVIGATION_INTENT);
      if (!raw) return;
      sessionStorage.removeItem(CIVIC_NAVIGATION_INTENT);
      let intent: unknown;
      try { intent = JSON.parse(raw); } catch { return; }
      if (!intent || typeof intent !== 'object' || !('kind' in intent)) return;
      if (intent.kind === 'event' && 'cityId' in intent && typeof intent.cityId === 'string' &&
        'eventId' in intent && typeof intent.eventId === 'string') {
        advanceReview();
        queueMicrotask(() => {
          setExplorationCity(intent.cityId as string);
          setEventSelection({ cityId: intent.cityId as string, id: intent.eventId as string });
          setOrganizationId(null);
          setInvestmentId(null);
          setSelection(null);
          setLens('map');
        });
        return;
      }
      if (intent.kind === 'investment' && 'cityId' in intent && intent.cityId === 'strausberg' &&
        'projectId' in intent && TEST_CITY_INVESTMENTS.some((item) => item.id === intent.projectId)) {
        advanceReview();
        queueMicrotask(() => {
          setExplorationCity('strausberg');
          setInvestmentId(intent.projectId as TestCityInvestmentId);
          setShowInvestments(true);
          setSelection(null);
          setLens('map');
        });
      } else if (intent.kind === 'scenario' || intent.kind === 'map') {
        const destination = intent.kind;
        advanceReview();
        queueMicrotask(() => { setInvestmentId(null); setLens(destination === 'map' ? 'map' : 'connections'); setMode(destination === 'map' ? 'observed' : 'scenario'); });
      } else if ('cityId' in intent && typeof intent.cityId === 'string' &&
        'lens' in intent && (intent.lens === 'outcomes' || intent.lens === 'connections')) {
        const caseStudy = intent.kind === 'project' && 'projectId' in intent && typeof intent.projectId === 'string'
          ? civicOutcomeEvidence.find((item) => item.id === intent.projectId && item.cityId === intent.cityId) : undefined;
        const target = caseStudy?.id ??
          (intent.kind === 'signal' && 'signalId' in intent && typeof intent.signalId === 'string' ? intent.signalId : null);
        if (!target) return;
        const linkedSignalId = caseStudy && 'signalId' in intent && typeof intent.signalId === 'string'
          ? intent.signalId : undefined;
        if (linkedSignalId && !caseStudy?.signalIds.includes(linkedSignalId)) return;
        const { cityId: targetCity, lens: targetLens } = intent;
        advanceReview();
        queueMicrotask(() => {
          setExplorationCity(targetCity);
          setInvestmentId(null);
          setSelection({ cityId: targetCity, id: target, signalId: linkedSignalId });
          setLens(targetLens);
          setMode('observed');
        });
      }
    }
    window.addEventListener(CIVIC_NAVIGATION_INTENT, consumeIntent);
    consumeIntent();
    return () => window.removeEventListener(CIVIC_NAVIGATION_INTENT, consumeIntent);
  }, [advanceReview]);
  const features = result?.state === 'covered' ? result.data.signals.features : noFeatures;
  const cases = civicOutcomeEvidence.filter((item) => item.cityId === cityId);
  const selectedEvent = eventSelection?.cityId === cityId ? events.find((item) => item.id === eventSelection.id) : undefined;
  const organization = cityId === 'strausberg' ? strausbergOrganizations.find((item) => item.id === organizationId) : undefined;
  const organizationSignal = organization?.signalId ? features.find((item) => item.properties.id === organization.signalId && item.geometry?.type === 'Point') : undefined;
  const selected = investmentId || eventSelection?.cityId === cityId || organization ? null : selection?.cityId === cityId ? selection.id : cases.find((item) => item.signalIds.every((id) => features.some((feature) => feature.properties.id === id)))?.id ?? (cityId === 'strausberg' && features.some((item) => item.properties.id === 'atlas:altstadt-quartier') ? 'atlas:altstadt-quartier' : null);
  const caseStudy = cases.find((item) => item.id === selected || item.signalIds.includes(selected ?? ''));
  const linkedId = selection?.cityId === cityId && selected === caseStudy?.id ? selection.signalId : undefined;
  const feature = features.find((item) => item.properties.id === (linkedId ?? selected)) ??
    (selected === caseStudy?.id && !linkedId ? features.find((item) => caseStudy.signalIds.includes(item.properties.id)) : undefined);
  const detailReady = full?.cityId === cityId && full.id === feature?.properties.id && full.revision === reviewRevision;
  const evidenceFeature = detailReady ? full?.feature : undefined;
  useEffect(() => {
    if (!feature) return;
    let active = true;
    const id = feature.properties.id;
    queueMicrotask(() => { if (active) setFull({ cityId, id, revision: reviewRevision, loading: true }); });
    readPublicSignal(request, cityId, id)
      .then((detail) => {
        if (!active) return;
        if (!detail) throw new Error('Target missing');
        setFull({ cityId, id, revision: reviewRevision, feature: detail });
      })
      .catch(() => { if (active) setFull({ cityId, id, revision: reviewRevision, error: 'Current full public record unavailable; prior compact status is not a fresh review.' }); });
    return () => { active = false; };
  }, [cityId, feature, request, reviewRevision]);
  const eligibleFeatures = useMemo(() => result?.state === 'covered' ? shortlistFeatures(features, cityId, result.data.catalogue) : noFeatures, [result, features, cityId]);
  const available = cases.filter((item) => item.signalIds.every((id) => eligibleFeatures.some((feature) => feature.properties.id === id)) && (item.signalIds.length || item.metrics.length || item.outputs.length));
  const shortlist: { target: FollowTarget; title: string; context: string; selectionId: string }[] = [];
  const shown = new Set<string>();
  if (result?.state === 'covered') {
    for (const item of available) {
      if (item.signalIds.some((id) => !eligibleFeatures.some((feature) => feature.properties.id === id))) continue;
      const target: FollowTarget = { kind: 'case', cityId, id: item.id };
      const key = targetKey(target);
      if (shown.has(key)) continue;
      shown.add(key);
      const reported = item.outputs.some((output) => output.basis === 'observed' || output.basis === 'reported_output') ||
        item.metrics.some((metric) => metric.basis === 'observed' || metric.basis === 'reported_output');
      const planned = item.outputs.some((output) => output.basis === 'planned' || output.basis === 'estimate') ||
        item.metrics.some((metric) => metric.basis === 'planned' || metric.basis === 'estimate');
      shortlist.push({ target, title: item.title, selectionId: item.id,
        context: `Published research · ${reported ? planned ? 'reported outputs and plans' : 'reported outputs' : 'plans, not measured outcomes'} · sources checked ${formatCityDate(item.checkedAt)}` });
      if (shortlist.length === 4) break;
    }
    if (shortlist.length < 4) for (const item of eligibleFeatures) {
      const target = targetForSignal(cityId, item.properties.id);
      const key = targetKey(target);
      if (shown.has(key)) continue;
      if (target.kind === 'case' && caseForTarget(target)?.signalIds.some((id) => !eligibleFeatures.some((feature) => feature.properties.id === id))) continue;
      shown.add(key);
      shortlist.push({ target, title: target.kind === 'case' ? caseForTarget(target)!.title : item.properties.title,
        selectionId: target.id,
        context: `${item.properties.kind.replaceAll('_', ' ')} · ${displayCityText(displayStatus(item))} · source as of ${formatCityDate(item.properties.asOf)} · ${REVIEW_LABELS[item.properties.reviewState]}` });
      if (shortlist.length === 4) break;
    }
  }
  const selectedTarget: FollowTarget | null = investmentId ? null : selected && caseStudy ? { kind: 'case', cityId, id: caseStudy.id }
    : feature && feature.properties.kind !== 'place' ? targetForSignal(cityId, feature.properties.id) : null;
  const selectedKey = selectedTarget ? targetKey(selectedTarget) : null;
  useEffect(() => { latestSelection.current = selectedKey; return () => { latestSelection.current = null; }; }, [selectedKey]);
  const followedSelection = selectedTarget && following.store.entries[targetKey(selectedTarget)];
  const linkedCase = selectedTarget?.kind === 'case' ? caseForTarget(selectedTarget) : undefined;
  const linkedIds = selectedTarget?.kind === 'signal' ? [selectedTarget.id] : linkedCase?.signalIds ?? [];
  const hasPublishedTarget = Boolean(selectedTarget && (linkedIds.length
    ? result?.state === 'covered' && linkedIds.every((id) => features.some((item) => item.properties.id === id))
    : linkedCase));
  const missingSelection = Boolean(selection?.cityId === cityId && (result || error) &&
    (selection.id === caseStudy?.id ? !hasPublishedTarget : !feature));
  const canFollow = Boolean(hasPublishedTarget && !following.storageError && !followingTarget &&
    (!linkedIds.length || (!error && evidenceFeature)));
  const choose = (id: string, targetCity = cityId) => { revealDetail.current = Boolean(id); advanceReview(); setInvestmentId(null); setEventSelection(null); setOrganizationId(null); setSelection(id ? { cityId: targetCity, id } : null); setNode('public'); };
  function selectEvent(targetCity: string, id: string) {
    revealDetail.current = true;
    advanceReview();
    setExplorationCity(targetCity);
    setEventSelection({ cityId: targetCity, id });
    setOrganizationId(null);
    setInvestmentId(null);
    setSelection(null);
    setLens('map');
  }
  function selectOrganization(id: string) {
    const profile = strausbergOrganizations.find((item) => item.id === id);
    if (!profile) return;
    revealDetail.current = true;
    advanceReview();
    setExplorationCity('strausberg');
    setOrganizationId(id);
    setEventSelection(null);
    setInvestmentId(null);
    setSelection(null);
    setLens('map');
  }
  async function followCurrent(target: FollowTarget) {
    const key = targetKey(target);
    const requestedAccount = accountId;
    const requestedGeneration = reviewGeneration.current;
    setFollowingTarget(key);
    setFollowError('');
    try {
      const cityName = result?.state === 'covered' ? result.data.catalogue.name : target.cityId;
      const { snapshot, records } = await readCurrentProjectSnapshot(request, target, cityName);
      if (!active.current || latestAccount.current !== requestedAccount || latestSelection.current !== key ||
        reviewGeneration.current !== requestedGeneration) return;
      const current = records.find((record) => record.properties.id === feature?.properties.id);
      if (current) setFull({ cityId: target.cityId, id: current.properties.id, revision: reviewRevision, feature: current });
      following.add(target, snapshot);
    } catch {
      if (active.current && latestAccount.current === requestedAccount && latestSelection.current === key &&
        reviewGeneration.current === requestedGeneration)
        setFollowError('Current public source could not be read in full. Follow was not saved; try again.');
    } finally {
      if (active.current && latestAccount.current === requestedAccount) setFollowingTarget(null);
    }
  }
  function reviewFollowed(target: FollowTarget, changes?: ProjectChange[]) {
    const key = changes?.find((change) => change.key.startsWith('signal:'))?.key;
    const signalId = key?.slice('signal:'.length, key.lastIndexOf(':'));
    setExplorationCity(target.cityId);
    setEventSelection(null);
    setOrganizationId(null);
    setInvestmentId(null);
    setSelection({ cityId: target.cityId, id: target.id,
      signalId: target.kind === 'case' && signalId && caseForTarget(target)?.signalIds.includes(signalId) ? signalId : undefined });
    setLens('outcomes');
    setMode('observed');
    advanceReview();
  }
  const issuer = cityId === 'strausberg' ? TEST_CITY_INVESTMENTS.find((item) => item.id === investmentId) : undefined;
  useEffect(() => {
    if (!revealDetail.current || (selection && selection.cityId !== cityId) || (!issuer && !feature && !selectedEvent && !organization)) return;
    revealDetail.current = false;
    if (window.matchMedia('(max-width: 1000px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [issuer, feature, selectedEvent, organization, reviewRevision, selection, cityId]);
  function selectInvestment(id: TestCityInvestmentId | null) {
    if (id) revealDetail.current = true;
    advanceReview();
    setShowInvestments(id !== null);
    setInvestmentId(id);
    setEventSelection(null);
    setOrganizationId(null);
    if (id) setExplorationCity('strausberg');
    if (id) { setSelection(null); setLens('map'); }
  }
  const cityName = (result?.state === 'covered' ? result.data.catalogue.name : cityDisplayName) || undefined;
  const consultations = useMemo(() => result?.state === 'covered' ? consultationGroups(eligibleFeatures, cityId, result.data.generatedAt) : null, [result, eligibleFeatures, cityId]);
  const snapshotDate = result?.state === 'covered' ? result.data.generatedAt.slice(0, 10) : '';
  async function makeMyCity(name: string) {
    await request('/api/city', { city: name });
    setExplorationCity('');
    onCityChange?.();
  }
  if (result?.state === 'not_covered' && !cityDisplayName) return <section className="civic-look-around" id="city-system" tabIndex={-1} aria-label="Explore a covered city">
    <p>Not sure yet? Look around a covered city first; this does not choose it for you:</p>
    {(nearest ?? result.coveredCities[0]) && <button type="button" className="secondary-button" onClick={() => setExplorationCity((nearest ?? result.coveredCities[0]).id)}>{nearest ? `Look at the nearest covered city · ${nearest.name}` : `Look at ${result.coveredCities[0].name}`} →</button>}
  </section>;
  if (result?.state === 'not_covered') return <section className="card civic-place" id="city-system" tabIndex={-1}>
    <h2>{cityDisplayName} is not covered yet</h2>
    <p>We have published information for eight cities. Choose one above to make it yours, or look at a covered city without changing yours.</p>
    {(nearest ?? result.coveredCities[0]) && <button type="button" className="secondary-button" onClick={() => setExplorationCity((nearest ?? result.coveredCities[0]).id)}>{nearest ? `Look at the nearest covered city · ${nearest.name}` : `Look at ${result.coveredCities[0].name}`} →</button>}
  </section>;
  return <section className="card civic-place" id="city-system" aria-label="City place, outcomes and connections" tabIndex={-1}>
    <div className="civic-heading"><div><span className="eyebrow">PUBLISHED CITY INFORMATION</span><h2>What is changing in {cityName ?? 'your city'}</h2><p>Published snapshot from {result?.state === 'covered' ? formatCityDate(result.data.generatedAt) : 'the last collector run'} · refreshed only when the collector runs.</p></div><details className="civic-key"><summary>Map sources &amp; examples</summary><p>Public projects and places use their linked city or OpenStreetMap records. Fictional test projects are illustrative placements, not real properties or offers.</p></details></div>
    {consultations && <section className="civic-open-windows" aria-label="Participation as published">
      <h3>Where can I have a say?</h3><p>Published dates describe the source record, not a guaranteed deadline. Check the source before taking part.</p>
      {consultations.open.length ? <><strong>Open now · as published</strong><ul>{consultations.open.map((item) => <li key={item.properties.id}><button type="button" className="text-button" onClick={() => choose(item.properties.id)}>{item.properties.title}</button> · end date as published {item.properties.endDate ? formatCityDate(item.properties.endDate) : 'not supplied'}</li>)}</ul></> : <p>Nothing open as of {formatCityDate(result?.state === 'covered' ? result.data.generatedAt : '')}.</p>}
      {consultations.closed.length > 0 && <><strong>Closed recently · as published</strong><ul>{consultations.closed.map((item) => <li key={item.properties.id}><button type="button" className="text-button" onClick={() => choose(item.properties.id)}>{item.properties.title}</button> · closed {formatCityDate(item.properties.endDate!)}</li>)}</ul></>}
      {feedResult?.state === 'available' && <><strong>From the published city feed · not comment windows</strong><ul>{feedResult.feed.items.filter((item) => item.kind === 'news' || item.kind === 'event' && item.eventStart && item.eventStart >= snapshotDate).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3).map((item) => <li key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a> · {formatCityDate(item.kind === 'event' && item.eventStart ? item.eventStart : item.publishedAt)} · {item.publisher}</li>)}</ul></>}
    </section>}
    <section className="civic-selected-project" id="selected-project" tabIndex={-1} aria-label="Selected project">
    {cityId === 'strausberg' && <div className="civic-story" aria-label="Explore three city stories">
      <button type="button" onClick={() => { setExplorationCity('strausberg'); choose('atlas:altstadt-quartier', 'strausberg'); setLens('map'); }}>① Altstadt Quartier <small>Published planning area · consultation closed</small></button>
      <button type="button" onClick={() => { setExplorationCity('strausberg'); choose('osm:node-6040411543', 'strausberg'); setLens('map'); }}>② Bäckerei Klein <small>OpenStreetMap local place</small></button>
      <button type="button" className="civic-story-demo" onClick={() => selectInvestment(TEST_CITY_INVESTMENTS[0].id)}>③ Fictional test project <small>Test tokens · no rights</small></button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {missingSelection && <p role="alert">This public project is not in the current publication. Your city and saved updates have not changed.</p>}
    <div className="civic-map-row">
    <PersonalMap request={request} accountId={accountId} explorationCity={explorationCity} onMakeMyCity={makeMyCity} onExplorationCityChange={(id) => { advanceReview(); setExplorationCity(id); setSelection(null); setInvestmentId(null); setEventSelection(null); setOrganizationId(null); }}
      selectedId={organizationSignal?.properties.id ?? feature?.properties.id ?? null} onSelect={(item) => {
        const profile = cityId === 'strausberg' ? strausbergOrganizations.find((entry) => entry.signalId === item.properties.id) : undefined;
        if (profile) selectOrganization(profile.id); else choose(item.properties.id);
      }} events={events} selectedEventId={eventSelection?.cityId === cityId ? eventSelection.id : null} onSelectEvent={(id) => selectEvent(cityId, id)}
      showInvestments={showInvestments && cityId === 'strausberg'} selectedInvestmentId={investmentId} onSelectInvestment={selectInvestment} />
    <div ref={detailRef} className={`civic-detail${issuer ? ' civic-detail-demo' : ''}`}>
      {organization ? <OrganizationDetail profile={organization} matchedSignal={Boolean(organizationSignal)} go={go} /> : eventSelection?.cityId === cityId ? selectedEvent ? <>
        <header className="civic-detail-header"><div><span className="eyebrow">PUBLISHED EVENT · {eventTimeState(selectedEvent, eventClock).toUpperCase()}</span><h3>{selectedEvent.title}</h3>
          <p>{selectedEvent.eventStart && !Number.isNaN(Date.parse(selectedEvent.eventStart)) ? formatCityEventDate(selectedEvent.eventStart) : 'Event date unknown'} · {selectedEvent.venue ?? 'Venue not supplied'}</p></div></header>
        <p>{selectedEvent.geometry ? `Venue point · ${selectedEvent.geometryPrecision === 'approximate' ? 'approximate location' : 'exact coordinate'}` : 'No sourced venue coordinate · not mapped'}.</p>
        <a href={selectedEvent.url} target="_blank" rel="noopener noreferrer">Event details · {selectedEvent.publisher} ↗</a>
        <details className="civic-evidence"><summary>Event &amp; venue sources</summary>
          <p>Event ID {selectedEvent.id} · feed source {selectedEvent.sourceId}{selectedEvent.publisherRecordId && ` · publisher record ${selectedEvent.publisherRecordId}`} · review {selectedEvent.reviewState} · reuse {selectedEvent.reuse}.</p>
          {selectedEvent.locationSource && <p>Venue: <a href={selectedEvent.locationSource.url} target="_blank" rel="noopener noreferrer">{selectedEvent.locationSource.publisher} ↗</a> · {selectedEvent.locationSource.method.replaceAll('_', ' ')} · retrieved {formatCityDate(selectedEvent.locationSource.retrievedAt)}.
            {selectedEvent.locationSource.geometrySourceUrl && <> Geometry: <a href={selectedEvent.locationSource.geometrySourceUrl} target="_blank" rel="noopener noreferrer">{selectedEvent.locationSource.geometryAttribution ?? selectedEvent.locationSource.geometryLicence ?? 'Venue geometry source'} ↗</a> · {selectedEvent.locationSource.geometryLicence}.</>}</p>}
        </details>
      </> : <><header className="civic-detail-header"><h3>Event not in this city feed</h3></header><p>{feedResult ? `This event is not in the current publication for ${cityName ?? 'this city'}.` : feedError || 'Reading the city feed…'}</p></> : <>
      <header className="civic-detail-header">
        <div><span className="eyebrow">{issuer ? 'Fictional test project · test tokens · no rights' : feature ? `${feature.properties.kind.replaceAll('_', ' ')} · PUBLIC RECORD` : 'PUBLIC CITY CONTEXT'}</span>
          <h3>{issuer ? projectDisplayName(issuer.name) : caseStudy?.title ?? feature?.properties.title ?? `Select a place or project in ${cityName ?? 'your city'}`}</h3>
          {feature && <p>Published stage: <strong>{displayCityText(displayStatus(feature))}</strong> · {PRECISION_LABELS[feature.properties.geometryPrecision]} · as of {formatCityDate(feature.properties.asOf)}</p>}
        </div>
        {selectedTarget && (followedSelection
          ? <button type="button" className="civic-follow-button" aria-pressed="true" onClick={() => following.remove(selectedTarget)}><Bookmark size={17} fill="currentColor" />Following · Unfollow</button>
          : <button type="button" className="civic-follow-button" aria-pressed="false" disabled={!canFollow} onClick={() => void followCurrent(selectedTarget)}><Bookmark size={17} />{followingTarget === selectedKey ? 'Checking sources…' : 'Follow project'}</button>)}
      </header>
      {selectedTarget && <p className="small-copy">Following is saved in this browser for this account. Nobody is notified; changes appear only when the published data is refreshed and you reopen the app.</p>}
      {issuer && <><p>{issuer.description}</p><p>{issuer.rights}</p><p>{issuer.location.label}</p>
        <div className="civic-detail-actions"><button type="button" className="civic-view-button civic-demo-action" onClick={() => openLocalInvestment(go, issuer.id)}>Fictional test project · test tokens · no rights →</button></div>
        <strong>Fictional test issuers</strong><div className="civic-demo-options" role="group" aria-label="Fictional test issuers">{TEST_CITY_INVESTMENTS.map((item) => <button type="button" key={item.id} aria-pressed={issuer.id === item.id} onClick={() => selectInvestment(item.id)}>{item.symbol} · {item.kind}</button>)}</div></>}
      {!issuer && feature && <><p>{displayCityText(feature.properties.statement)}</p>
        {caseStudy && !selectedTarget && <div className="civic-detail-actions"><button type="button" className="civic-view-button" onClick={() => setLens('outcomes')}>Inspect outcomes →</button></div>}
        {feature.properties.kind === 'place' && <p className="civic-unlocated">OSM place point only; no verified supplier, customer or investment relationship with the planning area.</p>}
      </>}
      {!issuer && caseStudy && !feature?.geometry && <p className="civic-unlocated">No verified project location; the map shows city context, not the project footprint.</p>}
      {feature && (!detailReady || full?.loading) && <p role="status">Reading the full published record…</p>}
      {selectedTarget && !followedSelection && !canFollow && !followingTarget && !following.storageError && <p className="civic-unlocated">The current public record is unavailable, so following cannot be saved yet.</p>}
      {detailReady && full?.error && <p role="alert">{full.error}</p>}
      {followError && <p role="alert">{followError}</p>}
      {following.storageError && <p role="alert">{following.storageError}</p>}
      {!issuer && <Evidence caseStudy={caseStudy} feature={evidenceFeature} />}
      </>}
    </div>
    </div>
    {available.length > 0 && <div className="civic-selector"><label>Other published projects &amp; topics <select aria-label="Project or topic" value={selected ?? ''} onChange={(event) => choose(event.target.value)}><option value="">Select a published item</option>{available.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}{selected && selected !== caseStudy?.id && <option value={selected}>{feature?.properties.title ?? 'Selected public item'}</option>}</select></label><span>{cityName}</span></div>}
    {Object.values(following.store.entries).length > 0 && <details className="civic-followed-list"><summary id="followed-projects">Followed projects · {Object.values(following.store.entries).length}{Object.values(following.store.entries).some((entry) => entry.pending.length) && ` · ${Object.values(following.store.entries).reduce((count, entry) => count + entry.pending.length, 0)} unread`}</summary>
      <p>Saved only in this browser for this account; public city records are fetched to check changes. Research cases without a linked public item track published app evidence, not live document monitoring.</p>
      <ul>{Object.values(following.store.entries).map((entry) => <li key={targetKey(entry.target)}>
        <button type="button" className="text-button" onClick={() => reviewFollowed(entry.target, entry.pending[0]?.changes)}>{entry.latest.title} · {entry.latest.cityName} {entry.pending.length ? `(${entry.pending.length} unread)` : ''} →</button>
        {following.sources[targetKey(entry.target)] && <small role="status">{following.sources[targetKey(entry.target)]}</small>}
        {entry.pending.map((update) => <div key={update.sequence}>{update.changes.map((change) => <p key={change.key}><strong>{change.label}</strong>: {change.value} · {change.context} {change.sourceUrl && <a href={change.sourceUrl} target="_blank" rel="noopener noreferrer">Source ↗</a>}</p>)}
          <button type="button" className="text-button" onClick={() => reviewFollowed(entry.target, update.changes)}>Review this update →</button>
          <button type="button" className="text-button" onClick={() => following.acknowledge(entry.target, update.sequence, entry.instance)}>Mark this update read</button></div>)}
      </li>)}</ul>
    </details>}
    <div className="civic-tabs" role="group" aria-label="City lenses">{(['map', 'outcomes', 'connections'] as const).map((item) => <button type="button" key={item} aria-pressed={lens === item} onClick={() => { advanceReview(); setLens(item); }}>{item === 'map' ? '⌖ Map context' : item === 'outcomes' ? '▥ Outcomes' : '↝ Connections'}</button>)}</div>
    {lens === 'outcomes' && !issuer && !organization && !eventSelection && <Outcomes caseStudy={caseStudy} feature={evidenceFeature} />}
    {lens === 'connections' && !issuer && !organization && !eventSelection && <><CivicLoop selected={node} onSelect={setNode} mode={mode} onMode={setMode} projectTitle={caseStudy?.title ?? evidenceFeature?.properties.title} evidence={caseStudy} />
      <p className="civic-node-context">{mode === 'scenario' && `${SYSTEM_NODES.find((item) => item.id === node)?.label}: hypothetical relation. `}{evidenceFeature?.geometry ? `Published project location: ${PRECISION_LABELS[evidenceFeature.properties.geometryPrecision]}; not a modeled affected area.` : 'No verified current project geometry to show.'}</p></>}
    </section>
    {cityId === 'strausberg' && <OrganizationShelf selectedId={organizationId} onSelect={selectOrganization} />}
    <CityFeedList cityId={cityId} result={feedResult} error={feedError} onSelectEvent={selectEvent} />
    <section className="civic-project-browser" id="project-browser" tabIndex={-1} aria-labelledby="project-browser-title">
      <details open><summary id="project-browser-title">Browse more public projects to follow</summary>
      <p>Exploring {cityName ?? 'a covered city'} · published projects and council papers. Following is a bookmark on this device; nobody is notified.</p>
      {following.storageError && <p role="alert">{following.storageError}</p>}
      {shortlist.length > 0 ? <ul className="civic-project-shortlist">{shortlist.map((item) => <li key={targetKey(item.target)}>
        <div className="civic-project-description"><strong>{item.title}</strong><small>{item.context}</small></div>
        <div className="civic-project-actions">
          <button type="button" className="civic-view-button" aria-pressed={selectedKey === targetKey(item.target)}
            onClick={() => { choose(item.selectionId); setLens('outcomes'); setMode('observed'); const anchor = document.getElementById('selected-project'); anchor?.focus(); anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>View</button>
          <ProjectFollowButton key={`${accountId}:${targetKey(item.target)}`} request={request} target={item.target} title={item.title}
            cityName={result?.state === 'covered' ? result.data.catalogue.name : cityId}
            entry={following.store.entries[targetKey(item.target)]} storageError={following.storageError} add={following.add} remove={following.remove} />
        </div>
      </li>)}</ul> : <p className="civic-browser-empty">{result?.state === 'covered' ? <>No public projects are published for {cityName ?? 'this city'} yet.</> : error ? 'Public projects could not be read.' : 'Reading published projects…'}</p>}
      {cityId !== 'muenster' && <button type="button" className="text-button" onClick={() => { advanceReview(); setExplorationCity('muenster'); setInvestmentId(null); setSelection({ cityId: 'muenster', id: MUNSTER_BUS_TRIAL_ID }); setLens('outcomes'); setMode('observed'); }}>Historical measured example · Münster 2021 →</button>}
      {explorationCity && <button type="button" className="text-button" onClick={() => { advanceReview(); setExplorationCity(''); setInvestmentId(null); setSelection(null); }}>{!selectedCity && !cityDisplayName ? 'Back to choosing a city' : 'Back to my chosen city →'}</button>}
      </details>
    </section>
  </section>;
}
