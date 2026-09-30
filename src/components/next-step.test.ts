import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, type NextStepFacts } from './next-step.ts';

const none: NextStepFacts = { loading: false, invitation: false, homeError: '', tenancies: [], unavailable: 0, listings: [] };
const tenancy = (agreementId: string, kind: string, stage = 'deposit', label = 'Label') =>
  ({ agreementId, property: `Home ${agreementId}`, stage, next: { kind, label, detail: 'Detail' } });
const listing = (id: string, relation: 'landlord' | 'applicant' | 'chosen' | null, applications = 0, agreementId: string | null = null) =>
  ({ id, title: `Flat ${id}`, relation, status: 'open', applications: Array.from({ length: applications }), agreementId });

test('nothing is offered as a step while homes are still being read', () => {
  assert.equal(nextStep({ ...none, loading: true, tenancies: [tenancy('a', 'secure_deposit')] }).action, undefined);
});

test('an opened invitation comes first, even before the person’s own home step', () => {
  const step = nextStep({ ...none, invitation: true, tenancies: [tenancy('a', 'secure_deposit')] });
  assert.equal(step.action?.label, 'Review invitation');
});

test('a step waiting for this person beats applicants to review and anything waiting on others', () => {
  const step = nextStep({ ...none, tenancies: [tenancy('w', 'wait'), tenancy('a', 'accept_agreement')], listings: [listing('l', 'landlord', 2)] });
  assert.deepEqual(step.action, { label: 'Review agreement', target: { area: 'home', section: 'tenancy-a' } });
});

test('applicants to review beat a tenancy that waits on someone else', () => {
  const step = nextStep({ ...none, tenancies: [tenancy('w', 'confirming')], listings: [listing('l', 'landlord', 1)] });
  assert.equal(step.title, '1 application for Flat l needs your review.');
  assert.deepEqual(step.action?.target, { area: 'home', section: 'listing-l' });
});

test('a secured, quiet tenancy does not hide an application in progress', () => {
  const step = nextStep({ ...none, tenancies: [tenancy('home', 'wait', 'living')], listings: [listing('next', 'applicant')] });
  assert.equal(step.action?.label, 'View application');
});

test('a chosen application whose agreement already exists is not reported as being prepared', () => {
  const step = nextStep({ ...none, tenancies: [tenancy('g', 'wait', 'living')], listings: [listing('c', 'chosen', 0, 'g')] });
  assert.match(step.title, /secured\. Nothing needs you now/);
});

test('a failed read is never shown as an empty account', () => {
  const step = nextStep({ ...none, homeError: 'Homes: offline' });
  assert.equal(step.title, 'We could not check all of your homes.');
  assert.equal(step.action?.label, 'Open Home');
});

test('a fresh account starts with a home and offers city and test money as equal choices', () => {
  const step = nextStep(none);
  assert.equal(step.action?.label, 'Find a home');
  assert.deepEqual(step.choices?.map((choice) => choice.target.area), ['places', 'money']);
});

test('a paid-out tenancy offers another home without erasing its record', () => {
  const step = nextStep({ ...none, tenancies: [tenancy('p', 'done', 'paid')] });
  assert.equal(step.action?.label, 'View payout summary');
  assert.equal(step.choices?.[0].label, 'Find another home');
});
