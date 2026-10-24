import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import * as policy from './financial-refresh.ts';
import type * as Hooks from './use-financial-refresh';

/** Explicit virtual clock: no wall-clock waits or browser/network services. */
function clock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), {
    setTimeout(run: () => void, delay: number) { const key = ++id; timers.set(key, { at: now + delay, run }); return key; },
    clearTimeout(key: number) { timers.delete(key); },
  });
  const drain = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const advance = async (milliseconds: number) => {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].run(); await drain();
    }
    now = end; await drain();
  };
  const visible = (value: boolean) => { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
  const balance = (chain: string) => window.dispatchEvent(Object.assign(new Event('ledger-balances-changed'), { detail: { chain } }));
  const environment = {
    visible: () => document.visibilityState === 'visible',
    later: (run: () => void, delay: number) => { const key = window.setTimeout(run, delay); return () => window.clearTimeout(key); },
    onVisible: (run: () => void) => { document.addEventListener('visibilitychange', run); return () => document.removeEventListener('visibilitychange', run); },
    onBalance: (run: (chain?: string) => void) => {
      const changed = (event: Event) => run((event as Event & { detail: { chain: string } }).detail.chain);
      window.addEventListener('ledger-balances-changed', changed); return () => window.removeEventListener('ledger-balances-changed', changed);
    },
  };
  return { document, window, advance, drain, visible, balance, environment, timers };
}

test('visible idle displays make one initial read, no daily timer, and refresh on relevant events/return/manual interaction', async () => {
  const browser = clock(); let reads = 0;
  const read = policy.singleFlight(async () => { reads++; });
  const stop = policy.observeFinancialRefresh(read, browser.environment, { chain: 'solana' });
  await browser.advance(0); assert.equal(reads, 1);
  await browser.advance(86_400_000); assert.equal(reads, 1);
  browser.balance('evm'); await browser.drain(); assert.equal(reads, 1);
  browser.balance('solana'); await browser.drain(); assert.equal(reads, 2);
  browser.visible(false); browser.balance('solana'); await browser.advance(86_400_000); assert.equal(reads, 2);
  browser.visible(true); await browser.drain(); assert.equal(reads, 3);
  await read(); assert.equal(reads, 4, 'an explicit control remains usable without any polling clock');
  stop(); browser.balance('solana'); await browser.advance(86_400_000); assert.equal(reads, 4);
});

test('a hidden initial view makes no reads until it becomes visible', async () => {
  const browser = clock(); browser.visible(false); let reads = 0;
  const stop = policy.observeFinancialRefresh(async () => { reads++; }, browser.environment, {});
  await browser.advance(86_400_000); assert.equal(reads, 0);
  browser.visible(true); await browser.drain(); assert.equal(reads, 1);
  stop();
});

test('saved signed recovery is bounded, pauses when hidden, and never replenishes its allowance on return', async () => {
  const browser = clock(); let checks = 0;
  const saved = Object.freeze({ operationId: 'existing-operation', signedBytes: 'same-signed-bytes' });
  const remaining = { remaining: policy.FINANCIAL_RECOVERY_CHECKS };
  const seen: unknown[] = [];
  const read = policy.singleFlight(async () => { checks++; seen.push(saved); });
  let stop = policy.observeFinancialRefresh(read, browser.environment, { recovery: remaining, initial: false });
  await browser.advance(4000); assert.equal(checks, 1);
  browser.visible(false); await browser.advance(86_400_000); assert.equal(checks, 1);
  stop();
  // Reselecting an already-mounted section keeps the same operation allowance.
  stop = policy.observeFinancialRefresh(read, browser.environment, { recovery: remaining, initial: false });
  browser.visible(true); await browser.drain(); assert.equal(checks, 2);
  await browser.advance(86_400_000);
  assert.equal(checks, policy.FINANCIAL_RECOVERY_CHECKS + 1, '15 automatic checks plus the meaningful visible return');
  assert.equal(remaining.remaining, 0); assert.equal(browser.timers.size, 0);
  await read(); assert.equal(checks, policy.FINANCIAL_RECOVERY_CHECKS + 2);
  assert.ok(seen.every(value => value === saved), 'no replacement operation or newly signed payload is created');
  stop();
});

