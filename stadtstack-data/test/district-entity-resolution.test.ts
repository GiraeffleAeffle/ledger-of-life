import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, observation, semanticHash, type AdapterScope, type StructuredLocator } from '../src/district-adapter-contract.ts';
import { EffectiveIntervalSchema, IdentityAssertionSchema, IdentityAdmissionSchema, assertIdentityAssertionsBound, effectiveIntervalFromExpression, sourceCalendarDay, legalFormFromName, identityAssertion, intervalContains, intervalIntersection, resolveIdentityMentions, unknownValidity, identityCandidatePairs, nativeStructuredIdentityGraph, temporalPathEligible, type IdentityMention, type EffectiveInterval } from '../src/district-entity-resolution.ts';

const hash = semanticHash('synthetic admitted source');
function interval(from: string, to: string): EffectiveInterval {
  return { validFrom: { kind: 'date', date: from, inclusive: true, precision: 'day' }, validTo: { kind: 'date', date: to, inclusive: true, precision: 'day' }, expression: `${from} through ${to}`, evidenceHashes: [hash] };
}
function mention(id: string, value = '000123', namespace = 'MaStR'): IdentityMention {
  return { id, type: 'organization', name: 'Synthetic Utility GmbH', municipalityId: 'town-one', sourceSha256: hash, identifiers: [{ namespace, issuer: 'Synthetic Register', value, evidenceHashes: [hash] }], legalForm: 'GmbH', period: null, validity: interval('2020-01-01', '2030-12-31'), evidenceHashes: [hash], councilBodyIdentity: null };
}

test('strong identity is scoped, label independent and preserves literal identifier formatting', () => {
  const first = mention('a'), renamed = { ...mention('b'), name: 'Renamed Synthetic Utility GmbH', municipalityId: 'town-two' };
  const resolved = resolveIdentityMentions([first, renamed]);
  assert.equal(resolved.clusters.length, 1);
  assert.equal(resolved.clusters[0].aliases.length, 2);
  assert.equal(resolveIdentityMentions([first]).clusters[0].id, resolveIdentityMentions([{ ...first, name: 'New label' }]).clusters[0].id);
  assert.equal(resolveIdentityMentions([first, { ...renamed, identifiers: [{ ...renamed.identifiers[0], issuer: 'Other Register' }] }]).clusters.length, 2);
  assert.equal(resolveIdentityMentions([first, mention('b', '123')]).clusters.length, 2);
});

test('whole-cluster conflicts block transitive bridges instead of trusting adjacent matches', () => {
  const a = mention('a', 'x', 'A'), b = mention('b', 'x', 'A'), c = mention('c', 'y', 'B');
  b.identifiers.push({ namespace: 'B', issuer: 'Synthetic Register', value: 'y', evidenceHashes: [hash] });
  c.identifiers.push({ namespace: 'A', issuer: 'Synthetic Register', value: 'z', evidenceHashes: [hash] });
  const result = resolveIdentityMentions([a, b, c]);
  assert.equal(result.clusters.length, 2);
  assert.ok(result.blocked.some(value => value.reasons.includes('conflicting_strong_identifiers')));
  assert.ok(!result.clusters.some(value => value.mentionIds.includes('a') && value.mentionIds.includes('c')));
});

test('retraction preserves mentions and reverses an accepted identity merge', () => {
  const mentions = [mention('a'), mention('b')];
  const accepted = resolveIdentityMentions(mentions).assertions[0];
  const retracted = { ...accepted, version: 2, status: 'retracted' as const };
  const result = resolveIdentityMentions(mentions, [accepted, retracted]);
  assert.equal(result.clusters.length, 2);
  assert.notEqual(result.clusters[0].id, result.clusters[1].id);
  assert.equal(result.assertions[0].status, 'retracted');
  assert.deepEqual(result.clusters.flatMap(value => value.mentionIds).sort(), ['a', 'b']);
});

test('model matches remain shadow and hard conflicts override reviewed decisions', () => {
  const a = mention('a'), b = { ...mention('b'), legalForm: 'GmbH & Co. KG' };
  const shadow = identityAssertion({ version: 1, leftMentionId: 'a', rightMentionId: 'b', decision: 'same_identity', status: 'proposed', method: 'model_shadow', ruleVersion: 'synthetic-model-contract', author: 'synthetic-model', adjudicator: null, reviewReceiptSha256: null, evidenceHashes: [hash], validity: unknownValidity() });
  assert.equal(IdentityAssertionSchema.safeParse({ ...shadow, status: 'accepted' }).success, false);
  const reviewed = identityAssertion({ ...shadow, method: 'authoritative_review', status: 'accepted', adjudicator: 'synthetic-review', reviewReceiptSha256: hash });
  const result = resolveIdentityMentions([a, b], [reviewed]);
  assert.equal(result.clusters.length, 2);
  assert.ok(result.blocked.some(value => value.reasons.includes('incompatible_legal_forms')));
});

