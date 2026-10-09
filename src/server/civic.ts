import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { CIVIC_LIMITS, type CivicAction, type CivicContribution, type CivicResult, type CivicTopic, type CivicTopicList } from '../data/civic.ts';
import { isCivicCity } from '../data/civic-cities.ts';
import { hasCityAiTag, type CivicAiSource } from '../data/civic-ai.ts';
import { WorkflowError } from '../domain/errors.ts';
import { IdentityError, type VerifiedIdentity } from '../wallets/identity-policy.ts';
import { AccessError } from './errors.ts';
import { readBody, sameOrigin } from './http.ts';
import type { Store } from './store.ts';

export class CivicError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CivicError';
    this.status = status;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOPICS = 'civic:topic:';
const MAX_RECEIPTS = CIVIC_LIMITS.votes + CIVIC_LIMITS.contributions + CIVIC_LIMITS.linkedCities + 4;
type Receipt = { account: string; operationId: string; fingerprint: string; contributionId?: string };
type TopicRecord = Omit<CivicTopic, 'canManage' | 'canRequestAi' | 'ownVote' | 'voteCount' | 'contributions'> & {
  author: string;
  contributions: (CivicContribution & { author: string; aiFingerprint?: string })[];
  votes: { account: string; choice: number }[];
  receipts: Receipt[];
};
type Creation = { operationId: string; fingerprint: string; topicId: string; createdAt: string };
type AccountRecord = { creations: Creation[] };

