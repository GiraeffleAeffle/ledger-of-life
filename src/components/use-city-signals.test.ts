import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorizedRequest } from './use-city-signals.ts';
import type { CityResult } from '../server/city.ts';

test('city changes invalidate unmounted consumers without leaking accounts or retaining rejected reads', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  try {
    // Import after installing the browser event target to exercise client module initialization.
    const { readPersonCity, CITY_CHANGED_EVENT } = await import('./use-city-signals.ts');
    let current: CityResult = { available: false, reason: 'choose' };
    const request = (async () => ({ city: current })) as AuthorizedRequest;
    const first = readPersonCity(request);
    assert.equal(await first, current);
    assert.equal(readPersonCity(request), first);
    current = { name: 'Strausberg', cityId: 'strausberg', source: 'home', available: false, reason: 'atlas' };
    // No React hook is mounted: the session-level listener must still forget it.
    events.dispatchEvent(new Event(CITY_CHANGED_EVENT));
    assert.equal((await readPersonCity(request)).cityId, 'strausberg');

    const other = (async () => ({ city: { name: 'Dresden', cityId: 'dresden', source: 'chosen', available: false, reason: 'atlas' } })) as AuthorizedRequest;
    assert.equal((await readPersonCity(other)).cityId, 'dresden');
    assert.equal((await readPersonCity(request)).cityId, 'strausberg');

    let attempts = 0;
    const retry = (async () => {
      if (++attempts === 1) throw new Error('offline');
      return { city: current };
    }) as AuthorizedRequest;
    await assert.rejects(readPersonCity(retry), /offline/);
    assert.equal((await readPersonCity(retry)).cityId, 'strausberg');

    let rejectOld!: (reason: Error) => void;
    const old = new Promise<{ city: CityResult }>((_, reject) => { rejectOld = reject; });
    let inFlightReads = 0;
    const inFlight = (() => ++inFlightReads === 1 ? old : Promise.resolve({ city: current })) as AuthorizedRequest;
    const stale = readPersonCity(inFlight);
    events.dispatchEvent(new Event(CITY_CHANGED_EVENT));
    const fresh = readPersonCity(inFlight);
    rejectOld(new Error('Account changed'));
    await assert.rejects(stale, /Account changed/);
    assert.equal(await fresh, current);
    assert.equal(readPersonCity(inFlight), fresh);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