test('same-name utilities and programme periods are candidates, not confirmed identities', () => {
  const a = { ...mention('a'), identifiers: [] }, b = { ...mention('b'), identifiers: [] };
  assert.deepEqual(identityCandidatePairs([a, b]), [['a', 'b']]);
  assert.equal(resolveIdentityMentions([a, b]).clusters.length, 2);
  assert.equal(identityCandidatePairs([a, { ...b, municipalityId: 'town-two' }]).length, 0);
  const programme = { ...mention('p'), type: 'funding_programme', legalForm: null, period: '2021-2027' };
  const next = { ...programme, id: 'q', period: '2028-2034' };
  assert.equal(resolveIdentityMentions([programme, next]).clusters.length, 2);
});

test('expired, disjoint and unknown applicability cannot establish a current/as-of path', () => {
  const expired = interval('2020-01-01', '2023-12-31'), current = interval('2024-01-01', '2026-12-31');
  assert.equal(intervalContains(expired, '2026-10-11'), false);
  assert.equal(intervalIntersection([expired, current]), null);
  assert.equal(intervalContains(unknownValidity(), '2026-10-11'), false);
  assert.equal(intervalIntersection([unknownValidity(), current]), null);
  const open = { ...current, validTo: { kind: 'open' as const } };
  assert.equal(intervalContains(open, '2028-01-01'), true);
  assert.equal(intervalContains({ ...open, validTo: { kind: 'unknown' } }, '2026-10-11'), false);
});

test('boundary inclusivity, precision and fixed asOf are explicit and replayable', () => {
  const value = interval('2026-01-01', '2026-10-11');
  assert.equal(intervalContains(value, '2026-10-11'), true);
  assert.equal(intervalContains({ ...value, validTo: { kind: 'date', date: '2026-10-11', inclusive: false, precision: 'day' } }, '2026-10-11'), false);
  assert.equal(intervalContains({ ...value, validFrom: { kind: 'date', date: '2026-01-01', inclusive: true, precision: 'year' } }, '2026-10-11'), false);
  assert.deepEqual(intervalIntersection([value, interval('2026-02-01', '2027-01-01')]), intervalIntersection([value, interval('2026-02-01', '2027-01-01')]));
  assert.equal(EffectiveIntervalSchema.safeParse({ ...value, evidenceHashes: [] }).success, false);
  assert.throws(() => intervalContains(value, '2026-02-30'));
});

