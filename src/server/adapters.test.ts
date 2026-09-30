import test from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { createAgreement } from './agreements.ts';
import { HOME_ASSISTANT_UNAVAILABLE_MESSAGE, homeAssistantPullAllowed, readAdapterConfig, readHomeEnergy, readSolar, saveAdapterConfig, type AdapterConfig } from './adapters.ts';
import { LocalStore } from './store.ts';
import { readServiceCharges } from './service-charges.ts';

const person = (subject: string): VerifiedIdentity => ({
  subject, sessionId: `session-${subject}`, expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1, backupLoginLinked: true,
  wallets: [{ id: `wallet-${subject}`, address: `address-${subject}`, chainType: 'solana' }],
});

test('Home Assistant pull is local by default and requires production operator opt-in, except on Vercel', () => {
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'production', ALLOW_HOME_ASSISTANT_PULL: 'true' }), false);
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'production', ALLOW_HOME_ASSISTANT_PULL: '1' }), true);
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'production', ALLOW_HOME_ASSISTANT_PULL: '1', VERCEL: '1' }), false);
  assert.equal(homeAssistantPullAllowed({ NODE_ENV: 'development', ALLOW_HOME_ASSISTANT_PULL: '1', VERCEL: '' }), false);
});

const environment = process.env as Record<string, string | undefined>;

/** Runs a test body with these variables set (undefined removes one), then restores what was there. */
async function withEnvironment(values: Record<string, string | undefined>, body: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, environment[name]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(next)) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  };
  apply(values);
  try { await body(); } finally { apply(previous); }
}
const production = { NODE_ENV: 'production', ALLOW_HOME_ASSISTANT_PULL: undefined };

test('disabled host rejects saves while allowing existing credential removal', async () => {
  const store = new LocalStore(':memory:');
  const owner = person('disabled-owner');
  try {
    await saveAdapterConfig(store, owner, { kind: 'homeAssistant', url: 'http://homeassistant.local:8123', token: 'secret-test-token-for-removal' });
    await withEnvironment(production, async () => {
      await assert.rejects(saveAdapterConfig(store, owner, { kind: 'homeAssistant', url: 'http://homeassistant.local:8123', token: 'changed-test-token-for-removal' }),
        { message: HOME_ASSISTANT_UNAVAILABLE_MESSAGE });
      assert.equal((await store.get<AdapterConfig>(`adapters:${owner.subject}`))?.homeAssistant?.token, 'secret-test-token-for-removal');
      const result = await saveAdapterConfig(store, owner, { kind: 'homeAssistant', remove: true });
      assert.equal(result.homeAssistant, undefined);
      assert.equal((await store.get<AdapterConfig>(`adapters:${owner.subject}`))?.homeAssistant, undefined);
    });
  } finally {
    await store.close();
  }
});