function invalid(message: string): never {
  throw new CivicError(400, 'invalid_request', message);
}
function limit(message: string): never {
  throw new CivicError(429, 'limit_exceeded', message);
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${label} must be a lowercase UUID.`);
  return value;
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length > maximum)
    invalid(`${label} must be plain text of 1–${maximum} characters.`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      invalid(`${label} must not contain control characters.`);
  }
  const trimmed = value.trim();
  if (!trimmed) invalid(`${label} is required.`);
  return trimmed;
}
function city(value: unknown): string {
  if (typeof value !== 'string' || !isCivicCity(value)) invalid('Choose a supported city.');
  return value;
}
function source(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048 || /\s/u.test(value)) invalid('Use a public HTTPS source URL.');
  let url: URL;
  try { url = new URL(value); } catch { invalid('Use a public HTTPS source URL.'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(hostname) || hostname.startsWith('[') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
      /\.(?:localhost|local|internal|invalid|test|example)$/.test(hostname))
    invalid('Use a public HTTPS source URL without credentials or a custom port.');
  // Metadata only. The server never follows a user-provided URL or claims the source endorses this opinion.
  return url.href;
}
function keys(body: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some((key) => !Object.hasOwn(body, key)) || Object.keys(body).some((key) => !required.includes(key) && !optional.includes(key)))
    invalid('The action contains missing or unsupported fields.');
}

/** Parse an untrusted action without retaining client-supplied identity or arbitrary fields. */
export function parseCivicAction(input: unknown): CivicAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('A JSON object is required.');
  const body = input as Record<string, unknown>;
  const operationId = uuid(body.operationId, 'operationId');
  if (body.action === 'create') {
    keys(body, ['action', 'operationId', 'cityId', 'title', 'context', 'question', 'options'], ['sourceUrl']);
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > CIVIC_LIMITS.options)
      invalid('Provide two to five distinct options.');
    const options = body.options.map((value) => text(value, CIVIC_LIMITS.option, 'Option'));
    if (new Set(options.map((value) => value.normalize('NFKC').toLowerCase())).size !== options.length)
      invalid('Provide distinct options.');
    return {
      action: 'create', operationId, cityId: city(body.cityId), title: text(body.title, CIVIC_LIMITS.title, 'Title'),
      context: text(body.context, CIVIC_LIMITS.context, 'Context'), question: text(body.question, CIVIC_LIMITS.question, 'Question'),
      options, sourceUrl: source(body.sourceUrl),
    };
  }
  const common = ['action', 'operationId', 'topicId', 'version'];
  const topicId = uuid(body.topicId, 'topicId');
  if (!Number.isSafeInteger(body.version) || (body.version as number) < 1) invalid('A positive topic version is required.');
  const version = body.version as number;
  switch (body.action) {
    case 'contribute':
      keys(body, [...common, 'stance', 'text', 'parentId']);
      if (body.stance !== 'discussion' && body.stance !== 'pro' && body.stance !== 'con') invalid('Choose discussion, pro or con.');
      return {
        action: body.action, operationId, topicId, version, stance: body.stance,
        text: text(body.text, CIVIC_LIMITS.contribution, 'Contribution'), parentId: body.parentId === null ? null : uuid(body.parentId, 'parentId'),
      };
    case 'ready': case 'open': case 'close':
      keys(body, common);
      return { action: body.action, operationId, topicId, version };
    case 'vote':
      keys(body, [...common, 'choice']);
      if (!Number.isSafeInteger(body.choice) || (body.choice as number) < 0 || (body.choice as number) >= CIVIC_LIMITS.options)
        invalid('Choose an available option.');
      return { action: body.action, operationId, topicId, version, choice: body.choice as number };
    case 'link-city':
      keys(body, [...common, 'cityId']);
      return { action: body.action, operationId, topicId, version, cityId: city(body.cityId) };
    default: invalid('Choose a supported civic action.');
  }
}

function account(identity: VerifiedIdentity): string {
  if (!identity.subject || !identity.sessionId || !Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= Date.now())
    throw new CivicError(401, 'unauthorized', 'Sign in before continuing.');
  // Private pseudonymous keys are not anonymous ballots: the operator can associate them with accounts.
  return createHash('sha256').update(identity.subject).digest('hex');
}
/** Public contribution snapshot; explicit metadata keys also canonicalize PostgreSQL JSONB. */
function contribution(value: CivicContribution): CivicContribution {
  return {
    id: value.id, parentId: value.parentId, stance: value.stance, text: value.text, createdAt: value.createdAt,
    ...(value.ai ? { ai: {
      authority: value.ai.authority, provider: value.ai.provider, jobId: value.ai.jobId, model: value.ai.model,
      sources: value.ai.sources.map((item) => ({
        id: item.id, title: item.title, url: item.url, asOf: item.asOf, kind: item.kind, reviewState: item.reviewState,
      })),
      generatedAt: value.ai.generatedAt,
    } } : {}),
  };
}
function project(record: TopicRecord, viewer: string): CivicTopic {
  return {
    id: record.id, cityId: record.cityId, linkedCityIds: [...record.linkedCityIds], title: record.title, context: record.context,
    question: record.question, options: [...record.options], sourceUrl: record.sourceUrl, phase: record.phase, version: record.version,
    createdAt: record.createdAt, updatedAt: record.updatedAt, openedAt: record.openedAt,
    contributions: record.contributions.map((item) => ({
      ...contribution(item),
      ...(record.phase === 'discussion' && item.author === viewer && !item.ai && hasCityAiTag(item.text) ? { canRequestAi: true } : {}),
    })),
    result: record.result ? { counts: [...record.result.counts], total: record.result.total, closedAt: record.result.closedAt, hash: record.result.hash } : null,
    canManage: record.author === viewer, ownVote: record.votes.find((vote) => vote.account === viewer)?.choice ?? null,
    voteCount: record.votes.length,
    ...(record.phase === 'discussion' && record.author === viewer && hasCityAiTag(record.context) ? { canRequestAi: true } : {}),
  };
}

/** Explicit field ordering is identical for SQLite JSON and PostgreSQL JSONB. Never hash a spread record. */
export function civicResultHash(topic: Pick<CivicTopic, 'id' | 'cityId' | 'title' | 'context' | 'question' | 'options' | 'sourceUrl' | 'createdAt' | 'openedAt' | 'contributions'>, result: Pick<CivicResult, 'counts' | 'total' | 'closedAt'>): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'ledger-civic-result-v1',
    topic: {
      id: topic.id, cityId: topic.cityId, title: topic.title, context: topic.context, question: topic.question,
      options: topic.options, sourceUrl: topic.sourceUrl, createdAt: topic.createdAt, openedAt: topic.openedAt,
      contributions: topic.contributions.map(contribution),
    },
    result: { counts: result.counts, total: result.total, closedAt: result.closedAt },
  })).digest('hex');
}

async function createIfAbsent<T>(store: Store, key: string, value: T): Promise<void> {
  try { await store.create(key, value); }
  catch (error) {
    // Only suppress a concurrent insert if the authoritative record now actually exists.
    if (!await store.get<T>(key)) throw error;
  }
}
function fingerprint(action: CivicAction): string {
  // parseCivicAction establishes canonical key ordering and strips no unsupported fields silently.
  return createHash('sha256').update(JSON.stringify(action)).digest('hex');
}
async function createTopic(store: Store, viewer: string, action: Extract<CivicAction, { action: 'create' }>): Promise<CivicTopic> {
  const key = `civic:account:${viewer}`;
  await createIfAbsent<AccountRecord>(store, key, { creations: [] });
  const digest = fingerprint(action);
  const now = new Date().toISOString();
  const proposedId = randomUUID();
  // The durable reservation bounds even interrupted creates and retains their original UUID/time for retries.
  const record = await store.update<AccountRecord>(key, (value) => {
    const prior = value.creations.find((entry) => entry.operationId === action.operationId);
    if (prior) {
      if (prior.fingerprint !== digest) throw new CivicError(409, 'idempotency_conflict', 'This operationId was already used for a different action.');
      return value;
    }
    if (value.creations.length >= CIVIC_LIMITS.topicsPerAccount) limit('This account has reached its topic limit.');
    if (value.creations.filter((entry) => entry.createdAt.slice(0, 10) === now.slice(0, 10)).length >= CIVIC_LIMITS.topicsPerDay)
      limit('This account has reached its UTC-day topic limit.');
    value.creations.push({ operationId: action.operationId, fingerprint: digest, topicId: proposedId, createdAt: now });
    return value;
  });
  const reservation = record.creations.find((entry) => entry.operationId === action.operationId)!;
  const topic: TopicRecord = {
    id: reservation.topicId, cityId: action.cityId, linkedCityIds: [], title: action.title, context: action.context,
    question: action.question, options: action.options, sourceUrl: action.sourceUrl ?? null, phase: 'discussion', version: 1,
    createdAt: reservation.createdAt, updatedAt: reservation.createdAt, openedAt: null, contributions: [], result: null,
    author: viewer, votes: [], receipts: [{ account: viewer, operationId: action.operationId, fingerprint: digest }],
  };
  await createIfAbsent(store, TOPICS + topic.id, topic);
  return project((await store.get<TopicRecord>(TOPICS + topic.id))!, viewer);
}

function requirePhase(topic: TopicRecord, phase: CivicTopic['phase']) {
  if (topic.phase !== phase) throw new CivicError(409, 'invalid_phase', `This action requires the ${phase} phase.`);
}
function requireAuthor(topic: TopicRecord, viewer: string) {
  if (topic.author !== viewer) throw new CivicError(403, 'forbidden', 'Only the topic author may manage its phase or city links.');
}

/** Receipts are scoped to account + topic (create: account). Replays return the latest safe projection. */
export async function mutateCivic(store: Store, identity: VerifiedIdentity, input: unknown): Promise<CivicTopic> {
  const viewer = account(identity);
  const action = parseCivicAction(input);
  if (action.action === 'create') return createTopic(store, viewer, action);
  const key = TOPICS + action.topicId;
  if (!await store.get<TopicRecord>(key)) throw new CivicError(404, 'not_found', 'Topic not found.');
  const digest = fingerprint(action);
  const contributionId = action.action === 'contribute' ? randomUUID() : '';
  const updated = await store.update<TopicRecord>(key, (topic) => {
    const prior = topic.receipts.find((entry) => entry.account === viewer && entry.operationId === action.operationId);
    if (prior) {
      if (prior.fingerprint !== digest) throw new CivicError(409, 'idempotency_conflict', 'This operationId was already used for a different action.');
      return topic;
    }
    if (topic.version !== action.version) throw new CivicError(409, 'version_conflict', 'The topic changed. Reload it before acting.');
    if (topic.receipts.length >= MAX_RECEIPTS) limit('This topic has reached its operation limit.');
    const now = new Date().toISOString();
    switch (action.action) {
      case 'contribute': {
        requirePhase(topic, 'discussion');
        if (topic.contributions.length >= CIVIC_LIMITS.contributions) limit('This topic has reached its contribution limit.');
        if (topic.contributions.filter((item) => item.author === viewer).length >= CIVIC_LIMITS.contributionsPerAccount)
          limit('This account has reached its contribution limit for this topic.');
        let parentId = action.parentId;
        let depth = 1;
        while (parentId !== null) {
          const parent = topic.contributions.find((item) => item.id === parentId);
          if (!parent || parent.stance === 'discussion') invalid('A parent must be an existing pro or con argument on this topic.');
          if (++depth > CIVIC_LIMITS.depth) invalid('The argument hierarchy is too deep.');
          parentId = parent.parentId;
        }
        topic.contributions.push({ id: contributionId, parentId: action.parentId, stance: action.stance, text: action.text, createdAt: now, author: viewer });
        topic.version += 1;
        break;
      }
      case 'ready':
        requireAuthor(topic, viewer);
        requirePhase(topic, 'discussion');
        if (!topic.contributions.some((item) => item.stance === 'pro') || !topic.contributions.some((item) => item.stance === 'con'))
          throw new CivicError(409, 'not_ready', 'Add at least one pro and one con argument before marking this question ready.');
        topic.phase = 'ready';
        topic.version += 1;
        break;
      case 'open':
        requireAuthor(topic, viewer);
        requirePhase(topic, 'ready');
        topic.phase = 'open';
        topic.openedAt = now;
        topic.version += 1;
        break;
      case 'vote':
        requirePhase(topic, 'open');
        if (action.choice >= topic.options.length) invalid('Choose an available option.');
        if (topic.votes.some((vote) => vote.account === viewer)) throw new CivicError(409, 'already_voted', 'This account already voted on this topic.');
        if (topic.votes.length >= CIVIC_LIMITS.votes) limit('This topic has reached its account-vote limit.');
        topic.votes.push({ account: viewer, choice: action.choice });
        // Ballot revision stays stable: concurrent voters do not invalidate one another's reviewed question.
        break;
      case 'close': {
        requireAuthor(topic, viewer);
        requirePhase(topic, 'open');
        const counts = topic.options.map(() => 0);
        for (const vote of topic.votes) counts[vote.choice] += 1;
        const result = { counts, total: topic.votes.length, closedAt: now };
        topic.result = { ...result, hash: civicResultHash(topic, result) };
        topic.phase = 'closed';
        topic.version += 1;
        break;
      }
      case 'link-city':
        requireAuthor(topic, viewer);
        if (action.cityId === topic.cityId || topic.linkedCityIds.includes(action.cityId))
          throw new CivicError(409, 'already_linked', 'This topic is already visible in that city.');
        if (topic.linkedCityIds.length >= CIVIC_LIMITS.linkedCities) limit('This topic has reached its linked-city limit.');
        topic.linkedCityIds.push(action.cityId);
        // Discovery metadata can change even after close; it is not part of the ballot or result hash.
        break;
    }
    topic.updatedAt = now;
    topic.receipts.push({
      account: viewer, operationId: action.operationId, fingerprint: digest,
      ...(action.action === 'contribute' ? { contributionId } : {}),
    });
    return topic;
  });
  return project(updated, viewer);
}

export async function readCivicTopic(store: Store, identity: VerifiedIdentity, id: unknown): Promise<CivicTopic> {
  const viewer = account(identity);
  const topic = await store.get<TopicRecord>(TOPICS + uuid(id, 'topicId'));
  if (!topic) throw new CivicError(404, 'not_found', 'Topic not found.');
  return project(topic, viewer);
}

export interface CivicAiTrigger {
  accountId: string; topicId: string; contributionId: string | null; cityId: string;
  topicTitle: string; topicBody: string; topicQuestion: string; topicSourceUrl: string | null; triggerText: string;
  topicStatus: CivicTopic['phase']; version: number;
}

/** Server-only trigger authority. The caller decides how a frozen topic affects existing job status. */
export async function resolveCivicAiTrigger(store: Store, identity: VerifiedIdentity, input: {
  topicId: string; contributionId: string | null;
}, requireOwner = true): Promise<CivicAiTrigger> {
  const viewer = account(identity);
  const topic = await store.get<TopicRecord>(TOPICS + uuid(input.topicId, 'topicId'));
  if (!topic) throw new CivicError(404, 'not_found', 'Topic not found.');
  const triggerId = input.contributionId === null ? null : uuid(input.contributionId, 'contributionId');
  const trigger = triggerId === null ? null : topic.contributions.find((item) => item.id === triggerId);
  if (triggerId !== null && !trigger) throw new CivicError(404, 'not_found', 'Contribution not found.');
  const owner = trigger ? trigger.author : topic.author;
  if (requireOwner && owner !== viewer)
    throw new CivicError(403, 'forbidden', 'Only the author of this tagged text may request its City AI reply.');
  const triggerText = trigger ? trigger.text : topic.context;
  if (trigger?.ai || !hasCityAiTag(triggerText)) invalid('Request a reply from an authored @city-ai or @Mecky tag.');
  return {
    accountId: owner, topicId: topic.id, contributionId: input.contributionId, cityId: topic.cityId,
    topicTitle: topic.title, topicBody: topic.context, topicQuestion: topic.question, topicSourceUrl: topic.sourceUrl, triggerText,
    topicStatus: topic.phase, version: topic.version,
  };
}

/** No CivicAction exposes this capability. Only the verified, budgeted City AI service may append. */
export async function appendCivicAiContribution(store: Store, input: {
  requestId: string; topicId: string; contributionId: string | null; text: string; model: string;
  sources: CivicAiSource[]; generatedAt: string;
}): Promise<void> {
  const jobId = uuid(input.requestId, 'requestId');
  const key = TOPICS + uuid(input.topicId, 'topicId');
  const triggerId = input.contributionId === null ? null : uuid(input.contributionId, 'contributionId');
  const body = text(input.text, CIVIC_LIMITS.contribution, 'AI reply');
  const model = text(input.model, 160, 'AI model');
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 3)
    invalid('An AI reply needs one to three published source references.');
  const sources = input.sources.map((item) => ({
    id: text(item.id, 160, 'Source identifier'), title: text(item.title, 160, 'Source title'),
    url: source(item.url) ?? invalid('Source URL is required.'), asOf: text(item.asOf, 64, 'Source date'),
    kind: text(item.kind, 64, 'Source kind'), reviewState: text(item.reviewState, 32, 'Source review state'),
  }));
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt)) ||
      new Date(input.generatedAt).toISOString() !== input.generatedAt) invalid('Use an ISO timestamp for the AI reply.');
  const generatedAt = input.generatedAt;
  const digest = createHash('sha256').update(JSON.stringify({ jobId, triggerId, body, model, sources, generatedAt })).digest('hex');
  if (!await store.get<TopicRecord>(key)) throw new CivicError(404, 'not_found', 'Topic not found.');
  await store.update<TopicRecord>(key, (topic) => {
    const prior = topic.contributions.find((item) => item.ai?.jobId === jobId);
    if (prior) {
      if (prior.aiFingerprint !== digest)
        throw new CivicError(409, 'idempotency_conflict', 'This AI job already published a different reply.');
      return topic;
    }
    requirePhase(topic, 'discussion');
    if (topic.contributions.length >= CIVIC_LIMITS.contributions) limit('This topic has reached its contribution limit.');
    const trigger = triggerId === null ? null : topic.contributions.find((item) => item.id === triggerId);
    if (triggerId !== null && !trigger) throw new CivicError(404, 'not_found', 'Contribution not found.');
    if (trigger?.ai || !hasCityAiTag(trigger ? trigger.text : topic.context)) invalid('The AI trigger must be tagged human text.');
    const now = new Date().toISOString();
    // AI text is a labelled discussion reply, not an invented pro/con stance or readiness consensus.
    // Keep it a root: an argument already at maximum depth must still be eligible for a sourced reply.
    topic.contributions.push({
      id: randomUUID(), parentId: null, stance: 'discussion', text: body, createdAt: now, author: '', aiFingerprint: digest,
      ai: { authority: 'none', provider: 'ledger-library', jobId, model, sources, generatedAt },
    });
    topic.version += 1;
    topic.updatedAt = now;
    return topic;
  });
}

export async function listCivicTopics(store: Store, identity: VerifiedIdentity, cityId: unknown, cursor?: string | null): Promise<CivicTopicList> {
  const viewer = account(identity);
  const scope = city(cityId);
  let after = '';
  if (cursor !== undefined && cursor !== null) {
    if (cursor.length > 240 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('Invalid city cursor.');
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalid('Invalid city cursor.'); }
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1 || decoded[1] !== scope) invalid('Invalid city cursor.');
    after = TOPICS + uuid(decoded[2], 'Cursor topic');
  }
  // One bounded keyset scan, including one lookahead. No count query, unbounded filtering loop or
  // non-atomic secondary city index. Empty filtered pages honestly carry the last scanned key.
  // This is a live traversal, not a snapshot: newly created/linked earlier keys appear on refresh.
  const rows = await store.scan<TopicRecord>(TOPICS, after, CIVIC_LIMITS.pageSize + 1);
  const page = rows.slice(0, CIVIC_LIMITS.pageSize);
  return {
    topics: page.filter(({ value }) => value.cityId === scope || value.linkedCityIds.includes(scope)).map(({ value }) => project(value, viewer)),
    nextCursor: rows.length > CIVIC_LIMITS.pageSize
      ? Buffer.from(JSON.stringify([1, scope, page[page.length - 1].value.id])).toString('base64url') : null,
  };
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Authorization' };
function failure(error: unknown): Response {
  let status = 503;
  let code = 'unavailable';
  let message = 'Civic topics are temporarily unavailable. Retry with the same operationId.';
  if (error instanceof CivicError) {
    ({ status, code } = error);
    message = error.message;
  } else if (error instanceof IdentityError) {
    status = error.code === 'identity_unavailable' ? 503 : 401;
    code = status === 401 ? 'unauthorized' : 'unavailable';
    message = status === 401 ? 'Sign in before continuing.' : message;
  } else if (error instanceof AccessError) {
    status = 403; code = 'forbidden'; message = error.message;
  } else if (error instanceof WorkflowError || error instanceof SyntaxError) {
    status = error.message === 'Request too large.' ? 413 : 400;
    code = status === 413 ? 'body_too_large' : 'invalid_request';
    message = error.message;
    if (error instanceof SyntaxError) message = 'Send valid JSON.';
  }
  return Response.json({ error: message, code }, { status, headers: HEADERS });
}

/** Route dependencies stay at the boundary; tests exercise this same handler without provider/network calls. */
export async function handleCivicRequest(request: Request, dependencies: {
  authenticate: (request: Request) => Promise<VerifiedIdentity>;
  store: () => Promise<Store>;
}): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'POST')
      throw new CivicError(405, 'method_not_allowed', 'Use GET or POST.');
    if (request.method === 'POST') sameOrigin(request);
    const identity = await dependencies.authenticate(request);
    account(identity);
    const params = new URL(request.url).searchParams;
    if (request.method === 'POST') {
      if (params.size) invalid('POST does not accept query parameters.');
      const body = parseCivicAction(await readBody(request, CIVIC_LIMITS.bodyBytes));
      const store = await dependencies.store();
      const topic = await mutateCivic(store, identity, body);
      if (body.action === 'contribute') {
        const record = await store.get<TopicRecord>(TOPICS + topic.id);
        const contributionId = record?.receipts.find((entry) => entry.account === account(identity) && entry.operationId === body.operationId)?.contributionId;
        if (!contributionId) throw new Error('Missing civic contribution receipt.');
        return Response.json({ topic, contributionId }, { headers: HEADERS });
      }
      return Response.json({ topic }, { headers: HEADERS });
    }
    if (params.has('topic')) {
      if (params.size !== 1) invalid('Choose exactly one topic.');
      return Response.json({ topic: await readCivicTopic(await dependencies.store(), identity, params.get('topic')) }, { headers: HEADERS });
    }
    if (!params.has('city') || params.getAll('city').length !== 1 || params.getAll('cursor').length > 1 || [...params.keys()].some((key) => key !== 'city' && key !== 'cursor'))
      invalid('Choose one city and an optional cursor.');
    return Response.json(await listCivicTopics(await dependencies.store(), identity, params.get('city'), params.get('cursor')), { headers: HEADERS });
  } catch (error) {
    return failure(error);
  }
}