test('native operator mapping uses original source fields; unknown operation validity stays non-current', () => {
  const scope: AdapterScope = { publisherId: 'bnetza', sourceId: 'mastr', municipalityId: 'town-one', ags: '12064472', tenant: null, observationWindow: '2026-10-11' };
  const cells: StructuredLocator[] = ['SEE000000000001', 'ABR000000000001', 'Synthetic Utility GmbH'].map((rawValue, i) => ({ sourceSha256: hash, format: 'csv', nativeId: 'SEE000000000001', path: `export/A${i + 1}`, sheet: null, rowKey: 'SEE000000000001', cells: [`A${i + 1}`], rawValue, schemaHash: hash, mappingVersion: 'mastr-public-export-v2' }));
  const native = observation({ publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId: 'SEE000000000001', nativeVersion: null, kind: 'RegisteredOperatorAssignment', subject: 'mastr:actor:ABR000000000001', predicate: 'operates', value: 'mastr:unit:SEE000000000001', unit: null, date: null, dateRole: null, financialRole: 'none', geography: { ags: scope.ags, basis: 'source_explicit', role: 'project_location' }, sourceReferenceDate: null, publishedAt: null, retrievedAt: '2026-10-11T00:00:00Z', evidence: cells, limitations: [] });
  const graph = nativeStructuredIdentityGraph(native, scope);
  assert.equal(graph.mentions.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(intervalContains(graph.relations[0].validity, '2026-10-11'), false);
  assert.throws(() => nativeStructuredIdentityGraph({ ...native, evidence: cells.filter(value => value.rawValue !== 'ABR000000000001') }, scope), /lacks source field evidence/);
  assert.equal(nativeStructuredIdentityGraph({ ...native, subject: 'Synthetic Utility GmbH' }, scope).relations.length, 0);
  assert.equal(nativeStructuredIdentityGraph({ ...native, evidence: cells.map(value => ({ ...value, mappingVersion: 'unknown-mapping' })) }, scope).mentions.length, 0);
});

test('chronological event chains admit separate approval/payment dates and check identity at each event', () => {
  const event = (date: string) => ({ validity: unknownValidity(), identityValidity: [interval('2020-01-01', '2026-12-31')], eventDate: date, eventDateRole: 'synthetic-event', eventEvidenceHashes: [hash], unresolvedContradiction: false });
  assert.equal(temporalPathEligible([event('2023-01-01'), event('2025-01-01')], '2026-10-11', 'chronological'), true);
  assert.equal(temporalPathEligible([event('2025-01-01'), event('2023-01-01')], '2026-10-11', 'chronological'), false);
  assert.equal(temporalPathEligible([{ ...event('2025-01-01'), identityValidity: [interval('2020-01-01', '2024-12-31')] }], '2026-10-11', 'chronological'), false);
  assert.equal(temporalPathEligible([event('2027-01-01')], '2026-10-11'), false);
  const ongoing = { validity: interval('2024-01-01', '2026-12-31'), identityValidity: [], eventDate: null, eventDateRole: null, eventEvidenceHashes: [], unresolvedContradiction: false };
  assert.equal(temporalPathEligible([ongoing, { ...ongoing, validity: interval('2020-01-01', '2023-12-31') }], '2026-10-11'), false);
  assert.equal(temporalPathEligible([{ ...ongoing, unresolvedContradiction: true }], '2026-10-11'), false);
});

test('source interval normalization requires express open-ended applicability, not absence of an end', () => {
  const missingEnd = effectiveIntervalFromExpression('seit 2020-01-01', [hash]);
  assert.equal(intervalContains(missingEnd, '2026-10-11'), false);
  assert.equal(missingEnd.expression, 'seit 2020-01-01');
  assert.equal(intervalContains(effectiveIntervalFromExpression('ab 2020-01-01 bis auf Weiteres', [hash]), '2026-10-11'), true);
  const exclusive = effectiveIntervalFromExpression('nach 2020-01-01 bis ausschließlich 2026-10-11', [hash]);
  assert.equal(intervalContains(exclusive, '2026-10-11'), false);
  assert.equal(intervalContains(exclusive, '2026-10-10'), true);
  assert.equal(intervalContains(effectiveIntervalFromExpression('am 2026-10-11', [hash]), '2026-10-11'), true);
  assert.equal(intervalContains(effectiveIntervalFromExpression('am 2026-10-11', [hash]), '2026-10-12'), false);
  assert.throws(() => effectiveIntervalFromExpression('2026-02-30 bis 2027-01-01', [hash]));
});

test('admission summaries bind the complete reviewed assertion but are not proof of executed assessments by themselves', () => {
  // Pure binding fixture; the publication verifier separately replays actual private CAS A/B/C receipts.
  const mentions = [mention('a'), { ...mention('b'), municipalityId: 'town-two' }];
  const reviewed = identityAssertion({ version: 1, leftMentionId: 'a', rightMentionId: 'b', decision: 'same_identity', status: 'accepted', method: 'authoritative_review', ruleVersion: 'synthetic-review-rule', author: 'synthetic-review', adjudicator: 'synthetic-adjudicator', evidenceHashes: [hash], reviewReceiptSha256: semanticHash('synthetic final'), validity: unknownValidity() });
  const body = { schemaVersion: 'assessment-disposition-v1' as const, assertionId: reviewed.id, assertionSha256: semanticHash(reviewed), assessmentReceiptSha256: reviewed.reviewReceiptSha256!, receiptHashes: { A: semanticHash('synthetic A'), B: semanticHash('synthetic B'), C: semanticHash('synthetic C') }, itemSha256: semanticHash('synthetic item'), leftMentionId: 'a', rightMentionId: 'b', decision: reviewed.decision, status: 'admitted' as const, adjudicator: reviewed.adjudicator!, labelProvenance: 'ai_reconciled' as const, sourceEvidenceHashes: [hash], deterministicPassed: true as const };
  const admission = IdentityAdmissionSchema.parse({ ...body, sealSha256: semanticHash(body) });
  assert.doesNotThrow(() => assertIdentityAssertionsBound(mentions, [reviewed], [admission]));
  assert.throws(() => assertIdentityAssertionsBound(mentions, [reviewed], []), /admission seal/);
  assert.throws(() => assertIdentityAssertionsBound(mentions, [{ ...reviewed, version: 2 }], [admission]), /admission seal/);
  assert.throws(() => assertIdentityAssertionsBound(mentions, [{ ...reviewed, evidenceHashes: [semanticHash('unbound original')] }], [admission]), /Unbound/);
  const inventedForever = { ...reviewed, validity: { validFrom: { kind: 'open' as const }, validTo: { kind: 'open' as const }, expression: 'Stand 2026', evidenceHashes: [hash] } };
  assert.throws(() => assertIdentityAssertionsBound(mentions, [inventedForever], [admission]), /source expression normalization/);
  const strong = resolveIdentityMentions(mentions).assertions[0];
  assert.throws(() => assertIdentityAssertionsBound(mentions.map(value => ({ ...value, validity: unknownValidity() })), [{ ...strong, validity: interval('2020-01-01', '2030-12-31') }], []), /sourced endpoint validity/);
});

test('native council and WFS spines use tenant/native identifiers, not publication labels or overlapping geometry', () => {
  const scope: AdapterScope = { publisherId: 'synthetic-publisher', sourceId: 'council-synthetic', municipalityId: 'town-one', ags: '12064472', tenant: 'body-one', observationWindow: '2026-10-11' };
  const id = 'https://example.org/oparl/paper/123', target = 'https://example.org/oparl/body/1';
  const locator: StructuredLocator = { sourceSha256: hash, format: 'json', nativeId: id, path: '/body', sheet: null, rowKey: id, cells: [], rawValue: target, schemaHash: hash, mappingVersion: 'council-native-v3' };
  const base = { publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId: id, nativeVersion: null, kind: 'Paper', subject: `${scope.publisherId}:${scope.sourceId}:${scope.tenant}:${id}`, predicate: 'belongs_to_body', value: target, unit: null, date: null, dateRole: null, financialRole: 'none' as const, geography: { ags: scope.ags, basis: 'verified_join' as const, role: 'administrative_area' as const }, sourceReferenceDate: null, publishedAt: null, retrievedAt: '2026-10-11T00:00:00Z', evidence: [locator], limitations: [] };
  const council = nativeStructuredIdentityGraph(observation(base), scope);
  assert.deepEqual(council.mentions.map(value => value.type), ['council_paper', 'authority']);
  assert.equal(council.relations[0].predicate, 'belongs_to_body');
  assert.equal(council.relations[0].eventDate, null);
  const otherScope = { ...scope, tenant: 'body-two' };
  const other = nativeStructuredIdentityGraph(observation({ ...base, subject: `${scope.publisherId}:${scope.sourceId}:${otherScope.tenant}:${id}` }), otherScope);
  assert.notEqual(resolveIdentityMentions(council.mentions).clusters[0].id, resolveIdentityMentions(other.mentions).clusters[0].id);
  const planScope = { ...scope, sourceId: 'sh-plan-xplan-wfs', tenant: null };
  const plan = observation({ ...base, sourceId: planScope.sourceId, nativeId: 'plan-001', kind: 'SpatialPlan', subject: canonicalJson([planScope.publisherId, planScope.sourceId, 'plan-001']), predicate: 'plan_name', value: 'Synthetic Plan Label', evidence: [{ ...locator, format: 'xml', nativeId: 'plan-001', path: '/FeatureCollection/member/BP_Plan[@gml:id=\"plan-001\"]/name', rawValue: 'Synthetic Plan Label', mappingVersion: `planning-wfs-native-v1:${hash}` }] });
  const graph = nativeStructuredIdentityGraph(plan, planScope);
  assert.equal(graph.mentions[0].type, 'spatial_plan'); assert.equal(graph.relations.length, 0);
  const { id: _observationId, ...planFields } = plan;
  const renamed = nativeStructuredIdentityGraph(observation({ ...planFields, value: 'Renamed Plan Label', evidence: plan.evidence.map(value => ({ ...value, sourceSha256: semanticHash('synthetic newer plan bytes'), rawValue: 'Renamed Plan Label' })) }), planScope);
  assert.equal(resolveIdentityMentions(graph.mentions).clusters[0].id, resolveIdentityMentions(renamed.mentions).clusters[0].id);
});

test('German calendars and coarse boundaries retain precision without fabricating exact starts or current points', () => {
  assert.equal(sourceCalendarDay('29. Februar 2024'), '2024-02-29');
  assert.equal(sourceCalendarDay('29. Februar 2023'), null);
  assert.equal(sourceCalendarDay('1. 3. 2026'), '2026-03-01');
  const years = effectiveIntervalFromExpression('seit 2020 bis 2030', [hash]);
  assert.equal(years.validFrom.kind === 'date' ? years.validFrom.precision : null, 'year');
  assert.equal(intervalContains(years, '2026-10-11'), true);
  assert.equal(intervalContains(years, '2020-05-01'), false);
  assert.equal(intervalContains(years, '2030-10-11'), false);
  const months = effectiveIntervalFromExpression('2024-02 bis 2024-04', [hash]);
  assert.equal(intervalContains(months, '2024-03-01'), true);
  assert.equal(intervalContains(months, '2024-02-15'), false);
  assert.equal(intervalContains(effectiveIntervalFromExpression('im Jahr 2020', [hash]), '2020-07-01'), false);
  assert.equal(intervalContains(effectiveIntervalFromExpression('bis 2030', [hash]), '2026-10-11'), false);
  assert.equal(legalFormFromName('Synthetic Provider GmbH & Co. KG'), 'GmbH & Co. KG');
  assert.equal(legalFormFromName('Synthetic Provider GmbH'), 'GmbH');
  assert.equal(legalFormFromName('Synthetic Provider e. V.'), 'e.V.');
});

test('native funding and permit spines preserve explicit IDs and source-scoped recipient/programme uncertainty', () => {
  const scope: AdapterScope = { publisherId: 'synthetic', sourceId: 'funding-sh-efre-beneficiaries', municipalityId: 'town-one', ags: '01053090', tenant: null, observationWindow: '2026-10-11' };
  const source = (kind: string, predicate: string, value: string, raw: string[], version = 'funding-operations-v2') => observation({
    publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId: 'operation-001', nativeVersion: '1', kind, subject: `${scope.publisherId}:${scope.sourceId}:operation:operation-001`, predicate, value, unit: null,
    date: null, dateRole: null, financialRole: 'none', geography: { ags: scope.ags, basis: 'source_explicit', role: 'project_location' }, sourceReferenceDate: null, publishedAt: null, retrievedAt: '2026-10-11T00:00:00Z', evidence: raw.map((rawValue, i) => ({ sourceSha256: hash, format: 'csv', nativeId: 'operation-001', path: `export/A${i}`, sheet: null, rowKey: 'operation-001', cells: [`A${i}`], rawValue, schemaHash: hash, mappingVersion: version })), limitations: [],
  });
  const recipient = nativeStructuredIdentityGraph(source('FundingOperation', 'awarded_to', 'synthetic:beneficiary-mention:001', ['Synthetic Provider GmbH']), scope);
  assert.equal(recipient.mentions[0].type, 'funding_operation');
  assert.equal(recipient.mentions[0].identifiers.length, 1);
  assert.equal(recipient.mentions[1].identifiers.length, 0);
  assert.equal(recipient.mentions[1].legalForm, 'GmbH');
  assert.equal(recipient.relations[0].predicate, 'awarded_to');
  const programme = { authority: 'Synthetic Authority', fund: 'EFRE', period: '2021-2027', code: 'CCI-001', identityBasis: 'synthetic explicit tuple' };
  const explicit = nativeStructuredIdentityGraph(source('ProgrammeAttribution', 'programme', canonicalJson(programme), [programme.authority, programme.fund, programme.period, programme.code]), scope);
  assert.ok(explicit.mentions.some(value => value.type === 'funding_programme' && value.period === '2021-2027'));
  const defaults = nativeStructuredIdentityGraph(source('ProgrammeAttribution', 'programme', canonicalJson(programme), ['operation-001']), scope);
  assert.ok(defaults.mentions.every(value => value.type !== 'funding_programme'));
  const permitScope = { ...scope, sourceId: 'uvp-sh' }, permit = source('PermitProcedureMetadata', 'published_file_reference', 'AZ-001', ['AZ-001'], 'permit-notices-html-v1');
  assert.equal(nativeStructuredIdentityGraph({ ...permit, sourceId: permitScope.sourceId }, permitScope).mentions[0].type, 'permit_procedure');
  assert.equal(nativeStructuredIdentityGraph({ ...permit, sourceId: permitScope.sourceId, kind: 'PermitNoticeDocumentMetadata' }, permitScope).mentions.length, 0);
});