test('failed recovery consumes the finite allowance and leaves explicit checks available', async () => {
  const browser = clock(); let checks = 0;
  const read = policy.singleFlight(async () => { checks++; throw new Error('Unavailable, not a failed receipt'); });
  const stop = policy.observeFinancialRefresh(read, browser.environment, { recovery: { remaining: 15 }, initial: false });
  await browser.advance(86_400_000); assert.equal(checks, 15);
  await assert.rejects(read()); assert.equal(checks, 16);
  stop();
});

test('slow pending reads, event bursts and manual clicks never overlap; changed arguments wait for the old reading', async () => {
  const browser = clock(); let reads = 0;
  const first = Promise.withResolvers<void>();
  const read = policy.singleFlight(async (afterMutation = false) => { reads++; if (!afterMutation) await first.promise; });
  const stop = policy.observeFinancialRefresh(read, browser.environment, { recovery: { remaining: 15 } });
  await browser.advance(0); assert.equal(reads, 1);
  browser.balance('solana'); browser.visible(true); await browser.advance(60_000); assert.equal(reads, 1);
  const manual = read(); const changed = read(true);
  await browser.drain(); assert.equal(reads, 1);
  first.resolve(); await manual; await changed;
  assert.equal(reads, 2, 'mutation refresh follows the old read instead of joining a superseded snapshot');
  stop();
});

type HookEffect = { dependencies: unknown[]; cleanup?: () => void };

