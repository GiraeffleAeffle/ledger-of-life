import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInThisContext } from 'node:vm';
import React, { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as buildingRead from './building-read.ts';
import * as buildingLogic from './building-panel-logic.ts';
import * as projects from '../data/local-investments.ts';
import * as moneyGuidance from './money-guidance.ts';
import type * as BlocksModule from './blocks';
import type * as BuildingModule from './building-panel';
import type * as LocalInvestmentsModule from './local-investments';
import type * as MoneyModule from './money-area';
import type * as HomeModule from './home';
import * as homeLogic from './home-journey-logic.ts';
import * as nextStepLogic from './next-step.ts';
import type { AuthorizedRequest } from './use-city-signals';

const requirePackage = createRequire(import.meta.url);
// The application test runner strips TS but not TSX/CSS. Compile just the view under
// test, keeping real React and shared layout blocks; replace browser-only services.
function loadView<T>(file: string, dependencies: Record<string, unknown>, browserWindow?: unknown, expose: string[] = []): T {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8') + (expose.length ? `\nexport { ${expose.join(', ')} };` : '');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const loaded = { exports: {} };
  const load = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id in dependencies) return dependencies[id];
    if (['react', 'react/jsx-runtime', 'lucide-react', 'viem'].includes(id)) return requirePackage(id);
    throw new Error(`Unexpected view dependency: ${id}`);
  };
  runInThisContext(`(function(require, module, exports, window) { ${compiled.outputText}\n})`, { filename: file })(load, loaded, loaded.exports, browserWindow);
  return loaded.exports as T;
}

const blocks = loadView<typeof BlocksModule>('./blocks.tsx', {});
const wallet = { wallets: [{ chainType: 'ethereum', address: '0xowner', connected: true }, { chainType: 'solana', address: 'solana-owner', connected: true }] };
const shared = {
  '@/wallets': { useRentalWallet: () => wallet },
  './section-tabs': { useSectionTabActive: () => true },
  './blocks': blocks,
  './building-read': buildingRead,
  // Effects do not run in these render/callback tests; real scheduling is covered separately.
  './use-financial-refresh': { useFinancialRefresh: () => {}, useSerializedRead: <T,>(read: T) => read },
};
const building = loadView<typeof BuildingModule>('./building-panel.tsx', {
  ...shared, './building-panel-logic': buildingLogic, './money-valuation': { usd: (value: number) => `$${value}` },
});
const neverRequest = async <T,>(): Promise<T> => { throw new Error('Rendering must not submit or read a transaction'); };
const map = createElement('div', { 'aria-label': 'Illustrative project map' }, 'Illustrative map');

