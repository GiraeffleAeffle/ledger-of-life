import test from 'node:test';
import assert from 'node:assert/strict';
import { LEDGER_ADAPTERS } from '../data/ledger-catalogue.ts';
import { adapterAction, adapterState, type LedgerStateInputs } from './ledger-adapter-state.ts';

const cityAdapter = LEDGER_ADAPTERS.find((adapter) => adapter.connection === 'city')!;
const inputs: LedgerStateInputs = {
  accountReady: true, authenticated: true, solanaLinked: true, robinhoodLinked: true,
  identity: { state: 'none' }, identityLoading: false, identityError: '',
  config: {}, configLoading: false, configError: '',
  homeLoading: false, homeError: '', tenancyCount: 0,
  cityId: '', selectedCity: false, cityName: '', cityLoading: false, cityError: '',
};

test('a known uncovered home city counts as configured and opens civic content, not city setup', () => {
  const homeCity = { ...inputs, cityName: 'Munich-Sendling' };
  assert.equal(adapterState(cityAdapter, homeCity).configured, true);
  assert.equal(adapterState(cityAdapter, homeCity).tone, 'ready');
  assert.deepEqual(adapterAction(cityAdapter, homeCity), cityAdapter.action);
});

test('city setup is offered only after a successful read finds no city', () => {
  assert.equal(adapterState(cityAdapter, inputs).configured, false);
  const action = adapterAction(cityAdapter, inputs);
  assert.equal(action.kind, 'area');
  if (action.kind === 'area') assert.equal(action.section, 'city-choice');
  for (const unresolved of [{ ...inputs, cityLoading: true }, { ...inputs, cityError: 'offline' }]) {
    assert.deepEqual(adapterAction(cityAdapter, unresolved), cityAdapter.action);
    assert.equal(adapterState(cityAdapter, unresolved).tone, 'unknown');
  }
});
