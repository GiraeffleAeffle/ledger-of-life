import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathProgress, type PathFacts } from './path-progress.ts';

const fresh: PathFacts = { homeLoading: false, homeError: false, tenancies: [], listings: [], cityChosen: false, cityLoading: false, cityError: false };

test('a new account has every stage to do, and assets are a status, never done', () => {
  assert.deepEqual(pathProgress(fresh), { home: 'todo', deposit: 'todo', assets: 'status', city: 'todo' });
});

test('nothing reads as to do while it is still being read', () => {
  const progress = pathProgress({ ...fresh, homeLoading: true, cityLoading: true });
  assert.deepEqual([progress.home, progress.deposit, progress.city], ['unknown', 'unknown', 'unknown']);
});

test('a failed read is unknown, but known progress still counts', () => {
  assert.equal(pathProgress({ ...fresh, cityError: true }).city, 'unknown');
  const progress = pathProgress({ ...fresh, homeError: true, listings: [{ relation: 'applicant' }] });
  assert.equal(progress.home, 'done');
  assert.equal(progress.deposit, 'unknown');
});

test('a published listing or a pending application finishes stage 1; a public listing does not', () => {
  assert.equal(pathProgress({ ...fresh, listings: [{ relation: 'landlord' }] }).home, 'done');
  assert.equal(pathProgress({ ...fresh, listings: [{ relation: null }] }).home, 'todo');
});

test('the deposit counts as secured only once it is locked', () => {
  assert.equal(pathProgress({ ...fresh, tenancies: [{ stage: 'deposit' }] }).deposit, 'in-progress');
  assert.equal(pathProgress({ ...fresh, tenancies: [{ stage: 'living' }] }).deposit, 'done');
  assert.equal(pathProgress({ ...fresh, tenancies: [{ stage: 'paid' }] }).deposit, 'done');
});

test('cancelled records and closed listings leave no active home or deposit progress', () => {
  const cancelled = { stage: 'agreement', next: { kind: 'cancelled' } };
  const facts = { ...fresh, tenancies: [cancelled], listings: [{ relation: 'chosen' as const, status: 'closed' }] };
  assert.deepEqual(pathProgress(facts), pathProgress(fresh));
  assert.equal(pathProgress({ ...facts, homeError: true }).deposit, 'unknown');
  assert.equal(pathProgress({ ...facts, tenancies: [cancelled, { stage: 'deposit', next: { kind: 'wait' } }] }).deposit, 'in-progress');
  assert.equal(pathProgress({ ...facts, tenancies: [cancelled, { stage: 'living', next: { kind: 'wait' } }] }).deposit, 'done');
});
