import evidence from '../../docs/evidence/HOSTED_CITY_STORY_ROBINHOOD_TESTNET_2026-10-02.json' with { type: 'json' };

export type StoryKind = 'recorded' | 'app-record' | 'narrative' | 'public-data' | 'illustrative';
export type StoryFact = { label: string; value: string };
export type StoryNetwork = { name: string; chainId?: number; explorerTx: string; explorerSuffix?: string };
export type StoryPersona = { id: string; name: string; role: string; fictional: true; account?: string; note?: string };
export type StoryReceipt = { network: string; hash: string; label: string };
export type StoryStep = { id: string; actor: string; kind: StoryKind; title: string; summary: string; startedAtUtc?: string; finishedAtUtc?: string; facts?: StoryFact[]; receipts?: StoryReceipt[]; links?: { label: string; href: string }[] };
export type CityStory = { evidenceStatus: string; evidenceScope: string; site: string; networks: Record<string, StoryNetwork>; personas: StoryPersona[]; steps: StoryStep[]; outcome?: { title: string; summary: string; facts?: StoryFact[] } };

const kinds: StoryKind[] = ['recorded', 'app-record', 'narrative', 'public-data', 'illustrative'];
const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const evmHash = /^0x[0-9a-fA-F]{64}$/;
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function validSolanaSignature(hash: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hash)) return false;
  let value = 0n;
  for (const character of hash) value = value * 58n + BigInt(base58Alphabet.indexOf(character));
  const leadingZeros = hash.match(/^1*/)?.[0].length ?? 0;
  const bytes = value === 0n ? 0 : Math.ceil(value.toString(2).length / 8);
  return leadingZeros + bytes === 64;
}

function requireShape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid city story: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  requireShape(value && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  requireShape(typeof value === 'string' && value.trim().length > 0, 'expected non-empty text');
}
function list(value: unknown): unknown[] {
  requireShape(Array.isArray(value), 'expected an array');
  return value;
}
function url(value: unknown) {
  text(value);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid city story: malformed URL'); }
  requireShape(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'expected a public HTTPS URL');
}
function facts(value: unknown) {
  for (const item of list(value)) { const fact = object(item); text(fact.label); text(fact.value); }
}
function identifier(value: unknown): asserts value is string {
  text(value);
  requireShape(/^[a-z0-9][a-z0-9-]*$/.test(value), 'invalid identifier');
}

/** Validate before rendering: broken evidence must fail loudly, including during a static build. */
export function validateCityStory(value: unknown): CityStory {
  const story = object(value);
  text(story.evidenceStatus); text(story.evidenceScope); url(story.site);
  const networks = object(story.networks);
  requireShape(Object.keys(networks).length > 0, 'missing networks');
  for (const [id, item] of Object.entries(networks)) {
    identifier(id);
    const network = object(item);
    text(network.name); url(network.explorerTx);
    if (network.chainId !== undefined) requireShape(Number.isSafeInteger(network.chainId) && Number(network.chainId) > 0, 'invalid chain ID');
    if (id === 'robinhood-testnet') {
      requireShape(network.chainId === 46630 && network.explorerTx === 'https://explorer.testnet.chain.robinhood.com/tx/' && network.explorerSuffix === undefined, 'malformed Robinhood testnet network');
    } else if (id === 'solana-devnet') {
      requireShape(network.chainId === undefined && network.explorerTx === 'https://explorer.solana.com/tx/' && network.explorerSuffix === '?cluster=devnet', 'malformed Solana devnet network');
    } else throw new Error('Invalid city story: unsupported network');
  }
  const actors = new Set<string>();
  for (const item of list(story.personas)) {
    const persona = object(item);
    identifier(persona.id); text(persona.name); text(persona.role);
    requireShape(!actors.has(persona.id), 'duplicate persona'); actors.add(persona.id);
    requireShape(persona.fictional === true, 'personas must be fictional');
    if (persona.account !== undefined) {
      text(persona.account);
      requireShape(evmAddress.test(persona.account) && Object.hasOwn(networks, 'robinhood-testnet'), 'invalid test account');
    }
    if (persona.note !== undefined) text(persona.note);
  }
  const ids = new Set<string>();
  for (const item of list(story.steps)) {
    const step = object(item);
    identifier(step.id); text(step.actor); text(step.title); text(step.summary);
    requireShape(!ids.has(step.id), 'duplicate step'); ids.add(step.id);
    requireShape(actors.has(step.actor), 'unknown actor');
    requireShape(kinds.includes(step.kind as StoryKind), 'unknown kind');
    for (const key of ['startedAtUtc', 'finishedAtUtc']) if (step[key] !== undefined) {
      text(step[key]); requireShape(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(step[key]) && Number.isFinite(Date.parse(step[key])), 'invalid UTC timestamp');
    }
    if (step.facts !== undefined) facts(step.facts);
    if (step.receipts !== undefined) for (const item of list(step.receipts)) {
      const receipt = object(item);
      text(receipt.network); text(receipt.hash); text(receipt.label);
      requireShape(Object.hasOwn(networks, receipt.network), 'unknown receipt network');
      requireShape(receipt.network === 'solana-devnet' ? validSolanaSignature(receipt.hash) : evmHash.test(receipt.hash), 'malformed transaction hash');
    }
    if (step.links !== undefined) for (const item of list(step.links)) {
      const link = object(item); text(link.label);
      text(link.href);
      if (link.href.startsWith('/') && !link.href.startsWith('//') && !link.href.includes('\\')) continue;
      url(link.href);
    }
  }
  if (story.outcome !== undefined) {
    const outcome = object(story.outcome); text(outcome.title); text(outcome.summary);
    if (outcome.facts !== undefined) facts(outcome.facts);
  }
  return value as CityStory;
}

export function receiptUrl(network: StoryNetwork, hash: string): string {
  return `${network.explorerTx}${hash}${network.explorerSuffix ?? ''}`;
}

export function loadCityStory(): CityStory {
  return validateCityStory(evidence);
}