/** Exercise the real hook's visibility/section/disclosure wiring with deterministic effect slots. */
function mountHook(browser: { document: EventTarget & { visibilityState: string }; window: EventTarget & { setTimeout: (run: () => void, delay: number) => number; clearTimeout: (key: number) => void } }, selected: boolean, disclosed: boolean) {
  const references: { current: unknown }[] = [];
  const states: unknown[] = [];
  const effects: HookEffect[] = [];
  const layouts: HookEffect[] = [];
  let referenceIndex = 0, stateIndex = 0, effectIndex = 0, layoutIndex = 0;
  const apply = (slots: HookEffect[], index: number, effect: () => void | (() => void), dependencies: unknown[]) => {
    const previous = slots[index];
    if (previous && previous.dependencies.length === dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    previous?.cleanup?.();
    slots[index] = { dependencies, cleanup: effect() || undefined };
  };
  const react = {
    useRef: (value: unknown) => references[referenceIndex++] ?? (references[referenceIndex - 1] = { current: value }),
    useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    },
    useLayoutEffect: (effect: () => void | (() => void), dependencies: unknown[]) => apply(layouts, layoutIndex++, effect, dependencies),
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => apply(effects, effectIndex++, effect, dependencies),
  };
  const source = readFileSync(new URL('./use-financial-refresh.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loaded = { exports: {} as typeof Hooks };
  const dependencies: Record<string, unknown> = { react, './financial-refresh': policy, './section-tabs': { useSectionTabActive: () => selected }, './blocks': { useDisclosureActive: () => disclosed } };
  runInThisContext(`(function(require, module, exports, window, document) { ${compiled.outputText}\n})`)(
    (id: string) => { assert.ok(id in dependencies); return dependencies[id]; }, loaded, loaded.exports, browser.window, browser.document);
  return {
    ...loaded.exports,
    render: (read: () => Promise<unknown>, options: { identity?: string; pendingKey?: string; initial?: boolean; enabled?: boolean } = {}) => {
      referenceIndex = 0; stateIndex = 0; effectIndex = 0; layoutIndex = 0;
      loaded.exports.useFinancialRefresh(read, options);
    },
    select: (nextSelected: boolean, nextDisclosed = true) => { selected = nextSelected; disclosed = nextDisclosed; },
    stop: () => { layouts.forEach(effect => effect.cleanup?.()); effects.forEach(effect => effect.cleanup?.()); },
  };
}

for (const [selected, disclosed, enabled] of [[false, true, true], [true, false, true], [true, true, false]] as const) {
  test(`unselected/closed/disabled view suppresses all work (${selected}/${disclosed}/${enabled})`, async () => {
    const browser = clock(); const hooks = mountHook(browser, selected, disclosed); let reads = 0;
    hooks.useFinancialRefresh(async () => { reads++; }, { enabled, pendingKey: 'saved-operation' });
    await browser.advance(86_400_000); browser.balance('solana'); browser.visible(true); await browser.drain();
    assert.equal(reads, 0); assert.equal(browser.timers.size, 0); hooks.stop();
  });
}

test('selected hook refreshes only through initial/return/event and has no display interval', async () => {
  const browser = clock(); const hooks = mountHook(browser, true, true); let reads = 0;
  hooks.useFinancialRefresh(async () => { reads++; }, { chain: 'solana' });
  await browser.advance(0); assert.equal(reads, 1);
  await browser.advance(86_400_000); assert.equal(reads, 1);
  browser.balance('evm'); await browser.drain(); assert.equal(reads, 1);
  browser.balance('solana'); await browser.drain(); assert.equal(reads, 2);
  hooks.stop();
});

test('post-mutation same-argument refreshes queue one fresh successor and await it', async () => {
  const first = Promise.withResolvers<number>();
  const second = Promise.withResolvers<number>();
  let calls = 0;
  const read = policy.singleFlight(() => ++calls === 1 ? first.promise : second.promise);
  const stale = read();
  await Promise.resolve();
  const mutation = read.invalidate();
  const burst = Array.from({ length: 50 }, () => read.invalidate());
  assert.ok(burst.every(promise => promise === mutation));
  assert.equal(calls, 1);
  first.resolve(1); assert.equal(await stale, 1);
  await Promise.resolve(); assert.equal(calls, 2);
  let settled = false; void mutation.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false, 'the action must not finish after only the pre-mutation snapshot');
  second.resolve(2); assert.equal(await mutation, 2);
  assert.deepEqual(await Promise.all(burst), Array(50).fill(2));
  assert.equal(calls, 2);
});

test('balance/return invalidation during a display read yields one non-overlapping trailing read', async () => {
  const browser = clock(); const first = Promise.withResolvers<void>(); let calls = 0;
  const stop = policy.observeFinancialRefresh(async () => { if (++calls === 1) await first.promise; }, browser.environment, { chain: 'solana' });
  await browser.advance(0);
  for (let index = 0; index < 50; index++) browser.balance('solana');
  browser.visible(true);
  await browser.drain(); assert.equal(calls, 1);
  first.resolve(); await browser.drain(); await browser.advance(0);
  assert.equal(calls, 2);
  await browser.advance(86_400_000); assert.equal(calls, 2);
  stop();
});

test('dirty trailing display work is suppressed when the view becomes hidden or is disposed', async () => {
  for (const disposed of [false, true]) {
    const browser = clock(); const first = Promise.withResolvers<void>(); let calls = 0;
    const stop = policy.observeFinancialRefresh(async () => { calls++; await first.promise; }, browser.environment, {});
    await browser.advance(0); browser.balance('solana');
    if (disposed) stop(); else browser.visible(false);
    first.resolve(); await browser.drain(); await browser.advance(86_400_000);
    assert.equal(calls, 1);
    if (!disposed) { browser.visible(true); await browser.drain(); assert.equal(calls, 2); stop(); }
  }
});

test('rerendered connector identity starts the current callback after the obsolete read without overlap', async () => {
  const browser = clock(); const hooks = mountHook(browser, true, true);
  const old = Promise.withResolvers<void>(); const seen: string[] = [];
  hooks.render(async () => { seen.push('disconnected'); await old.promise; }, { identity: 'disconnected' });
  await browser.advance(0);
  hooks.render(async () => { seen.push('connected'); }, { identity: 'connected' });
  await browser.advance(0); assert.deepEqual(seen, ['disconnected']);
  old.resolve(); await browser.drain();
  assert.deepEqual(seen, ['disconnected', 'connected']);
  await browser.advance(86_400_000); assert.equal(seen.length, 2);
  hooks.stop();
});

test('rerendering the same pending identity preserves its allowance through receipt discovery and view returns', async () => {
  const browser = clock(); const hooks = mountHook(browser, true, true); let checks = 0;
  const check = async () => { checks++; };
  hooks.render(check, { pendingKey: 'saved-operation', initial: false });
  await browser.advance(0); await browser.advance(10 * 4000);
  assert.equal(checks, 11, 'one activation plus ten timed checks');
  // A receipt signature is new evidence, not a new operation or a new allowance.
  hooks.render(async () => { checks++; }, { pendingKey: 'saved-operation', initial: false });
  await browser.advance(86_400_000); assert.equal(checks, 16);
  hooks.select(false); hooks.render(check, { pendingKey: 'saved-operation', initial: false });
  hooks.select(true); hooks.render(check, { pendingKey: 'saved-operation', initial: false });
  await browser.advance(0); assert.equal(checks, 17, 'return gets one explicit read');
  await browser.advance(86_400_000); assert.equal(checks, 17, 'return does not replenish timed checks');
  hooks.stop();
});

test('pending completion balance events do not create a self-sustaining recovery loop', async () => {
  const browser = clock(); let checks = 0;
  const stop = policy.observeFinancialRefresh(async () => { checks++; browser.balance('solana'); }, browser.environment, { recovery: { remaining: 15 } });
  await browser.advance(86_400_000);
  assert.equal(checks, 16); assert.equal(browser.timers.size, 0);
  stop();
});

test('lazy holdings Buy disclosure keeps the full-width desktop and narrow-screen layout selectors', () => {
  const css = readFileSync(new URL('./money-area.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.holding-row > .more-row[open] { grid-column: 1 / -1; }'));
  assert.ok(css.includes('@media (max-width: 560px) { .holding-row { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; } .holding-row > button, .holding-row > .more-row { grid-column: 1 / -1; justify-self: start; } }'));
  assert.doesNotMatch(css, /holding-buy/);
});

test('the actual UI serialized hook refreshes after same-argument manual or mutation demand', async () => {
  const browser = clock(); const hooks = mountHook(browser, true, true);
  const old = Promise.withResolvers<string>(); let reads = 0;
  const refresh = hooks.useSerializedRead(async () => ++reads === 1 ? await old.promise : 'after-mutation');
  const initial = refresh(); await browser.drain();
  const demanded = refresh(); const duplicate = refresh();
  assert.equal(demanded, duplicate); assert.equal(reads, 1);
  old.resolve('before-mutation'); assert.equal(await initial, 'before-mutation');
  assert.equal(await demanded, 'after-mutation'); assert.equal(reads, 2);
  hooks.stop();
});

for (const deactivate of ['hidden', 'unselected', 'closed', 'disabled', 'unmounted'] as const) {
  test(`queued identity successor cannot start after becoming ${deactivate}`, async () => {
    const browser = clock(); const hooks = mountHook(browser, true, true);
    const old = Promise.withResolvers<void>(); const seen: string[] = [];
    const current = async () => { seen.push('current'); };
    hooks.render(async () => { seen.push('obsolete'); await old.promise; }, { identity: 'disconnected' });
    await browser.advance(0);
    hooks.render(current, { identity: 'connected' });
    await browser.advance(0); assert.deepEqual(seen, ['obsolete']);
    if (deactivate === 'hidden') browser.visible(false);
    else if (deactivate === 'unmounted') hooks.stop();
    else {
      if (deactivate === 'unselected') hooks.select(false);
      if (deactivate === 'closed') hooks.select(true, false);
      hooks.render(current, { identity: 'connected', enabled: deactivate !== 'disabled' });
    }
    old.resolve(); await browser.drain(); await browser.advance(86_400_000);
    assert.deepEqual(seen, ['obsolete'], 'the serializer successor must recheck current activity before calling its reader');
    if (deactivate === 'unmounted') {
      const reopened = mountHook(browser, true, true);
      reopened.render(current, { identity: 'connected' });
      await browser.advance(0); reopened.stop();
    } else if (deactivate === 'hidden') {
      browser.visible(true); await browser.drain();
    } else {
      hooks.select(true);
      hooks.render(current, { identity: 'connected', enabled: true });
      await browser.advance(0);
    }
    assert.deepEqual(seen, ['obsolete', 'current']);
    hooks.stop();
  });
}

for (const deactivate of ['hidden', 'unselected', 'closed', 'disabled', 'unmounted'] as const) {
  test(`automatic demand in the caller's inner queue cannot launch after becoming ${deactivate}`, async () => {
    const browser = clock();
    const owner = mountHook(browser, true, true), observer = mountHook(browser, true, true);
    const held = Promise.withResolvers<void>(); let networkReads = 0;
    const refresh = owner.useSerializedRead(async () => { if (++networkReads === 2) await held.promise; });
    observer.render(refresh);
    await browser.advance(0); assert.equal(networkReads, 1);
    const manual = refresh(); await browser.drain(); assert.equal(networkReads, 2);
    browser.balance('solana'); await browser.drain();
    assert.equal(networkReads, 2, 'automatic invalidation waits in the already-busy caller serializer');
    if (deactivate === 'hidden') browser.visible(false);
    else if (deactivate === 'unmounted') observer.stop();
    else {
      if (deactivate === 'unselected') observer.select(false);
      if (deactivate === 'closed') observer.select(true, false);
      observer.render(refresh, { enabled: deactivate !== 'disabled' });
    }
    held.resolve(); await manual; await browser.drain(); await browser.advance(86_400_000);
    assert.equal(networkReads, 2, 'the inner network-launch queue must enforce automatic eligibility');
    if (deactivate === 'unmounted') {
      const reopened = mountHook(browser, true, true);
      reopened.render(refresh); await browser.advance(0); reopened.stop();
    } else if (deactivate === 'hidden') {
      browser.visible(true); await browser.drain();
    } else {
      observer.select(true); observer.render(refresh, { enabled: true }); await browser.advance(0);
    }
    assert.equal(networkReads, 3, 'reactivation requests one new reading');
    observer.stop(); owner.stop();
  });
}

test('explicit mutation completion promotes an automatic queued successor and is not cancelled on deactivation', async () => {
  const browser = clock();
  const owner = mountHook(browser, true, true), observer = mountHook(browser, true, true);
  const held = Promise.withResolvers<void>(); let networkReads = 0;
  const refresh = owner.useSerializedRead(async () => { if (++networkReads === 2) await held.promise; });
  observer.render(refresh); await browser.advance(0);
  const predecessor = refresh(); await browser.drain();
  browser.balance('solana'); await browser.drain();
  // The same queued successor now also owes a fresh snapshot to an explicit completed action.
  const mutation = refresh();
  browser.visible(false); observer.stop();
  held.resolve(); await predecessor; await mutation; await browser.drain();
  assert.equal(networkReads, 3, 'explicit post-mutation work survives an earlier automatic demand becoming inactive');
  await browser.advance(86_400_000); assert.equal(networkReads, 3);
  owner.stop();
});
