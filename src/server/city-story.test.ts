import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCityStory, receiptUrl, validateCityStory } from './city-story.ts';

const current = loadCityStory();

test('current hosted evidence validates and receipts preserve their network explorer', () => {
  const story = validateCityStory(structuredClone(current));
  for (const step of story.steps) for (const receipt of step.receipts ?? []) {
    const network = story.networks[receipt.network];
    const url = new URL(receiptUrl(network, receipt.hash));
    assert.equal(url.pathname, `/tx/${receipt.hash}`);
    assert.equal(url.hostname, receipt.network === 'solana-devnet' ? 'explorer.solana.com' : 'explorer.testnet.chain.robinhood.com');
    assert.equal(url.search, receipt.network === 'solana-devnet' ? '?cluster=devnet' : '');
  }
});

for (const [label, mutate] of [
  ['unknown kind', (story: typeof current) => { story.steps[0].kind = 'live' as never; }],
  ['unknown actor', (story: typeof current) => { story.steps[0].actor = 'unknown'; }],
  ['unknown receipt network', (story: typeof current) => { story.steps[0].receipts![0].network = 'mainnet'; }],
  ['malformed transaction hash', (story: typeof current) => { story.steps[0].receipts![0].hash = '0x1234'; }],
  ['malformed Robinhood testnet network', (story: typeof current) => { story.networks['robinhood-testnet'].chainId = 1; }],
  ['malformed Solana devnet network', (story: typeof current) => { delete story.networks['solana-devnet'].explorerSuffix; }],
  ['expected a public HTTPS URL', (story: typeof current) => { story.networks['robinhood-testnet'].explorerTx = 'javascript:alert(1)'; }],
  ['duplicate persona', (story: typeof current) => { story.personas.push(story.personas[0]); }],
  ['duplicate step', (story: typeof current) => { story.steps.push(story.steps[0]); }],
  ['invalid test account', (story: typeof current) => { story.personas[0].account = '0x1234'; }],
] as const) test(`rejects ${label}`, () => {
  const story = structuredClone(current);
  mutate(story);
  assert.throws(() => validateCityStory(story), new RegExp(label));
});

test('partial stories and future non-chain steps remain renderable in file order', () => {
  const story = structuredClone(current);
  story.steps = [
    { id: 'job', actor: story.personas[0].id, kind: 'narrative', title: 'A fictional job', summary: 'Fiction, not a recorded job offer.' },
    { id: 'news', actor: story.personas[0].id, kind: 'public-data', title: 'City news', summary: 'Public information.', links: [{ label: 'Welcome', href: '/welcome/strausberg' }] },
    { id: 'agreement', actor: story.personas[0].id, kind: 'app-record', title: 'Agreement', summary: 'Recorded in the app.' },
    { id: 'solar', actor: story.personas[0].id, kind: 'illustrative', title: 'Solar arithmetic', summary: 'Not a forecast.', facts: [{ label: 'Example', value: '10 test units' }] },
  ];
  assert.deepEqual(validateCityStory(story).steps.map((step) => step.id), ['job', 'news', 'agreement', 'solar']);
});

test('Solana signatures cannot be confused with EVM hashes and keep the devnet suffix', () => {
  const story = structuredClone(current);
  const receipt = { network: 'solana-devnet', hash: '2'.repeat(88), label: 'Devnet transaction' };
  story.steps[0].receipts = [receipt];
  validateCityStory(story);
  assert.equal(receiptUrl(story.networks['solana-devnet'], receipt.hash), `https://explorer.solana.com/tx/${receipt.hash}?cluster=devnet`);
  receipt.hash = `0x${'a'.repeat(64)}`;
  assert.throws(() => validateCityStory(story), /malformed transaction hash/);
  receipt.hash = '1'.repeat(88);
  assert.throws(() => validateCityStory(story), /malformed transaction hash/);
  receipt.hash = '1'.repeat(64);
  validateCityStory(story); // Leading zero bytes are valid base58, even with a shorter encoding.
});

test('rejects malformed optional facts and unsafe related links', () => {
  const story = structuredClone(current);
  story.steps[0].links = [{ label: 'Unsafe', href: '//elsewhere.example' }];
  assert.throws(() => validateCityStory(story), /malformed URL/);
  delete story.steps[0].links;
  story.steps[0].facts = [{ label: 'Amount', value: 2 as never }];
  assert.throws(() => validateCityStory(story), /expected non-empty text/);
});
