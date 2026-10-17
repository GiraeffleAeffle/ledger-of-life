import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticHash } from '../src/district-adapter-contract.ts';
import { CaseReferenceSchema, attachCaseEvents, caseEvent, caseIdentity, caseIdentityFromText, type CaseReference } from '../src/district-case-linking.ts';
import { unknownValidity, type EffectiveInterval } from '../src/district-entity-resolution.ts';
const hash = semanticHash('synthetic source fixture');
const reference: CaseReference = { kind: 'funding_operation', namespace: 'Synthetic FKZ', issuer: 'Synthetic Authority', municipalityId: 'town-one', tenant: null, value: '000123', version: null, planType: null, period: '2021-2027', evidenceHashes: [hash] };
const validity: EffectiveInterval = { validFrom: { kind: 'date', date: '2020-01-01', precision: 'day', inclusive: true }, validTo: { kind: 'date', date: '2027-12-31', precision: 'day', inclusive: true }, expression: '2020-01-01 through 2027-12-31', evidenceHashes: [hash] };

test('native case keys retain issuer, municipality, tenant, version and programme period', () => {
  const build = (value: CaseReference) => caseIdentity({ reference: value, municipalityId: value.municipalityId, sourceSha256: hash });
  const baseline = build(reference);
  for (const changed of [{ ...reference, issuer: 'Other Authority' }, { ...reference, municipalityId: 'town-two' }, { ...reference, tenant: 'other-tenant' }, { ...reference, version: '2' }, { ...reference, period: '2028-2034' }]) assert.notEqual(build(changed).id, baseline.id);
  assert.equal(build({ ...reference, evidenceHashes: [semanticHash('new evidence')] }).id, baseline.id);
  assert.throws(() => caseIdentity({ reference, municipalityId: 'town-two', sourceSha256: hash }), /scope mismatch/);
});

test('document fallback is a scoped mention bucket, never a counted project', () => {
  const bucket = caseIdentity({ reference: null, municipalityId: 'town-one', sourceSha256: hash });
  assert.equal(bucket.kind, 'document_bucket');
  assert.equal(bucket.countedProject, false);
  assert.notEqual(caseIdentity({ reference: null, municipalityId: 'town-two', sourceSha256: hash }).id, bucket.id);
  assert.notEqual(caseIdentity({ reference: null, municipalityId: 'town-one', sourceSha256: semanticHash('other source') }).id, bucket.id);
});

test('exact plan number still needs type and explicit amendment/version; paper is an event, not project', () => {
  assert.equal(CaseReferenceSchema.safeParse({ ...reference, kind: 'plan_number' }).success, false);
  const plan = { ...reference, kind: 'plan_number' as const, planType: 'Bebauungsplan', version: 'original' };
  assert.notEqual(caseIdentity({ reference: plan, municipalityId: 'town-one', sourceSha256: hash }).id, caseIdentity({ reference: { ...plan, version: '2. Änderung' }, municipalityId: 'town-one', sourceSha256: hash }).id);
  assert.equal(CaseReferenceSchema.safeParse({ ...reference, kind: 'paper_reference' }).success, false);
  const paper = caseIdentity({ reference: { ...reference, kind: 'paper_reference', version: '2026' }, municipalityId: 'town-one', sourceSha256: hash });
  assert.equal(paper.kind, 'event'); assert.equal(paper.countedProject, false);
});

test('approval and later payment remain distinct, chronological sourced events', () => {
  const identity = caseIdentity({ reference, municipalityId: 'town-one', sourceSha256: hash });
  const input = { nativeId: 'notice-one', issuer: 'Synthetic Authority', namespace: 'Synthetic Events', version: '1', dateEvidenceHashes: [hash], references: [reference], participants: [{ entityId: 'synthetic-entity', role: 'beneficiary', validity, identityValidity: [validity] }], evidenceHashes: [hash] };
  const approval = caseEvent({ ...input, role: 'approval', date: '2023-06-01' });
  const payment = caseEvent({ ...input, role: 'payment', date: '2025-06-01' });
  assert.notEqual(approval.id, payment.id);
  const result = attachCaseEvents(identity, [payment, approval]);
  assert.deepEqual(result.events.map(event => event.role), ['approval', 'payment']);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.temporalMode, 'chronological_event_dates');
  const changedRole = { ...payment, participants: [{ ...payment.participants[0], validity: unknownValidity() }] };
  assert.equal(attachCaseEvents(identity, [changedRole]).events.length, 0);
  const endedIdentity = { ...validity, validTo: { kind: 'date' as const, date: '2024-12-31', precision: 'day' as const, inclusive: true } };
  assert.equal(attachCaseEvents(identity, [{ ...payment, participants: [{ ...payment.participants[0], identityValidity: [endedIdentity] }] }]).events.length, 0);
});

test('same amount/title is not an event attachment and document bucket cannot acquire project events', () => {
  const event = caseEvent({ nativeId: 'synthetic-payment', issuer: 'Synthetic Authority', namespace: 'Synthetic Events', version: '1', role: 'payment', date: '2025-06-01', dateEvidenceHashes: [hash], references: [{ ...reference, value: 'another-operation' }], participants: [], evidenceHashes: [hash] });
  const identity = caseIdentity({ reference, municipalityId: 'town-one', sourceSha256: hash });
  assert.equal(attachCaseEvents(identity, [event]).unresolved[0].reason, 'no_explicit_case_reference');
  const bucket = caseIdentity({ reference: null, municipalityId: 'town-one', sourceSha256: hash });
  assert.equal(attachCaseEvents(bucket, [{ ...event, references: [reference] }]).events.length, 0);
});

test('live text projection keeps absent type/version as a document bucket and binds native issuer scope', () => {
  const text = { caseKeyType: 'plan_number' as const, caseKey: '12', caseQuote: 'Bebauungsplan 12', municipalityId: 'town-one', sources: [{ id: 'source-one', sha256: hash }], extraction: { inputSha256: hash }, verification: { evidenceHash: hash } };
  assert.equal(caseIdentityFromText(text).kind, 'document_bucket');
  assert.equal(caseIdentityFromText({ ...text, caseQuote: '2. Änderung Bebauungsplan 12' }).kind, 'procedure');
  const native = { ...text, caseKeyType: 'diplan' as const, caseQuote: 'native procedure 12' };
  assert.equal(caseIdentityFromText(native).kind, 'procedure');
  assert.notEqual(caseIdentityFromText(native).id, caseIdentityFromText({ ...native, sources: [{ id: 'other-source', sha256: hash }] }).id);
  assert.equal(caseIdentityFromText({ ...text, caseKeyType: 'paper_reference', caseKey: 'BV/2026/12', caseQuote: 'BV/2026/12' }).kind, 'event');
  assert.equal(caseIdentityFromText({ ...text, caseKeyType: 'paper_reference' }).kind, 'document_bucket');
  assert.equal(caseIdentityFromText({ ...native, sources: [{ id: 'source-one', sha256: semanticHash('other bytes') }] }).kind, 'document_bucket');
});
