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

test('connection rows distinguish a saved setting from a working live source', () => {
  const homeAssistant = LEDGER_ADAPTERS.find((adapter) => adapter.id === 'homeAssistant')!;
  const validator = LEDGER_ADAPTERS.find((adapter) => adapter.id === 'validator')!;
  const saved = {
    ...inputs,
    homeAssistantPull: false,
    config: {
      homeAssistant: { url: 'http://homeassistant.local:8123', entity: 'sensor.solar', pricePerKwh: 0.3 },
      validator: { chain: 'gnosis' as const, id: '123' },
    },
  };
  assert.deepEqual(adapterState(homeAssistant, saved), {
    label: 'Saved · unavailable on this host', tone: 'unknown', configured: true,
  });
  assert.equal(adapterState(validator, saved).label, 'Configured');
  assert.equal(adapterState(validator, { ...saved, configError: 'offline' }).label, 'Configuration unavailable');
  assert.equal(adapterState(validator, { ...saved, configLoading: true }).label, 'Checking configuration…');
  assert.deepEqual(adapterAction(validator, saved), validator.action);
});

test('EU proof rows distinguish pending, verified and unreadable proof', () => {
  const identity = LEDGER_ADAPTERS.find((adapter) => adapter.id === 'eudi')!;
  assert.equal(adapterState(identity, inputs).label, 'Optional proof to add');
  assert.equal(adapterState(identity, { ...inputs, identity: { state: 'pending', startedAt: '2026-10-03T10:00:00Z' } }).label, 'Verification in progress');
  assert.equal(adapterState(identity, { ...inputs, identityError: 'offline' }).label, 'Proof status unavailable');
  assert.equal(adapterState(identity, { ...inputs, identityLoading: true }).checking, true);
});
