'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { civicOutcomeEvidence, MUNSTER_BUS_TRIAL_ID, type CivicOutcomeEvidence } from '@/data/civic-outcome-evidence';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import type { CityFeature, Signal } from '@/server/city-signals';
import { displayStatus, PRECISION_LABELS } from './personal-map-relevance';
import { sourceAssertionLabel, sourceReviewLabel } from '@/data/city-source-evidence';
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
import { strausbergSources } from '@/data/cities/strausberg';
import { OrganizationDetail, OrganizationShelf } from './organization-profile';
import { consultationGroups, displayCityText, formatCityDate, formatCityEventDate, shortlistFeatures } from './city-coverage';
import { MoreRow } from './blocks';
import { SectionTabs } from './section-tabs';
import { NativeCivicPanel } from './city-participation';
import { CityGameRow } from './stadtstack-services';
import { civicSourceDraftHref } from './civic-source-link';

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const noFeatures: CityFeature[] = [];
function quantity(value: number | string, unit?: string) {
  return `${typeof value === 'number' ? unit === 'EUR' ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value) : number.format(value) : value}${unit && unit !== 'EUR' ? ` ${unit}` : ''}`;
}
function Evidence({ caseStudy, feature }: { caseStudy?: CivicOutcomeEvidence; feature?: Signal }) {
  return <details className="civic-evidence"><summary>Evidence, review &amp; geometry</summary>
    {feature && <><p>{displayCityText(feature.properties.statement)}</p><p>Source status (original wording): {displayCityText(feature.properties.status || 'not established')} · {feature.properties.assertion ? 'document date' : 'as of'} {formatCityDate(feature.properties.asOf)} · review: {sourceReviewLabel(feature.properties.reviewState, feature.properties.verification)}{feature.properties.assertion && ` · ${sourceAssertionLabel(feature.properties.assertion)}`} · location: {PRECISION_LABELS[feature.properties.geometryPrecision]} ({feature.geometry?.type ?? 'unlocated'}).</p>
      {feature.properties.sources.map((source, index) => <p key={`${source.url}\0${source.locator}\0${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher} ↗</a> · {source.publisher} · {source.locator} · retrieved {formatCityDate(source.retrievedAt)} · {source.licence} ({source.reuse})</p>)}
      {feature.properties.verification?.status === 'auto-verified' && <p>{feature.properties.verification.meaning}. {feature.properties.verification.evidenceBasis}. {feature.properties.verification.metric} {feature.properties.verification.metricVersion} · {feature.properties.verification.model} · score {feature.properties.verification.score}, threshold {feature.properties.verification.threshold} · checked {feature.properties.verification.evaluatedAt}.</p>}
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
    <p className="civic-stage">Published stage: <strong>{feature ? displayStatus(feature) : caseStudy?.budgetPlan ? 'Planned · 2025/26 budget ordinance' : outputs.length ? `${outputs[0].basis === 'planned' ? 'Planned' : 'Reported'} · ${outputs[0].label}` : 'not established'}</strong> <span>≠ measured success</span></p>
    {outputs.map((output) => <div className={`civic-output civic-${output.basis}`} key={`${output.label}:${output.locator}`}><span>{output.basis === 'planned' ? '◌ Plan' : '■ Reported physical output'}</span><strong>{quantity(output.value, output.unit)}</strong><small>{output.label}</small></div>)}
    {caseStudy?.budgetPlan && <section className="civic-spending" aria-label="Planned city cash outlays">
      <span className="eyebrow">2025/26 ORDINANCE · PLAN, NOT ACTUAL SPENDING</span>
      <div>{caseStudy.budgetPlan.map((plan) => <div key={plan.year}>
        <h4>{plan.year} planned · {quantity(plan.total, 'EUR')}</h4>
        <p>Administrative · {quantity(plan.administrative, 'EUR')}</p>
        <p>Investment · {quantity(plan.investment, 'EUR')}</p>
        <p>Financing · {quantity(plan.financing, 'EUR')}</p>
        <div className="civic-meter" aria-hidden="true"><i style={{ width: `${plan.total / 83708074 * 100}%` }} /></div>
        <p><strong>Actual: not published</strong> in the reviewed snapshot</p>
      </div>)}</div>
      <p>Cash disbursements, not expenses by service or project. Subsequent amendments are not tracked.</p>
      <p><a href={caseStudy.metrics[0].sourceUrl} target="_blank" rel="noopener noreferrer">Official ordinance · page 1, §1 ↗</a> · <a href={strausbergSources.gazette} target="_blank" rel="noopener noreferrer">Publication &amp; inspection notice ↗</a> · <a href={strausbergSources.inspectionLaw} target="_blank" rel="noopener noreferrer">Budget inspection law ↗</a> · <a href={strausbergSources.informationAccessLaw} target="_blank" rel="noopener noreferrer">Information access (AIG) ↗</a></p>
    </section>}
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
export function CivicPlaceLenses({ request, accountId, previewRequest, onExplorationCityChange, go, nearby, community, council, readings }: { request: AuthorizedRequest; accountId: string; previewRequest?: { cityId: string } | null; onExplorationCityChange?: (cityId: string) => void; go: (area: Area) => void; nearby?: React.ReactNode; community?: React.ReactNode; council?: React.ReactNode; readings?: React.ReactNode }) {
  const eventClock = useEventClock();
  const [explorationCity, setExplorationCity] = useState(previewRequest?.cityId ?? '');
  // A new preview request replaces the exploration city; adjusting state during render avoids an effect cascade.
  const [seenPreview, setSeenPreview] = useState(previewRequest);
  if (previewRequest !== seenPreview) {
    setSeenPreview(previewRequest);
    if (previewRequest) setExplorationCity(previewRequest.cityId);
  }
  const { cityId, result, error, cityDisplayName, selectedCity, city } = useCitySignals(request, explorationCity || undefined);
  useEffect(() => { onExplorationCityChange?.(explorationCity); }, [explorationCity, onExplorationCityChange]);
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
  const [showShortlist, setShowShortlist] = useState(false);
  const [showFollowed, setShowFollowed] = useState(false);
  const [expandedUpdates, setExpandedUpdates] = useState<string[]>([]);
  const [showParticipation, setShowParticipation] = useState(false);
  const [lens, setLens] = useState<'map' | 'outcomes' | 'connections'>('map');
  const chooseLens = useCallback((next: 'map' | 'outcomes' | 'connections') => {
    setLens(next);
    if (next !== 'map') requestAnimationFrame(() => {
      const row = document.getElementById('project-outcomes');
      if (row instanceof HTMLDetailsElement) row.open = true;
    });
  }, []);
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
          chooseLens('map');
        });
        return;
      }
      if (intent.kind === 'investment' && 'cityId' in intent && intent.cityId === 'strausberg' &&
        'projectId' in intent && TEST_CITY_INVESTMENTS.some((item) => item.id === intent.projectId)) {
        advanceReview();
        queueMicrotask(() => {
          setExplorationCity('strausberg');
          setEventSelection(null);
          setOrganizationId(null);
          setInvestmentId(intent.projectId as TestCityInvestmentId);
          setShowInvestments(true);
          setSelection(null);
          chooseLens('map');
        });
      } else if (intent.kind === 'scenario' || intent.kind === 'map') {
        const destination = intent.kind;
        advanceReview();
        queueMicrotask(() => { setInvestmentId(null); setEventSelection(null); setOrganizationId(null); chooseLens(destination === 'map' ? 'map' : 'connections'); setMode(destination === 'map' ? 'observed' : 'scenario'); });
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
          setEventSelection(null);
          setOrganizationId(null);
          setInvestmentId(null);
          setSelection({ cityId: targetCity, id: target, signalId: linkedSignalId });
          chooseLens(targetLens);
          setMode('observed');
        });
      }
    }
    window.addEventListener(CIVIC_NAVIGATION_INTENT, consumeIntent);
    consumeIntent();
    return () => window.removeEventListener(CIVIC_NAVIGATION_INTENT, consumeIntent);
  }, [advanceReview, chooseLens]);
  const features = result?.state === 'covered' ? result.data.signals.features : noFeatures;
  const cases = civicOutcomeEvidence.filter((item) => item.cityId === cityId);
  const selectedEvent = eventSelection?.cityId === cityId ? events.find((item) => item.id === eventSelection.id) : undefined;
  const organization = cityId === 'strausberg' ? strausbergOrganizations.find((item) => item.id === organizationId) : undefined;
  const organizationSignal = organization?.signalId ? features.find((item) => item.properties.id === organization.signalId && item.geometry?.type === 'Point') : undefined;
  const selected = investmentId || eventSelection?.cityId === cityId || organization ? null : selection?.cityId === cityId ? selection.id : null;
  const caseStudy = cases.find((item) => item.id === selected || item.signalIds.includes(selected ?? ''));
  const linkedId = selection?.cityId === cityId && selected === caseStudy?.id ? selection.signalId : undefined;
  const feature = features.find((item) => item.properties.id === (linkedId ?? selected)) ??
    (selected === caseStudy?.id && !linkedId ? features.find((item) => caseStudy.signalIds.includes(item.properties.id)) : undefined);
  const detailReady = full?.cityId === cityId && full.id === feature?.properties.id && full.revision === reviewRevision;
  const evidenceFeature = detailReady ? full?.feature : undefined;
  const discussionDraft = evidenceFeature?.properties.sources[0]?.url
    ? civicSourceDraftHref(cityId, evidenceFeature.properties.title, evidenceFeature.properties.sources[0].url) : null;
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
    }
    for (const item of eligibleFeatures) {
      const target = targetForSignal(cityId, item.properties.id);
      const key = targetKey(target);
      if (shown.has(key)) continue;
      if (target.kind === 'case' && caseForTarget(target)?.signalIds.some((id) => !eligibleFeatures.some((feature) => feature.properties.id === id))) continue;
      shown.add(key);
      shortlist.push({ target, title: target.kind === 'case' ? caseForTarget(target)!.title : item.properties.title,
        selectionId: target.id,
        context: `${item.properties.kind.replaceAll('_', ' ')} · ${displayCityText(displayStatus(item))} · source as of ${formatCityDate(item.properties.asOf)} · ${sourceReviewLabel(item.properties.reviewState, item.properties.verification)}` });
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
    chooseLens('map');
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
    chooseLens('map');
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
    chooseLens('outcomes');
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
    if (id) { setSelection(null); chooseLens('map'); }
  }
  const cityName = (result?.state === 'covered' ? result.data.catalogue.name : cityDisplayName) || undefined;
  const cityContentUnavailable = Boolean(city && !cityId) || result?.state === 'not_covered';
  const cityContentPrompt = !city ? error ? 'Your city could not be checked.' : 'Checking your city…' : cityContentUnavailable ? cityName ? `No published map or city feed for ${cityName} yet.` : 'Choose or preview a city first.' : '';
  const followedEntries = Object.values(following.store.entries);
  const unreadFollowedUpdates = followedEntries.reduce((count, entry) => count + entry.pending.length, 0);
  const consultations = useMemo(() => result?.state === 'covered' ? consultationGroups(eligibleFeatures, cityId, result.data.generatedAt) : null, [result, eligibleFeatures, cityId]);
  const participation = <>
    {cityContentUnavailable && <p>{cityContentPrompt}</p>}
    {consultations && <section className="civic-open-windows" aria-label="Participation as published">
      <h3>Where can I have a say?</h3><p>Published dates describe the source record, not a guaranteed deadline. Check the source before taking part.</p>
      {consultations.open.length ? <><strong>Open now · as published</strong><ul>{(showParticipation ? consultations.open : consultations.open.slice(0, 3)).map((item) => <li key={item.properties.id}><button type="button" className="text-button" onClick={() => choose(item.properties.id)}>{item.properties.title}</button> · end date as published {item.properties.endDate ? formatCityDate(item.properties.endDate) : 'not supplied'}</li>)}</ul></> : <p>Nothing open as of {formatCityDate(result?.state === 'covered' ? result.data.generatedAt : '')}.</p>}
      {consultations.closed.length > 0 && <><strong>Closed recently · as published</strong><ul>{(showParticipation ? consultations.closed : consultations.closed.slice(0, 3)).map((item) => <li key={item.properties.id}><button type="button" className="text-button" onClick={() => choose(item.properties.id)}>{item.properties.title}</button> · closed {formatCityDate(item.properties.endDate!)}</li>)}</ul></>}
      {(consultations.open.length > 3 || consultations.closed.length > 3) && <button type="button" className="text-button" aria-expanded={showParticipation} onClick={() => setShowParticipation(!showParticipation)}>{showParticipation ? 'Show fewer participation records' : `Show all ${consultations.open.length + consultations.closed.length} participation records`}</button>}
    </section>}
  </>;
  const followed = <>
    {available.length > 0 && <div className="civic-selector"><label>Other published projects &amp; topics <select aria-label="Project or topic" value={selected ?? ''} onChange={(event) => choose(event.target.value)}><option value="">Select a published item</option>{available.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}{selected && selected !== caseStudy?.id && <option value={selected}>{feature?.properties.title ?? 'Selected public item'}</option>}</select></label><span>{cityName}</span></div>}
    {Object.values(following.store.entries).length > 0 && <section className="civic-followed-list"><h2>Followed projects · {Object.values(following.store.entries).length}</h2>
      <p>Saved only in this browser for this account; public city records are fetched to check changes. Research cases without a linked public item track published app evidence, not live document monitoring.</p>
      <ul>{(showFollowed ? Object.values(following.store.entries) : Object.values(following.store.entries).slice(0, 3)).map((entry) => <li key={targetKey(entry.target)}>
        <button type="button" className="text-button" onClick={() => reviewFollowed(entry.target, entry.pending[0]?.changes)}>{entry.latest.title} · {entry.latest.cityName} {entry.pending.length ? `(${entry.pending.length} unread)` : ''} →</button>
        {following.sources[targetKey(entry.target)] && <small role="status">{following.sources[targetKey(entry.target)]}</small>}
        {(expandedUpdates.includes(targetKey(entry.target)) ? entry.pending : entry.pending.slice(0, 1)).map((update) => <div key={update.sequence}>{update.changes.map((change) => <p key={change.key}><strong>{change.label}</strong>: {change.value} · {change.context} {change.sourceUrl && <a href={change.sourceUrl} target="_blank" rel="noopener noreferrer">Source ↗</a>}</p>)}
          <button type="button" className="text-button" onClick={() => reviewFollowed(entry.target, update.changes)}>Review this update →</button>
          <button type="button" className="text-button" onClick={() => following.acknowledge(entry.target, update.sequence, entry.instance)}>Mark this update read</button></div>)}
        {entry.pending.length > 1 && <button type="button" className="text-button" aria-expanded={expandedUpdates.includes(targetKey(entry.target))} onClick={() => setExpandedUpdates((keys) => keys.includes(targetKey(entry.target)) ? keys.filter((key) => key !== targetKey(entry.target)) : [...keys, targetKey(entry.target)])}>{expandedUpdates.includes(targetKey(entry.target)) ? 'Show fewer updates' : `Show all ${entry.pending.length} updates`}</button>}
      </li>)}</ul>
      {Object.values(following.store.entries).length > 3 && <button type="button" className="text-button" aria-expanded={showFollowed} onClick={() => setShowFollowed(!showFollowed)}>{showFollowed ? 'Show fewer followed projects' : `Show all ${Object.values(following.store.entries).length} followed projects`}</button>}
    </section>}
  </>;
  const browser = <>
    <section className="civic-project-browser" tabIndex={-1} aria-labelledby="project-browser-title">
      <h2 id="project-browser-title">Browse more public projects to follow</h2>
      <p className="small-copy">Following saves a bookmark for this account on this device; nobody is notified. Check again after a new published snapshot.</p>
      {following.storageError && <p role="alert">{following.storageError}</p>}
      {shortlist.length > 0 ? <ul className="civic-project-shortlist">{(showShortlist ? shortlist : shortlist.slice(0, 2)).map((item) => <li key={targetKey(item.target)}>
        <div className="civic-project-description"><strong>{item.title}</strong><small>{item.context}</small></div>
        <div className="civic-project-actions">
          <button type="button" className="civic-view-button" aria-pressed={selectedKey === targetKey(item.target)}
            onClick={() => { choose(item.selectionId); chooseLens('outcomes'); setMode('observed'); const anchor = document.getElementById('selected-project'); anchor?.focus(); anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>View</button>
          <ProjectFollowButton key={`${accountId}:${targetKey(item.target)}`} request={request} target={item.target} title={item.title}
            cityName={result?.state === 'covered' ? result.data.catalogue.name : cityId}
            entry={following.store.entries[targetKey(item.target)]} storageError={following.storageError} add={following.add} remove={following.remove} />
        </div>
      </li>)}</ul> : <p className="civic-browser-empty">{result?.state === 'covered' ? <>No public projects are published for {cityName ?? 'this city'} yet.</> : cityContentPrompt || (error ? 'Public projects could not be read.' : 'Reading published projects…')}</p>}
      {shortlist.length > 2 && <button type="button" className="text-button" aria-expanded={showShortlist} onClick={() => setShowShortlist(!showShortlist)}>{showShortlist ? 'Show fewer projects' : `Show all ${shortlist.length} projects`}</button>}
      {cityId !== 'muenster' && <button type="button" className="text-button" onClick={() => { advanceReview(); setExplorationCity('muenster'); setInvestmentId(null); setSelection({ cityId: 'muenster', id: MUNSTER_BUS_TRIAL_ID }); chooseLens('outcomes'); setMode('observed'); }}>Historical measured example · Münster 2021 →</button>}
      {explorationCity && <button type="button" className="text-button" onClick={() => { advanceReview(); setExplorationCity(''); setInvestmentId(null); setSelection(null); }}>{!selectedCity && !cityDisplayName ? 'Back to choosing a city' : 'Back to my chosen city →'}</button>}
    </section>
    {cityId === 'strausberg' && <div className="civic-story" aria-label="Explore three city stories">
      <button type="button" onClick={() => { setExplorationCity('strausberg'); choose('atlas:altstadt-quartier', 'strausberg'); chooseLens('map'); }}>① Altstadt Quartier <small>Published planning area · consultation closed</small></button>
      <button type="button" onClick={() => { setExplorationCity('strausberg'); choose('osm:node-6040411543', 'strausberg'); chooseLens('map'); }}>② Bäckerei Klein <small>OpenStreetMap local place</small></button>
      <button type="button" className="civic-story-demo" onClick={() => selectInvestment(TEST_CITY_INVESTMENTS[0].id)}>③ Fictional test project <small>Test tokens · no rights</small></button>
    </div>}
  </>;
  const feed = cityContentPrompt ? <section id="city-news" tabIndex={-1}><p>{cityContentPrompt}</p></section>
    : <CityFeedList cityId={cityId} result={feedResult} error={feedError} onSelectEvent={selectEvent} />;
  const mapDetails = <>
    <MoreRow id="project-outcomes" title="Project outcomes & connections" meta={cityContentUnavailable ? cityName ? 'No published city record' : 'Choose a city first' : lens === 'map' ? 'Explore the selected public record' : lens === 'outcomes' ? 'Outcomes selected' : 'Connections selected'}>
    <div className="civic-tabs" role="group" aria-label="City lenses">{(['map', 'outcomes', 'connections'] as const).map((item) => <button type="button" key={item} aria-pressed={lens === item} onClick={() => { advanceReview(); chooseLens(item); }}>{item === 'map' ? '⌖ Map context' : item === 'outcomes' ? '▥ Outcomes' : '↝ Connections'}</button>)}</div>
    {lens === 'outcomes' && !issuer && !organization && !eventSelection && <Outcomes caseStudy={caseStudy} feature={evidenceFeature} />}
    {lens === 'connections' && !issuer && !organization && !eventSelection && <><CivicLoop selected={node} onSelect={setNode} mode={mode} onMode={setMode} projectTitle={caseStudy?.title ?? evidenceFeature?.properties.title} evidence={caseStudy} />
      <p className="civic-node-context">{mode === 'scenario' && `${SYSTEM_NODES.find((item) => item.id === node)?.label}: hypothetical relation. `}{evidenceFeature?.geometry ? `Published project location: ${PRECISION_LABELS[evidenceFeature.properties.geometryPrecision]}; not a modeled affected area.` : 'No verified current project geometry to show.'}</p></>}
    </MoreRow>
    {readings}
  </>;
  return <section className="card civic-place" id="city-system" aria-label="City place, outcomes and connections" tabIndex={-1}>
    <section className="civic-selected-project" id="selected-project" tabIndex={-1} aria-label="Selected project">
    {error && <p role="alert">{error}</p>}
    {missingSelection && <p role="alert">This public project is not in the current publication. Your city and saved updates have not changed.</p>}
    <div className="civic-map-row">
    <PersonalMap request={request} accountId={accountId} explorationCity={explorationCity}
      selectedId={organizationSignal?.properties.id ?? feature?.properties.id ?? null} onSelect={(item) => {
        const profile = cityId === 'strausberg' ? strausbergOrganizations.find((entry) => entry.signalId === item.properties.id) : undefined;
        if (profile) selectOrganization(profile.id); else choose(item.properties.id);
      }} events={events} selectedEventId={eventSelection?.cityId === cityId ? eventSelection.id : null} onSelectEvent={(id) => selectEvent(cityId, id)}
      showInvestments={showInvestments && cityId === 'strausberg'} selectedInvestmentId={investmentId} onSelectInvestment={selectInvestment} details={mapDetails} />
    {(issuer || organization || eventSelection?.cityId === cityId || selected) && <div ref={detailRef} className={`civic-detail${issuer ? ' civic-detail-demo' : ''}`}>
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
          {feature && <p>{feature.properties.kind === 'measurement' ? 'Measurement status' : 'Published stage'}: <strong>{displayCityText(displayStatus(feature))}</strong> · {PRECISION_LABELS[feature.properties.geometryPrecision]} · {feature.properties.assertion ? 'document date' : 'as of'} {formatCityDate(feature.properties.asOf)}{feature.properties.assertion && ` · ${sourceAssertionLabel(feature.properties.assertion)}`}</p>}
        </div>
        {selectedTarget && (followedSelection
          ? <button type="button" className="civic-follow-button" aria-pressed="true" onClick={() => following.remove(selectedTarget)}><Bookmark size={17} fill="currentColor" />Following · Unfollow</button>
          : <button type="button" className="civic-follow-button" aria-pressed="false" disabled={!canFollow} onClick={() => void followCurrent(selectedTarget)}><Bookmark size={17} />{followingTarget === selectedKey ? 'Checking sources…' : feature?.properties.kind === 'measurement' ? 'Follow record' : 'Follow project'}</button>)}
      </header>
      {selectedTarget && <p className="small-copy">Following is saved in this browser for this account. Nobody is notified; changes appear only when the published data is refreshed and you reopen the app.</p>}
      {issuer && <><p>{issuer.description}</p><p>{issuer.rights}</p><p>{issuer.location.label}</p>
        <div className="civic-detail-actions"><button type="button" className="civic-view-button civic-demo-action" onClick={() => openLocalInvestment(go, issuer.id)}>Fictional test project · test tokens · no rights →</button></div>
        <strong>Fictional test issuers</strong><div className="civic-demo-options" role="group" aria-label="Fictional test issuers">{TEST_CITY_INVESTMENTS.map((item) => <button type="button" key={item.id} aria-pressed={issuer.id === item.id} onClick={() => selectInvestment(item.id)}>{item.symbol} · {item.kind}</button>)}</div></>}
      {!issuer && feature && <><p>{displayCityText(feature.properties.statement)}</p>
        {caseStudy && !selectedTarget && <div className="civic-detail-actions"><button type="button" className="civic-view-button" onClick={() => chooseLens('outcomes')}>Inspect outcomes →</button></div>}
        {feature.properties.kind === 'place' && <p className="civic-unlocated">OSM place point only; no verified supplier, customer or investment relationship with the planning area.</p>}
      </>}
      {!issuer && caseStudy && !feature?.geometry && <p className="civic-unlocated">No verified project location; the map shows city context, not the project footprint.</p>}
      {feature && (!detailReady || full?.loading) && <p role="status">Reading the full published record…</p>}
      {selectedTarget && !followedSelection && !canFollow && !followingTarget && !following.storageError && <p className="civic-unlocated">The current public record is unavailable, so following cannot be saved yet.</p>}
      {detailReady && full?.error && <p role="alert">{full.error}</p>}
      {followError && <p role="alert">{followError}</p>}
      {following.storageError && <p role="alert">{following.storageError}</p>}
      {!issuer && <Evidence caseStudy={caseStudy} feature={evidenceFeature} />}
      {!issuer && discussionDraft && <p><a className="button secondary" href={discussionDraft}>Discuss this source in Ledger</a><span className="small-copy"> Your opinion topic, not a municipal submission.</span></p>}
      </>}
    </div>}
    </div>
    </section>
    <SectionTabs label="Explore city information" tabs={[
      { id: 'places-say', label: 'Have your say', content: <>
        <NativeCivicPanel request={request} cityId={cityId} />
        <MoreRow title="Open consultations" meta={cityContentUnavailable ? cityName ? 'No published consultations' : 'Choose a city first' : consultations ? consultations.open.length ? `${consultations.open.length} open` : 'None open right now' : cityContentPrompt || 'Checking published dates'}>{participation}</MoreRow>
        <MoreRow id="followed-projects" title="Followed projects" meta={`${followedEntries.length} saved on this device${unreadFollowedUpdates ? ` · ${unreadFollowedUpdates} unread` : ''}`}>{followed}</MoreRow>
        <MoreRow id="project-browser" title="Browse projects" meta={cityContentUnavailable ? cityName ? 'No published projects' : 'Choose a city first' : `${shortlist.length} published projects`}>{browser}</MoreRow>
      </> },
      { id: 'places-events', label: 'Events & news', content: feed },
      { id: 'places-people', label: 'Who does what', content: <><MoreRow title="Organisations" meta={cityId === 'strausberg' ? `${strausbergOrganizations.length} profiles` : 'No published profiles'}>{cityId === 'strausberg' && <OrganizationShelf selectedId={organizationId} onSelect={selectOrganization} />}</MoreRow>{community}<CityGameRow cityId={cityId} /></> },
      { id: 'places-nearby', label: 'Nearby towns', content: nearby },
      { id: 'places-council', label: 'Council', content: council },
    ]} />
  </section>;
}
