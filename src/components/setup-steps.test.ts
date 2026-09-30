import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSetupStep, setupChecking, setupSteps } from './setup-steps.ts';
import type { LedgerStateInputs } from './ledger-adapter-state.ts';

const newAccount: LedgerStateInputs = {
  accountReady: true, authenticated: true, solanaLinked: true, robinhoodLinked: true,
  identity: { state: 'none' }, identityLoading: false, identityError: '',
  config: {}, configLoading: false, configError: '',
  homeLoading: false, homeError: '', tenancyCount: 0,
  cityId: '', cityName: '', cityLoading: false, cityError: '',
};
const status = (inputs: LedgerStateInputs) => Object.fromEntries(setupSteps(inputs).map((step) => [step.adapter.id, step.done]));

test('a brand-new account has signed in and nothing else', () => {
  assert.deepEqual(setupSteps(newAccount).map((step) => step.adapter.id), ['account', 'city', 'tenancy', 'eudi', 'homeAssistant', 'validator']);
  assert.deepEqual(status(newAccount), { account: true, city: false, tenancy: false, eudi: false, homeAssistant: false, validator: false });
});

test('finishing one action completes only its own step', () => {
  assert.deepEqual(status({ ...newAccount, cityId: 'strausberg', cityName: 'Strausberg', selectedCity: true }), { ...status(newAccount), city: true });
  assert.deepEqual(status({ ...newAccount, tenancyCount: 1 }), { ...status(newAccount), tenancy: true });
  assert.deepEqual(status({ ...newAccount, config: { validator: { chain: 'solana', id: 'vote-account' } } }), { ...status(newAccount), validator: true });
  assert.deepEqual(status({ ...newAccount, config: { homeAssistant: { url: 'http://homeassistant.local:8123', pricePerKwh: 0.3 } } }), { ...status(newAccount), homeAssistant: true });
  const verified = { state: 'verified', statement: { adult: true, issuer: 'test', credentialType: 'pid', verifiedAt: '2026-09-29T00:00:00Z', via: 'EU reference verifier (test environment)' } } as const;
  assert.deepEqual(status({ ...newAccount, identity: verified }), { ...status(newAccount), eudi: true });
});
test('a published home or pending application counts, but a public listing does not', () => {
  assert.equal(status({ ...newAccount, listingCount: 1 }).tenancy, true);
  assert.equal(status({ ...newAccount, listingCount: 0 }).tenancy, false);
});

test('a bare city slug does not count as choosing a city; an explicitly chosen uncovered place does', () => {
  assert.equal(status({ ...newAccount, cityId: 'unknown-slug' }).city, false);
  assert.equal(status({ ...newAccount, cityName: 'Chosen uncovered place', selectedCity: true, cityError: 'Atlas unavailable' }).city, true);
});


test('an unfinished step sends the person to the place where it is done', () => {
  const next = Object.fromEntries(setupSteps(newAccount).map((step) => [step.adapter.id, step.action]));
  assert.deepEqual([next.city.kind === 'area' && next.city.area, next.city.kind === 'area' && next.city.section], ['places', 'city-choice']);
  assert.deepEqual([next.tenancy.kind === 'area' && next.tenancy.area, next.tenancy.kind === 'area' && next.tenancy.section], ['home', 'home-options']);
  assert.deepEqual([next.homeAssistant.kind === 'area' && next.homeAssistant.area, next.homeAssistant.kind === 'area' && next.homeAssistant.section], ['me', 'adapter-home-assistant']);
  assert.deepEqual([next.validator.kind === 'area' && next.validator.area, next.validator.kind === 'area' && next.validator.section], ['me', 'adapter-validator']);
});

test('required steps always come before optional ones', () => {
  const optional = setupSteps(newAccount).map((step) => step.optional);
  assert.deepEqual(optional, [...optional].sort((a, b) => Number(a) - Number(b)));
});

test('the guide waits while any observation it depends on is still loading', () => {
  assert.equal(setupChecking(newAccount), false);
  for (const loading of ['identityLoading', 'configLoading', 'cityLoading', 'homeLoading'] as const)
    assert.equal(setupChecking({ ...newAccount, [loading]: true }), true, loading);
});

const cityStep = (inputs: LedgerStateInputs) => setupSteps(inputs).find((step) => step.adapter.id === 'city')!;

test('a city check that failed is not presented as a step to do', () => {
  const failed = { ...newAccount, cityError: 'Failed to fetch' };
  const city = cityStep(failed);
  assert.equal(city.done, false);
  assert.equal(city.checkFailed, true);
  assert.notEqual(nextSetupStep(setupSteps(failed))?.adapter.id, 'city', 'the guide must not tell the person to choose again');
  assert.equal(city.action.kind === 'area' && city.action.section === 'city-choice', false);
});

test('a city that was never chosen is still the next step, and a failed check never hides a chosen one', () => {
  assert.equal(nextSetupStep(setupSteps(newAccount))?.adapter.id, 'city');
  assert.equal(cityStep(newAccount).checkFailed, false);
  const chosen = cityStep({ ...newAccount, selectedCity: true, cityId: 'strausberg', cityName: 'Strausberg', cityError: 'Failed to fetch' });
  assert.equal(chosen.done, true);
  assert.equal(chosen.checkFailed, false);
});

test('every read that fails is marked as unchecked instead of as to do', () => {
  const failures: [string, Partial<LedgerStateInputs>][] = [
    ['city', { cityError: 'x' }], ['tenancy', { homeError: 'x' }], ['eudi', { identityError: 'x' }],
    ['homeAssistant', { configError: 'x' }], ['validator', { configError: 'x' }],
  ];
  for (const [id, failure] of failures) {
    const step = setupSteps({ ...newAccount, ...failure }).find((item) => item.adapter.id === id)!;
    assert.equal(step.done, false, `${id} is not done`);
    assert.equal(step.checkFailed, true, `${id} is unchecked`);
  }
  // Progress the person has already made stays visible even when a later read fails.
  const withHome = setupSteps({ ...newAccount, homeError: 'x', tenancyCount: 1 }).find((item) => item.adapter.id === 'tenancy')!;
  assert.deepEqual([withHome.done, withHome.checkFailed], [true, false]);
});

test('a step whose reading is being checked again is neither a task nor done', () => {
  const rechecking = { ...newAccount, cityLoading: true };
  const city = setupSteps(rechecking).find((step) => step.adapter.id === 'city')!;
  assert.deepEqual([city.done, city.checking, city.checkFailed], [false, true, false]);
  assert.notEqual(nextSetupStep(setupSteps(rechecking))?.adapter.id, 'city');
  // A chosen city stays done while it is read again.
  const chosen = setupSteps({ ...rechecking, selectedCity: true, cityId: 'strausberg', cityName: 'Strausberg' }).find((step) => step.adapter.id === 'city')!;
  assert.deepEqual([chosen.done, chosen.checking], [true, false]);
});