test('disabled host rejects both readings before resolving DNS or fetching states', async () => {
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Fetch must not be called'); };
    await withEnvironment(production, async () => {
      const config = { url: 'http://not-a-host.invalid:8123', token: 'test-token', pricePerKwh: 0.3 };
      for (const reader of [readSolar, readHomeEnergy])
        await assert.rejects(reader(config), { message: HOME_ASSISTANT_UNAVAILABLE_MESSAGE });
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test('host check rejects tailnet boundaries and IPv4-mapped private IPv6 addresses', async () => {
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Fetch must not be called'); };
    await withEnvironment({ NODE_ENV: 'development' }, async () => {
      for (const host of ['100.64.0.1', '100.127.255.254', '[::ffff:10.0.0.1]'])
        await assert.rejects(readSolar({ url: `http://${host}:8123`, token: 'test-token', pricePerKwh: 0.3 }),
          { message: 'That Home Assistant address is not allowed from this server.' });
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test('disabled Home Assistant leaves service charges on the labelled example week', async () => {
  const store = new LocalStore(':memory:');
  const owner = person('service-charge-fallback');
  try {
    const agreement = await createAgreement(store, owner, {
      network: 'solana', property: 'Example home', requiredSecurity: '1000000000', releaseAllowed: true,
    });
    await store.create(`adapters:${owner.subject}`, {
      homeAssistant: { url: 'http://localhost:8123', token: 'test-token-long-enough', pricePerKwh: 0.3 },
    });
    await withEnvironment(production, async () => {
      const account = await readServiceCharges(store, owner, agreement.id, async () => { throw new Error('Reader must not be called'); });
      assert.equal(account.consumption.source, 'example');
      assert.deepEqual(account.consumption.exampleWeekKwh, [5.8, 6.2, 6.4, 6.1, 5.9, 6.6, 6.4]);
      assert.equal(account.consumption.adapterUnavailableReason, HOME_ASSISTANT_UNAVAILABLE_MESSAGE);
      assert.equal(account.consumption.adapterUnavailable, true);
      assert.equal(account.prepaymentCents, 15000);
    });
  } finally {
    await store.close();
  }
});

test('adapter configuration is subject-owned, redacted, and one revocation preserves the other', async () => {
  const store = new LocalStore(':memory:');
  const alice = person('adapter-alice');
  const bob = person('adapter-bob');
  const secret = 'alice-long-lived-token-never-public';
  try {
    const home = await saveAdapterConfig(store, alice, {
      kind: 'homeAssistant', url: 'http://homeassistant.local:8123', token: secret,
      entity: 'sensor.solar_energy_today', pricePerKwh: 0.34,
    });
    assert.deepEqual(home, { homeAssistant: { url: 'http://homeassistant.local:8123', entity: 'sensor.solar_energy_today', pricePerKwh: 0.34 }, validator: undefined });
    assert.equal(JSON.stringify(home).includes(secret), false);
    assert.deepEqual(await readAdapterConfig(store, bob), { homeAssistant: undefined, validator: undefined });

    await saveAdapterConfig(store, alice, { kind: 'validator', chain: 'gnosis', id: '12345' });
    await saveAdapterConfig(store, alice, { kind: 'homeAssistant', url: 'https://ha.example.org', token: '', entity: '', pricePerKwh: 0.4 });
    assert.equal((await store.get<AdapterConfig>(`adapters:${alice.subject}`))?.homeAssistant?.token, secret);
    assert.equal((await readAdapterConfig(store, alice)).validator?.id, '12345');
    assert.equal(JSON.stringify(await readAdapterConfig(store, alice)).includes(secret), false);

    const withoutHome = await saveAdapterConfig(store, alice, { kind: 'homeAssistant', remove: true });
    assert.equal(withoutHome.homeAssistant, undefined);
    assert.deepEqual(withoutHome.validator, { chain: 'gnosis', id: '12345' });
    assert.equal((await store.get<AdapterConfig>(`adapters:${alice.subject}`))?.homeAssistant, undefined);
    assert.deepEqual(await readAdapterConfig(store, bob), { homeAssistant: undefined, validator: undefined });

    await saveAdapterConfig(store, bob, { kind: 'validator', chain: 'ethereum', id: '42' });
    await saveAdapterConfig(store, alice, { kind: 'validator', remove: true });
    assert.equal((await readAdapterConfig(store, alice)).validator, undefined);
    assert.deepEqual((await readAdapterConfig(store, bob)).validator, { chain: 'ethereum', id: '42' });
  } finally {
    await store.close();
  }
});

for (const existing of [false, true]) {
  test(`concurrent connection saves preserve both adapters (${existing ? 'existing' : 'new'} record)`, async () => {
    const store = new LocalStore(':memory:');
    const owner = person('concurrent-owner');
    try {
      if (existing) await store.create(`adapters:${owner.subject}`, {});
      await Promise.all([
        saveAdapterConfig(store, owner, {
          kind: 'homeAssistant', url: 'http://homeassistant.local:8123',
          token: 'concurrent-test-token-not-public', entity: 'sensor.solar_today', pricePerKwh: 0.35,
        }),
        saveAdapterConfig(store, owner, { kind: 'validator', chain: 'ethereum', id: '42' }),
      ]);
      const result = await readAdapterConfig(store, owner);
      assert.equal(result.homeAssistant?.entity, 'sensor.solar_today');
      assert.deepEqual(result.validator, { chain: 'ethereum', id: '42' });
      assert.equal(JSON.stringify(result).includes('concurrent-test-token-not-public'), false);
    } finally {
      await store.close();
    }
  });
}

test('a concurrent validator save cannot resurrect a revoked Home Assistant credential', async () => {
  const store = new LocalStore(':memory:');
  const owner = person('revocation-owner');
  try {
    await saveAdapterConfig(store, owner, {
      kind: 'homeAssistant', url: 'http://homeassistant.local:8123', token: 'revocation-test-token-not-public',
    });
    await Promise.all([
      saveAdapterConfig(store, owner, { kind: 'homeAssistant', remove: true }),
      saveAdapterConfig(store, owner, { kind: 'validator', chain: 'gnosis', id: '77' }),
    ]);
    const stored = await store.get<AdapterConfig>(`adapters:${owner.subject}`);
    assert.equal(stored?.homeAssistant, undefined);
    assert.deepEqual(stored?.validator, { chain: 'gnosis', id: '77' });
  } finally {
    await store.close();
  }
});

test('blank-token updates preserve a concurrently replaced credential, not a stale one', async () => {
  const store = new LocalStore(':memory:');
  const owner = person('rotation-owner');
  const connection = { kind: 'homeAssistant', url: 'http://homeassistant.local:8123' };
  try {
    await saveAdapterConfig(store, owner, { ...connection, token: 'old-test-token-not-a-real-credential' });
    await Promise.all([
      saveAdapterConfig(store, owner, { ...connection, token: 'new-test-token-not-a-real-credential' }),
      saveAdapterConfig(store, owner, { ...connection, token: '', pricePerKwh: 0.45 }),
    ]);
    const stored = await store.get<AdapterConfig>(`adapters:${owner.subject}`);
    assert.equal(stored?.homeAssistant?.token, 'new-test-token-not-a-real-credential');
    assert.equal(stored?.homeAssistant?.pricePerKwh, 0.45);
  } finally {
    await store.close();
  }
});