for (const network of ['robinhood', 'solana']) {
  test(`${network} unavailable card retains one hero, map, tools and honest unknown amounts`, () => {
    const view = network === 'solana'
      ? createElement(building.SolanaBuildingPanel, { request: neverRequest, houseId: 'neighbourhood-homes', visual: map, initialUnavailable: true })
      : createElement(building.BuildingPanel, { request: neverRequest, position: null, setPosition: () => {}, visual: map, initialUnavailable: true });
    const html = renderToStaticMarkup(view);
    assert.equal(html.split(buildingRead.BUILDING_RPC_UNAVAILABLE).length - 1, 1);
    assert.match(html, /cannot be verified right now/);
    assert.match(html, /Illustrative project map/);
    assert.equal((html.match(/class="hero-card/g) ?? []).length, 1);
    assert.match(html, /Stake or unstake/);
    assert.match(html, /Where the income comes from/);
    assert.match(html, /disabled=""[^>]*>Claim/);
    assert.doesNotMatch(html, /You hold no|No confirmed building income|No signed house receipts|\$0\.00/);
  });
}

test('a building outage cannot hide a previously signed pending Robinhood operation', () => {
  const html = renderToStaticMarkup(createElement(building.BuildingPanel, {
    request: neverRequest, visual: map, initialUnavailable: true, setPosition: () => {},
    position: { configured: true, account: '0xowner', walletUnitsRaw: null, stakedRaw: null, earnedRaw: null, allowanceRaw: null,
      receipts: [{ operation: 'stake', quantityRaw: '1000000000000000000', hash: 'saved-signed-hash', status: 'pending' }] },
  }));
  assert.match(html, /A signed building transaction is pending/);
  assert.match(html, /Wait for its verified receipt before another action/);
  assert.match(html, /Pending · receipts/);
  assert.match(html, /Testnetz-RPC derzeit nicht erreichbar/);
});

for (const source of ['saved receipts', 'just-submitted transaction'] as const) {
test(`a building outage preserves Solana ${source} independently of public income`, () => {
  const savedPosition = { configured: true, account: 'solana-owner', walletUnitsRaw: null, stakedRaw: null, earnedRaw: null, allowanceRaw: null, cashAtomic: '1000000', plan: null, activeOperation: null,
    receipts: [{ operation: 'stake', quantityRaw: '1000000', hash: 'saved-solana-signature', status: 'pending', explorerUrl: 'https://explorer.solana.com/tx/saved-solana-signature?cluster=devnet' }] };
  let nullStates = 0;
  const pendingState = source === 'saved receipts' ? savedPosition : { id: 'submitted-operation', state: 'broadcast', signature: 'saved-solana-signature' };
  const stateIndex = source === 'saved receipts' ? 2 : 4;
  const stateReact = { ...React, useState: ((initial: unknown) => React.useState(initial === null && ++nullStates === stateIndex ? pendingState : initial)) as typeof React.useState };
  const { SolanaBuildingPanel } = loadView<typeof BuildingModule>('./building-panel.tsx', {
    ...shared, react: stateReact, './building-panel-logic': buildingLogic, './money-valuation': { usd: (value: number) => `$${value}` },
  });
  const html = renderToStaticMarkup(createElement(SolanaBuildingPanel, { request: neverRequest, houseId: 'neighbourhood-homes', visual: map, initialUnavailable: true }));
  assert.match(html, /Your signed transaction awaits a verified finalized receipt/);
  assert.match(html, /Do not start a replacement action/);
  assert.match(html, /Pending · receipts/);
  assert.match(html, /disabled=""[^>]*>Claim/);
  if (source === 'just-submitted transaction') assert.match(html, /View submitted transaction/);
});
}

function localView(network: 'checking' | 'unavailable' | 'localnet') {
  // Render each settled routing state without running browser effects or RPCs.
  const stateReact = { ...React, useState: ((initial: unknown) => React.useState(initial === 'checking' ? network : initial)) as typeof React.useState };
  return loadView<typeof LocalInvestmentsModule>('./local-investments.tsx', {
    ...shared, react: stateReact,
    '@/domain/assets': { parseAmount: () => '5000000' },
    '@/data/local-investments': projects,
    './areas': { LOCAL_INVESTMENT_NAVIGATION_INTENT: 'local-stakes', openInvestmentOnMap: () => {} },
    './use-city-signals': { CITY_CHANGED_EVENT: 'city-changed', readPersonCity: neverRequest },
    './money-guidance': moneyGuidance,
    './city-flywheel': { ProjectBlueprint: () => createElement('p', null, 'Illustrative building context') },
    './agri-pv-example': { AgriPvExample: () => createElement('p', null, 'Illustrative Agri-PV') },
    './project-map': { ProjectMap: () => map },
    './project-map-model': { DEFAULT_PROJECT_SYSTEMS: {} },
    './test-dollars': { TestDollars: () => null },
    './building-panel': building,
  });
}

for (const network of ['checking', 'unavailable', 'localnet'] as const) {
  test(`${network} routing keeps the project picker, map and contextual rows usable`, () => {
    const { LocalInvestments } = localView(network);
    const html = renderToStaticMarkup(createElement(LocalInvestments, { request: neverRequest, go: () => {} }));
    assert.match(html, /Choose a fictional local project/);
    assert.match(html, />House<.*>Workshop<.*>Agri-PV</);
    assert.match(html, /Illustrative project map/);
    assert.match(html, /Explore the building idea/);
    assert.match(html, /Sources &amp; token rights/);
    assert.match(html, /Robinhood Chain test house · earlier units/);
    assert.equal((html.match(/class="hero-card/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Review purchase|You hold no|\$0\.00/);
    if (network === 'unavailable') assert.match(html, /Testnetz-RPC derzeit nicht erreichbar/);
    if (network === 'localnet') assert.match(html, /Solana localnet · read-only/);
  });
}

test('Money keeps independent healthy sections and navigation through the building outage', () => {
  const { LocalInvestments } = localView('unavailable');
  const { MoneyArea } = loadView<typeof MoneyModule>('./money-area.tsx', {
    ...shared,
    './section-tabs': { useSectionTabActive: () => true, SectionTabs: ({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) => createElement('div', null,
      createElement('nav', null, tabs.map(tab => createElement('button', { key: tab.id }, tab.label))),
      tabs.map(tab => createElement('section', { key: tab.id }, tab.content))) },
    './assets': { AssetsOverview: () => createElement('p', null, 'Healthy holdings content') },
    './device-readings': { DeviceReadings: () => createElement('p', null, 'Healthy device readings') },
    './home-node': { HomeNode: () => null },
    './share-workflows': { ShareWorkflows: () => createElement('p', null, 'Healthy lending content') },
    './local-investments': { LocalInvestments },
    './local-ai': { LocalAiWorkspace: () => null },
    './test-dollars': { TestDollars: () => null },
  });
  const html = renderToStaticMarkup(createElement(MoneyArea, { request: neverRequest, tenancies: [], loaded: true, homeError: '', retryHome: neverRequest, go: () => {} }));
  assert.match(html, /Healthy holdings content/);
  assert.match(html, /Healthy lending content/);
  assert.match(html, /Healthy device readings/);
  assert.match(html, /Local stakes/);
  assert.match(html, /Testnetz-RPC derzeit nicht erreichbar/);
});

for (const network of ['robinhood', 'solana'] as const) {
  for (const state of ['fresh', 'stale', 'expired'] as const) {
    test(`${network} ${state} public income is bounded and only fresh data permits a new claim`, () => {
      const cache = { state: state === 'expired' ? 'stale' : state, checkedAt: '2026-10-12T12:00:00.000Z', ageMs: state === 'fresh' ? 10_000 : state === 'stale' ? 120_000 : 900_000 };
      const snapshot = { configured: true, revenueRaw: '1500000', totalStakedRaw: '1000000', priceAtomic: '1000000', sellCapUnitsRaw: '100000000', deskCashAtomic: '100000000', stakerCount: 1,
        observedSlot: '1234', payingDevices: [], incomeSources: [], revenueTransactions: [], paidAnswers: 1, gpuTokensServed: 1, explorerUrl: 'https://explorer.testnet.chain.robinhood.com' };
      const own = { configured: true, account: network === 'solana' ? 'solana-owner' : '0xowner', walletUnitsRaw: '2000000', stakedRaw: '1000000', earnedRaw: '2000000', allowanceRaw: '0', cashAtomic: '10000000', plan: null, activeOperation: null, receipts: [] };
      let nullStates = 0;
      const stateReact = { ...React, useState: ((initial: unknown) => {
        const value = initial === undefined ? cache : initial === null
          ? ++nullStates === 1 ? snapshot : network === 'solana' && nullStates === 2 ? own : initial
          : initial;
        return React.useState(value);
      }) as typeof React.useState };
      const panels = loadView<typeof BuildingModule>('./building-panel.tsx', {
        ...shared, react: stateReact, './building-panel-logic': buildingLogic, './money-valuation': { usd: (value: number) => `$${value}` },
      });
      const view = network === 'solana'
        ? createElement(panels.SolanaBuildingPanel, { request: neverRequest, houseId: 'neighbourhood-homes', visual: map })
        : createElement(panels.BuildingPanel, { request: neverRequest, position: own, setPosition: () => {}, visual: map });
      const html = renderToStaticMarkup(view);
      if (state === 'expired') {
        assert.match(html, /Public income snapshot expired/);
        assert.doesNotMatch(html, /1\.5|datetime="2026-10-12T12:00:00.000Z"/i);
      } else {
        assert.match(html, /datetime="2026-10-12T12:00:00.000Z"/i);
        assert.match(html, /1\.5/);
      }
      const claim = html.match(/<button[^>]*>Claim<\/button>/)?.[0];
      assert.ok(claim);
      assert.equal(claim.includes('disabled='), state !== 'fresh');
      if (state !== 'fresh') {
        const refresh = html.match(/<button[^>]*>Refresh public income and balances for a fresh review<\/button>/)?.[0];
        assert.ok(refresh, 'stopping display polling must leave an immediately reachable freshness control');
        assert.equal(refresh.includes('disabled='), false);
      }
      if (state === 'stale') {
        assert.match(html, /Saved reading, not current/);
        assert.match(html, /Refreshing or temporarily unavailable/);
        assert.match(html, /new financial actions are paused/);
        assert.doesNotMatch(html, /Testnetz-RPC derzeit nicht erreichbar/);
      } else if (state === 'fresh') assert.match(html, /Cached for up to 60 seconds/);
    });
  }
}

test('Home keeps browsing and contextual rows visible while its first tenancy read is pending', () => {
  const unused = Object.fromEntries([
    './ideas', './me', './money-area', '@/finance/solana/manifest', './onboarding', './places',
    './service-charges', '@/domain/assets', './workspace-panels', './deposit-activity', './next-step-card',
    './deposit-yield', './flat-map', './move-in-handover', '@/domain/home-location', './share-deposit',
    './share-deposit-application', './share-deposit-logic', '../../contracts/evm/deployments/share-deposit-46630.json',
    '@/domain/deposit-form', '@/domain/rent', './project-map', './project-map-model',
  ].map(id => [id, {}]));
  const { MyHome } = loadView<typeof HomeModule>('./home.tsx', {
    ...unused, ...shared,
    '@/wallets': { useRentalWallet: () => ({ ...wallet, ready: true, authenticated: true, subject: 'account', passkeyCount: 1, getAccessToken: neverRequest }) },
    './authorized-request': { authorizedRequest: neverRequest },
    './areas': { AREAS: [{ id: 'home', label: 'Home' }] },
    './account-setup-state': { accountSetupStep: () => 'done' },
    './area-skeleton': { AreaSkeleton: () => createElement('p', null, 'Whole-area skeleton') },
    './use-city-signals': { CITY_CHANGED_EVENT: 'city-changed' },
    './tenancy-walkthrough': { DepositIdeas: () => createElement('p', null, 'Deposit context') },
    './home-journey-logic': homeLogic, './next-step': nextStepLogic, '@/data/local-investments': projects,
  });
  const html = renderToStaticMarkup(createElement(MyHome, { area: 'home', go: () => {} }));
  assert.match(html, /Checking your homes/);
  assert.match(html, /Browse other homes/);
  assert.match(html, /How the deposit works/);
  assert.match(html, /Rent out a home/);
  assert.doesNotMatch(html, /class="area-content" hidden|Whole-area skeleton/);
});

// Execute view-owned callbacks with fixed hook snapshots. This exercises the actual
// submit/refresh handlers without mounting browser services or making network calls.
function buildingCallbacks(stateOverrides: Record<number, unknown>, refOverrides: Record<number, unknown>) {
  const states = new Map<number, unknown>();
  const callbacks: (() => unknown)[] = [];
  const refreshes: { read: () => Promise<unknown>; options: { pendingKey?: string | null } }[] = [];
  let stateIndex = 0, refIndex = 0;
  const hooks = {
    ...React,
    useState: ((initial?: unknown) => {
      const index = stateIndex++;
      const value = index in stateOverrides ? stateOverrides[index] : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      states.set(index, value);
      return [value, (next: unknown) => { states.set(index, typeof next === 'function' ? (next as (current: unknown) => unknown)(states.get(index)) : next); }];
    }) as typeof React.useState,
    useRef: ((initial: unknown) => { const index = refIndex++; return { current: index in refOverrides ? refOverrides[index] : initial }; }) as typeof React.useRef,
    useCallback: ((callback: () => unknown) => { callbacks.push(callback); return callback; }) as typeof React.useCallback,
    useEffect: () => {},
  };
  const panels = loadView<typeof BuildingModule>('./building-panel.tsx', {
    ...shared, react: hooks, './building-panel-logic': buildingLogic, './money-valuation': { usd: (value: number) => `$${value}` },
    '@/wallets': { useRentalWallet: () => ({ ...wallet, signEvmTransaction: neverRequest, signSolanaTransaction: neverRequest }) },
    './use-financial-refresh': { useFinancialRefresh: (read: () => Promise<unknown>, options: { pendingKey?: string | null }) => { refreshes.push({ read, options }); }, useSerializedRead: <T,>(read: T) => read },
  }, { dispatchEvent: () => true });
  return { panels, states, callbacks, refreshes };
}

type TestButton = React.ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>;
function viewButtons(node: ReactNode): TestButton[] {
  const buttons: TestButton[] = [];
  React.Children.forEach(node, child => {
    if (!React.isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === 'button') buttons.push(child);
    buttons.push(...viewButtons(child.props.children));
  });
  return buttons;
}

for (const kind of ['robinhood', 'solana', 'reinvest'] as const) {
  for (const condition of ['unavailable', 'stale'] as const) {
  test(`${kind} retries only stored signed bytes with ${condition} reads`, { timeout: 5000 }, async () => {
    const request = { walletId: 'wallet', description: 'Exact saved review', transaction: { to: 'recipient', value: '0', nonce: 1, gasLimit: '1', maxFeePerGas: '1' } };
    const plan = { id: 'saved-plan', request, walletId: 'wallet', feePayer: 'sponsor', expiresAt: '2026-10-12T12:00:00Z', lastValidBlockHeight: '1234',
      review: { operation: 'claim', amount: '2', asset: 'tUSDG', network: 'solana-devnet', description: 'Exact saved review', distributor: 'house', account: 'solana-owner' } };
    const reinvest = { phase: 'claim', account: '0xowner', pending: false, request, stepId: 'saved-step', receipts: [] };
    // State slots follow the component's declared hooks; reference slots hold the
    // immutable signed bytes and mark a display read in flight to avoid a second read.
    const failed = condition === 'unavailable';
    const cache = condition === 'stale' ? { state: 'stale', checkedAt: '2026-10-12T12:00:00Z', ageMs: 120_000 } : undefined;
    const overrides = kind === 'solana' ? { 2: plan, 6: failed, 7: failed, 10: true, 12: cache }
      : kind === 'robinhood' ? { 1: plan, 4: cache, 8: failed, 9: failed, 12: true } : { 4: cache, 8: failed, 9: failed, 13: true };
    const refs = kind === 'solana' ? { 0: true, 1: true, 4: { id: 'saved-plan', bytes: 'exact-stored-bytes' } }
      : kind === 'robinhood' ? { 2: true, 4: { planId: 'saved-plan', bytes: 'exact-stored-bytes' } } : { 2: true, 5: { stepId: 'saved-step', bytes: 'exact-stored-bytes' } };
    const { panels } = buildingCallbacks(overrides, refs);
    const submitted = Promise.withResolvers<unknown>();
    const calls: unknown[] = [];
    const send = async <T,>(_path: string, body?: unknown): Promise<T> => {
      calls.push(body); submitted.resolve(body);
      return { id: 'saved-plan', state: 'broadcast', hash: 'hash', status: 'pending', reinvest } as T;
    };
    const tree = kind === 'solana'
      ? panels.SolanaBuildingPanel({ request: send, houseId: 'neighbourhood-homes', visual: null })
      : panels.BuildingPanel({ request: send, visual: null, setPosition: () => {}, position: kind === 'reinvest' ? { configured: true, account: '0xowner', walletUnitsRaw: null, stakedRaw: null, earnedRaw: null, allowanceRaw: null, reinvest } as unknown as BuildingModule.BuildingPosition : null });
    const button = viewButtons(tree).find(item => typeof item.props.children === 'string' && item.props.children.startsWith('Retry'));
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    button.props.onClick?.();
    const body = await submitted.promise;
    assert.deepEqual(body, kind === 'reinvest' ? { action: 'reinvest_submit', stepId: 'saved-step', signedTransaction: 'exact-stored-bytes' }
      : { action: 'submit', planId: 'saved-plan', signedTransaction: 'exact-stored-bytes' });
    assert.equal(calls.length, 1, 'No new prepare, replacement intent or wallet signature is requested');
  });
  }
}

test('a healthy independent refresh clears a transient Robinhood action error', async context => {
  const { panels, states, callbacks } = buildingCallbacks({ 7: 'A previous prepare request failed' }, {});
  context.mock.method(globalThis, 'fetch', async () => Response.json({ network: 'robinhood-testnet', building: { configured: true },
    cache: { state: 'fresh', checkedAt: '2026-10-12T12:00:00Z', ageMs: 0 } }));
  const request = async <T,>(_path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
    assert.equal(body, undefined); assert.ok(options?.signal instanceof AbortSignal);
    return { configured: true, account: '0xowner' } as T;
  };
  panels.BuildingPanel({ request, position: null, setPosition: () => {}, visual: null });
  assert.equal(states.get(7), 'A previous prepare request failed');
  await callbacks[1]();
  assert.equal(states.get(7), '');
});

for (const network of ['robinhood', 'solana'] as const) {
  for (const state of ['stale', 'expired'] as const) {
    test(`${network} ${state} snapshot refresh control actually requests a new public and wallet reading`, async context => {
      const cache = { state: 'stale', checkedAt: '2026-10-12T12:00:00Z', ageMs: state === 'stale' ? 120_000 : 900_000 };
      const { panels } = buildingCallbacks(network === 'solana' ? { 12: cache } : { 4: cache }, network === 'solana' ? { 0: true } : {});
      let publicReads = 0, privateReads = 0;
      const read = Promise.withResolvers<void>();
      context.mock.method(globalThis, 'fetch', async () => {
        publicReads++;
        return Response.json({ network: network === 'solana' ? 'solana-devnet' : 'robinhood-testnet', building: { configured: true },
          cache: { state: 'fresh', checkedAt: '2026-10-12T12:00:00Z', ageMs: 0 } });
      });
      const request = async <T,>(): Promise<T> => { privateReads++; read.resolve(); return { configured: true, receipts: [], plan: null } as T; };
      const tree = network === 'solana'
        ? panels.SolanaBuildingPanel({ request, houseId: 'neighbourhood-homes', visual: null })
        : panels.BuildingPanel({ request, position: null, setPosition: () => {}, visual: null });
      const button = viewButtons(tree).find(item => item.props.children === 'Refresh public income and balances for a fresh review');
      assert.ok(button); assert.equal(button.props.disabled, false);
      button.props.onClick?.(); await read.promise;
      assert.equal(publicReads, 1); assert.equal(privateReads, 1);
    });
  }
}

test('pending Solana house recovery reads only the private saved operation while public income is unavailable', async context => {
  const position = { configured: true, account: 'solana-owner', cashAtomic: '0', receipts: [{ hash: 'saved-signature', status: 'pending' }], plan: null,
    activeOperation: { id: 'saved-operation', state: 'broadcast', signature: 'saved-signature', operation: 'buy' } };
  const { panels, refreshes } = buildingCallbacks({ 1: position, 6: true }, { 0: true });
  context.mock.method(globalThis, 'fetch', neverRequest);
  const calls: string[] = [];
  const request = async <T,>(path: string, body?: unknown): Promise<T> => {
    assert.equal(body, undefined, 'receipt checking must not prepare, sign, or replace an operation');
    calls.push(path); return position as T;
  };
  panels.SolanaBuildingPanel({ request, houseId: 'neighbourhood-homes', visual: null });
  const recovery = refreshes.find(item => item.options.pendingKey === 'saved-operation');
  assert.ok(recovery);
  await recovery.read();
  assert.deepEqual(calls, ['/api/building/claims?houseId=neighbourhood-homes']);
});

test('learning a Solana house receipt signature does not change the submitted operation recovery identity', () => {
  const submitted = { id: 'saved-operation', state: 'broadcast' };
  const position = { configured: true, cashAtomic: '0', receipts: [{ hash: 'learned-signature', status: 'pending' }], plan: null,
    activeOperation: { ...submitted, signature: 'learned-signature', operation: 'buy' } };
  const keys: (string | null | undefined)[] = [];
  for (const savedPosition of [null, position]) {
    const { panels, refreshes } = buildingCallbacks({ 1: savedPosition, 7: !savedPosition, 11: submitted }, { 0: true });
    panels.SolanaBuildingPanel({ request: neverRequest, houseId: 'neighbourhood-homes', visual: null });
    keys.push(refreshes[0]?.options.pendingKey);
  }
  assert.deepEqual(keys, ['saved-operation', 'saved-operation']);
});

for (const unavailable of [true, false]) {
  test(`manual saved-purchase recovery survives an ${unavailable ? 'unavailable' : 'initially loading'} portfolio after automatic checks stop`, async () => {
    let displayRefreshes = 0;
    const requested = Promise.withResolvers<void>();
    const actions: unknown[] = [];
    const react = {
      ...React,
      useState: (initial: unknown) => [initial === 'none' ? 'pending' : initial, () => {}],
      useCallback: <T,>(callback: T) => callback,
    };
    const unused = Object.fromEntries(['./device-readings', './home-node', './share-workflows', './local-investments', './local-ai', './test-dollars'].map(id => [id, {}]));
    const { Portfolio } = loadView<{ Portfolio: (props: { request: AuthorizedRequest }) => ReactNode }>('./money-area.tsx', {
      ...unused, ...shared, react,
      './assets': { useHoldingsRead: () => ({ portfolio: { view: null, checkedAt: null, unavailable }, refresh: async () => { displayRefreshes++; } }) },
    }, undefined, ['Portfolio']);
    const request = async <T,>(_path: string, body?: unknown): Promise<T> => {
      actions.push(body); requested.resolve(); return { result: { state: 'pending' } } as T;
    };
    // No effects execute: this also models an exhausted automatic recovery allowance.
    const tree = Portfolio({ request });
    const button = viewButtons(tree).find(item => item.props.children === 'Check the same pending purchase');
    assert.ok(button); assert.equal(button.props.disabled, false); assert.equal(actions.length, 0);
    button.props.onClick?.(); await requested.promise;
    assert.deepEqual(actions, [{ action: 'purchase_status' }]);
    assert.equal(displayRefreshes, 0, 'private saved-operation recovery does not depend on public/display health');
  });
}
