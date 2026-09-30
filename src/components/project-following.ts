import type { CityFeature } from '../server/city-signals.ts';
import { civicOutcomeEvidence, type CivicOutcomeEvidence } from '../data/civic-outcome-evidence.ts';

export type FollowTarget = { kind: 'case' | 'signal'; cityId: string; id: string };
export type Fact = { key: string; value: string; label: string; sourceUrl: string; context: string; comparison?: string };
export type ProjectSnapshot = { title: string; cityName: string; facts: Fact[]; reviewState: string; asOf: string };
export type ProjectChange = { key: string; label: string; value: string; sourceUrl: string; context: string };
export type PendingUpdate = { sequence: number; changes: ProjectChange[]; snapshot: ProjectSnapshot };
export type FollowEntry = { target: FollowTarget; instance: number; acknowledged: ProjectSnapshot; acknowledgedSequence: number; latest: ProjectSnapshot; pending: PendingUpdate[]; nextSequence: number };
export type FollowStore = { schemaVersion: 1; nextInstance: number; entries: Record<string, FollowEntry> };

export const followKey = (accountId: string) => `ledger-of-life:followed-projects:v1:${encodeURIComponent(accountId)}`;
export function targetKey(target: FollowTarget) {
  return target.kind === 'case' ? `case:${target.cityId}:${target.id}` : `signal:${target.cityId}:${target.id}`;
}
export function targetForSignal(cityId: string, signalId: string): FollowTarget {
  const caseStudy = civicOutcomeEvidence.find((item) => item.cityId === cityId && item.signalIds.includes(signalId));
  return caseStudy ? { kind: 'case', cityId, id: caseStudy.id } : { kind: 'signal', cityId, id: signalId };
}
export function caseForTarget(target: FollowTarget): CivicOutcomeEvidence | undefined {
  return target.kind === 'case' ? civicOutcomeEvidence.find((item) => item.cityId === target.cityId && item.id === target.id) : undefined;
}
const normalized = (value: string | null | undefined) => (value ?? '').trim().replace(/\s+/g, ' ');
const safeUrl = (url: string | undefined) => url && /^https?:\/\//.test(url) ? url : '';
function nextStepComparison(value: string) {
  const text = normalized(value).toLowerCase();
  const categories = [
    /\b(?:beteilig|konsult|consult|stellungnahme|einwendung|participat)/,
    /\b(?:beschluss|entscheid|vote|decision|resolution)/,
    /\b(?:bau|umsetz|freigab|betrieb|construction|deliver|opening)/,
    /\b(?:prüf|abgleich|nachführ|ergänz|erhalten|check|review|read|view)/,
  ];
  return categories.map((pattern, index) => pattern.test(text) ? index : '')
    .filter((item) => item !== '').join(':') + '|' + (text.match(/https?:\/\/\S+|\b\d{1,4}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g) ?? []).join('|');
}
export function projectSnapshot(target: FollowTarget, cityName: string, features: CityFeature[] | null): ProjectSnapshot | null {
  const caseStudy = caseForTarget(target);
  if (target.kind === 'case' && !caseStudy) return null;
  // A mapped case needs its published signal too; absence must not be mistaken for completion.
  const signals = target.kind === 'signal' ? [features?.find((item) => item.properties.id === target.id)]
    : caseStudy!.signalIds.map((id) => features?.find((item) => item.properties.id === id));
  if (signals.some((item) => !item) || (target.kind === 'signal' && !features)) return null;
  const facts: Fact[] = [];
  for (const item of signals) {
    if (!item) continue;
    const p = item.properties;
    const sourceUrl = safeUrl('sources' in p ? p.sources[0]?.url : p.primarySource?.url);
    const context = `${p.title} · source as of ${p.asOf} · ${p.reviewState.replace('_', ' ')}; date fields are not automatically deadlines`;
    for (const [key, label, value] of [
      ['status', 'Published status', p.status], ['start', 'Start date', p.startDate],
      ['end', 'End date (not necessarily a consultation deadline)', p.endDate], ['review', 'Evidence review state (not project approval)', p.reviewState],
    ] as const) facts.push({ key: `signal:${p.id}:${key}`, label, value: normalized(value), sourceUrl, context });
    const step = normalized(p.nextStep);
    facts.push({ key: `signal:${p.id}:next-step`, label: 'Published next-step note (not a verified action invitation)',
      value: step, comparison: nextStepComparison(step), sourceUrl, context: `${context} · check the source before acting` });
    if (p.kind === 'budget') {
      // Publication schema has no typed amount/basis. Compare only number tokens and explicit
      // plan/recorded wording; never turn them into an inferred actual-spend measure.
      const figures = (p.statement.match(/\b\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d+)?\b/g) ?? [])
        .map((item) => item.replace(/(?<=\d)[.,\s](?=\d{3}(?:[.,\s]|$))/g, '').replace(',', '.'))
        .sort().join(' · ');
      const text = p.statement.toLowerCase();
      const basis = [
        /\b(?:geplant\w*|planung|planansatz|haushaltsplan|vorgesehen|forecast|budgeted)\b/.test(text) ? 'planned wording' : '',
        /\b(?:tatsächlich|ausgegeben|verausgabt|actual|spent)\b/.test(text) ? 'recorded wording' : '',
        /\b(?:vorläufig|provisorisch|provisional)\b/.test(text) ? 'provisional wording' : '',
      ].filter(Boolean).join(' + ') || 'basis not stated';
      facts.push({ key: `signal:${p.id}:budget-figures`, label: 'Figures in published budget description',
        value: figures, sourceUrl, context: `${context} · published wording: ${p.statement}` });
      facts.push({ key: `signal:${p.id}:budget-basis`, label: 'Budget description basis wording (verify at source)',
        value: basis, sourceUrl, context: `${context} · published wording: ${p.statement}` });
    }
  }
  if (caseStudy) {
    caseStudy.outputs.forEach((item) => facts.push({ key: `output:${item.id}`, label: item.label,
      value: `${item.basis}: ${item.value}${item.unit ? ` ${item.unit}` : ''}${item.date ? ` · ${item.date}` : ''}`,
      sourceUrl: safeUrl(item.sourceUrl), context: `${item.locator} · ${item.basis}${item.date ? ` · ${item.date}` : ''}` }));
    caseStudy.metrics.forEach((item) => facts.push({ key: `metric:${item.id}`, label: item.label,
      value: `${item.basis}: ${item.value} ${item.unit}${item.period ? ` · ${item.period}` : ''}`,
      sourceUrl: safeUrl(item.sourceUrl), context: `${item.locator} · ${item.basis}${item.period ? ` · ${item.period}` : ''}` }));
    if (caseStudy.spending) for (const [key, item] of [['forecast', caseStudy.spending.planned], ['recorded', caseStudy.spending.recorded]] as const)
      facts.push({ key: `spending:${key}`, label: item.label, value: `${item.basis}: ${item.value}${item.unit ? ` ${item.unit}` : ''}${item.date ? ` · ${item.date}` : ''}`,
        sourceUrl: safeUrl(item.sourceUrl), context: `${item.locator} · ${caseStudy.spending.caveat}` });
    if (caseStudy.indicator) for (const [key, sample] of [['before', caseStudy.indicator.baseline], ['during', caseStudy.indicator.followUp]] as const)
      facts.push({ key: `indicator:${key}`, label: `${caseStudy.indicator.label} · ${key}`, value: `${sample.value} ${caseStudy.indicator.unit} · ${sample.period}`,
        sourceUrl: safeUrl(sample.sourceUrl), context: `${sample.locator} · ${caseStudy.indicator.method} ${caseStudy.indicator.caveat}` });
  }
  const first = signals.find(Boolean);
  return { title: caseStudy?.title ?? first?.properties.title ?? target.id, cityName,
    facts, reviewState: first?.properties.reviewState ?? 'researched case', asOf: first?.properties.asOf ?? caseStudy?.checkedAt ?? '' };
}
export function changesBetween(previous: ProjectSnapshot, current: ProjectSnapshot): ProjectChange[] {
  const old = new Map(previous.facts.map((fact) => [fact.key, fact]));
  const currentKeys = new Set(current.facts.map((fact) => fact.key));
  const updated = current.facts.flatMap((fact) => {
    const before = old.get(fact.key);
    if ((before?.comparison ?? before?.value) === (fact.comparison ?? fact.value) || (!before && !fact.value)) return [];
    return [{ key: fact.key, label: fact.label,
      value: `${before?.value || 'Not previously in published evidence'} → ${fact.value || 'No longer stated'}`,
      sourceUrl: fact.sourceUrl, context: fact.context }];
  });
  for (const fact of previous.facts) if (!currentKeys.has(fact.key))
    updated.push({ key: fact.key, label: fact.label, value: `${fact.value} → No longer stated in published evidence (not zero or cancellation)`,
      sourceUrl: fact.sourceUrl, context: fact.context });
  return updated;
}
export const emptyFollowStore = (): FollowStore => ({ schemaVersion: 1, nextInstance: 1, entries: {} });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validSnapshot(value: unknown): value is ProjectSnapshot {
  return object(value) && typeof value.title === 'string' && typeof value.cityName === 'string' &&
    typeof value.reviewState === 'string' && typeof value.asOf === 'string' && Array.isArray(value.facts) &&
    value.facts.every((fact: unknown) => object(fact) && typeof fact.key === 'string' &&
      typeof fact.value === 'string' && typeof fact.label === 'string' && typeof fact.sourceUrl === 'string' &&
      typeof fact.context === 'string' && (fact.comparison === undefined || typeof fact.comparison === 'string'));
}
export function parseFollowStore(raw: string | null): FollowStore {
  if (raw === null) return emptyFollowStore();
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.nextInstance) ||
      (value.nextInstance as number) < 1 || !object(value.entries)) throw Error();
    for (const [key, candidate] of Object.entries(value.entries)) {
      if (!object(candidate) || !object(candidate.target)) throw Error();
      const target = candidate.target;
      if ((target.kind !== 'case' && target.kind !== 'signal') || typeof target.cityId !== 'string' ||
        typeof target.id !== 'string' || !target.cityId || !target.id || key !== targetKey(target as FollowTarget) ||
        !Number.isSafeInteger(candidate.instance) || (candidate.instance as number) < 1 ||
        (candidate.instance as number) >= (value.nextInstance as number) ||
        !Number.isSafeInteger(candidate.acknowledgedSequence) || (candidate.acknowledgedSequence as number) < 0 ||
        !Number.isSafeInteger(candidate.nextSequence) || (candidate.nextSequence as number) < 1 ||
        !validSnapshot(candidate.acknowledged) || !validSnapshot(candidate.latest) || !Array.isArray(candidate.pending)) throw Error();
      const sequences = new Set<number>();
      for (const event of candidate.pending) {
        if (!object(event) || !Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1 ||
          (event.sequence as number) >= (candidate.nextSequence as number) || sequences.has(event.sequence as number) ||
          !validSnapshot(event.snapshot) || !Array.isArray(event.changes) || !event.changes.length ||
          !event.changes.every((change: unknown) => object(change) && typeof change.key === 'string' &&
            typeof change.label === 'string' && typeof change.value === 'string' &&
            typeof change.sourceUrl === 'string' && typeof change.context === 'string')) throw Error();
        sequences.add(event.sequence as number);
      }
    }
    return value as FollowStore;
  } catch {
    throw new Error('Saved following data is unreadable on this device. It was not overwritten.');
  }
}
export function follow(store: FollowStore, target: FollowTarget, snapshot: ProjectSnapshot): FollowStore {
  const key = targetKey(target);
  if (store.entries[key]) return store;
  return { ...store, nextInstance: store.nextInstance + 1,
    entries: { ...store.entries, [key]: { target, instance: store.nextInstance, acknowledged: snapshot,
      acknowledgedSequence: 0, latest: snapshot, pending: [], nextSequence: 1 } } };
}
export function refreshFollow(store: FollowStore, target: FollowTarget, snapshot: ProjectSnapshot | null, instance?: number): FollowStore {
  const key = targetKey(target);
  const entry = store.entries[key];
  if (!entry || !snapshot || (instance !== undefined && entry.instance !== instance)) return store;
  if (JSON.stringify(entry.latest) === JSON.stringify(snapshot)) return store;
  const changes = changesBetween(entry.latest, snapshot);
  return { ...store, entries: { ...store.entries, [key]: {
    ...entry, latest: snapshot,
    pending: changes.length ? [...entry.pending, { sequence: entry.nextSequence, changes, snapshot }] : entry.pending,
    nextSequence: entry.nextSequence + Number(changes.length > 0),
  } } };
}
export function acknowledgeFollow(store: FollowStore, target: FollowTarget, sequence: number, instance: number): FollowStore {
  const key = targetKey(target);
  const entry = store.entries[key];
  const seen = entry?.pending.find((item) => item.sequence === sequence);
  if (!entry || entry.instance !== instance || !seen) return store;
  return { ...store, entries: { ...store.entries, [key]: { ...entry,
    acknowledged: sequence > entry.acknowledgedSequence ? seen.snapshot : entry.acknowledged,
    acknowledgedSequence: Math.max(entry.acknowledgedSequence, sequence),
    pending: entry.pending.filter((item) => item.sequence !== sequence) } } };
}
export function unfollow(store: FollowStore, target: FollowTarget): FollowStore {
  const key = targetKey(target);
  if (!store.entries[key]) return store;
  const entries = { ...store.entries }; delete entries[key];
  return { ...store, entries };
}
