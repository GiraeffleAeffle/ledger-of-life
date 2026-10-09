import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CIVIC_CITIES } from '../data/civic-cities.ts';
import { CIVIC_LIMITS, type CivicTopic } from '../data/civic.ts';
import { IdentityError, type VerifiedIdentity } from '../wallets/identity-policy.ts';
import { appendCivicAiContribution, CivicError, civicResultHash, handleCivicRequest, listCivicTopics, mutateCivic, parseCivicAction, readCivicTopic, resolveCivicAiTrigger } from './civic.ts';
import { LocalStore, PostgresStore, type Store } from './store.ts';

/** SQL contract double only, not PostgreSQL integration evidence. JSONB deliberately reorders object keys. */
function jsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonb);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, jsonb(item)]));
  return value;
}
class PgContractPool {
  records = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();
  async query(sql: string, values: unknown[] = []): Promise<{ rows: { key?: string; body: unknown }[] }> {
    if (sql.startsWith('CREATE TABLE') || sql.startsWith('DELETE FROM') || sql.startsWith("UPDATE rental_records SET body = body - 'rate'")) return { rows: [] };
    if (sql === 'SELECT body FROM rental_records WHERE key = $1') {
      const value = this.records.get(values[0] as string);
      return { rows: value === undefined ? [] : [{ body: structuredClone(value) }] };
    }
    if (sql === 'INSERT INTO rental_records(key, body) VALUES ($1, $2::jsonb)') {
      const key = values[0] as string;
      if (this.records.has(key)) throw new Error('duplicate key');
      this.records.set(key, jsonb(JSON.parse(values[1] as string)));
      return { rows: [] };
    }
    if (sql === 'SELECT key, body FROM rental_records WHERE starts_with(key, $1) AND key > $2 ORDER BY key LIMIT $3') {
      return { rows: [...this.records.entries()].filter(([key]) => key.startsWith(values[0] as string) && key > (values[1] as string))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, values[2] as number).map(([key, body]) => ({ key, body: structuredClone(body) })) };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  }
  async connect() {
    let unlock: (() => void) | undefined;
    let pending: { key: string; body: unknown } | undefined;
    return {
      query: async (sql: string, values: unknown[] = []): Promise<{ rows: { key?: string; body: unknown }[] }> => {
        if (sql === 'BEGIN') {
          const previous = this.queue;
          this.queue = new Promise<void>((resolve) => { unlock = resolve; });
          await previous;
          return { rows: [] };
        }
        if (sql === 'SELECT body FROM rental_records WHERE key = $1 FOR UPDATE') {
          const value = this.records.get(values[0] as string);
          return { rows: value === undefined ? [] : [{ body: structuredClone(value) }] };
        }
        if (sql === 'UPDATE rental_records SET body = $1::jsonb WHERE key = $2') {
          pending = { key: values[1] as string, body: jsonb(JSON.parse(values[0] as string)) };
          return { rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql === 'COMMIT' && pending) this.records.set(pending.key, pending.body);
          pending = undefined;
          unlock?.(); unlock = undefined;
          return { rows: [] };
        }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      },
      release() { assert.equal(unlock, undefined, 'transaction must commit or roll back before release'); },
    };
  }
  async end() {}
}

const stores: { name: string; create: () => Store }[] = [
  { name: 'SQLite', create: () => new LocalStore(':memory:') },
  { name: 'PostgresStore SQL contract (no live database)', create: () => new PostgresStore(new PgContractPool()) },
];
function identity(name = 'author'): VerifiedIdentity {
  return { subject: `did:privy:PRIVATE-${name}`, sessionId: `PRIVATE-session-${name}`, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    passkeyCount: 1, wallets: [{ id: 'PRIVATE-wallet-id', address: 'PRIVATE-wallet-address', chainType: 'solana' }] };
}
function createAction(cityId = 'strausberg') {
  return { action: 'create', operationId: randomUUID(), cityId, title: 'Neighbourhood walking routes',
    context: 'An account-authored opinion, not a municipal decision.', question: 'Which route should we discuss first?',
    options: ['Station', 'Lake'], sourceUrl: 'https://www.strausberg.de/' };
}
function action(topic: CivicTopic, kind: string, fields: Record<string, unknown> = {}) {
  return { action: kind, topicId: topic.id, version: topic.version, operationId: randomUUID(), ...fields };
}
async function openTopic(store: Store, owner = identity()): Promise<CivicTopic> {
  let topic = await mutateCivic(store, owner, createAction());
  topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: 'A safe route helps.', parentId: null }));
  topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: 'The cost needs discussion.', parentId: null }));
  topic = await mutateCivic(store, owner, action(topic, 'ready'));
  return mutateCivic(store, owner, action(topic, 'open'));
}
async function rejectsCode(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof CivicError && error.code === code);
}

for (const backend of stores) {
  test(`${backend.name}: author lifecycle, frozen content, private account votes and reproducible close`, async () => {
    const store = backend.create();
    const owner = identity(); const voter = identity('other');
    try {
      let topic = await mutateCivic(store, owner, createAction());
      assert.equal(topic.phase, 'discussion'); assert.equal(topic.version, 1); assert.equal(topic.canManage, true);
      assert.deepEqual(await listCivicTopics(store, voter, 'altlandsberg'), { topics: [], nextCursor: null });
      assert.equal((await readCivicTopic(store, voter, topic.id)).canManage, false);
      await rejectsCode(mutateCivic(store, voter, action(topic, 'ready')), 'forbidden');
      await rejectsCode(mutateCivic(store, owner, action(topic, 'ready')), 'not_ready');
      await rejectsCode(mutateCivic(store, owner, action(topic, 'open')), 'invalid_phase');
      await rejectsCode(mutateCivic(store, voter, action(topic, 'vote', { choice: 0 })), 'invalid_phase');
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'discussion', text: 'Let us compare sources.', parentId: null }));
      const general = topic.contributions[0];
      await rejectsCode(mutateCivic(store, voter, action(topic, 'contribute', { stance: 'pro', text: 'Wrong parent', parentId: general.id })), 'invalid_request');
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: 'Walking is useful.', parentId: null }));
      await rejectsCode(mutateCivic(store, owner, action(topic, 'ready')), 'not_ready');
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: 'The cost remains unknown.', parentId: topic.contributions[1].id }));
      topic = await mutateCivic(store, owner, action(topic, 'ready'));
      const snapshot = structuredClone(topic.contributions);
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: 'Too late', parentId: null })), 'invalid_phase');
      await rejectsCode(mutateCivic(store, voter, action(topic, 'open')), 'forbidden');
      topic = await mutateCivic(store, owner, action(topic, 'open'));
      assert.ok(topic.openedAt);
      const ballotVersion = topic.version;
      await rejectsCode(mutateCivic(store, voter, action(topic, 'vote', { choice: 2 })), 'invalid_request');
      const vote = action(topic, 'vote', { choice: 1 });
      const voted = await mutateCivic(store, voter, vote);
      assert.equal(voted.version, ballotVersion); assert.equal(voted.ownVote, 1); assert.equal(voted.voteCount, 1); assert.equal(voted.result, null);
      assert.equal((await readCivicTopic(store, owner, topic.id)).ownVote, null);
      await rejectsCode(mutateCivic(store, voter, action(topic, 'vote', { choice: 0 })), 'already_voted');
      await rejectsCode(mutateCivic(store, voter, { ...vote, choice: 0 }), 'idempotency_conflict');
      topic = await mutateCivic(store, owner, action(topic, 'vote', { choice: 0 }));
      await rejectsCode(mutateCivic(store, voter, action(topic, 'close')), 'forbidden');
      const close = action(topic, 'close');
      topic = await mutateCivic(store, owner, close);
      assert.equal(topic.phase, 'closed'); assert.equal(topic.version, ballotVersion + 1);
      assert.deepEqual(topic.contributions, snapshot);
      assert.deepEqual(topic.result?.counts, [1, 1]); assert.equal(topic.result?.total, 2);
      assert.ok(topic.result); assert.match(topic.result.hash, /^[a-f0-9]{64}$/);
      assert.equal(topic.result.hash, civicResultHash(topic, topic.result));
      assert.deepEqual((await mutateCivic(store, owner, close)).result, topic.result);
      assert.equal((await mutateCivic(store, voter, vote)).ownVote, 1, 'an acknowledged vote remains retryable after close');
      await rejectsCode(mutateCivic(store, identity('late'), action(topic, 'vote', { choice: 0 })), 'invalid_phase');
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: 'Late edit', parentId: null })), 'invalid_phase');
      const publicJson = JSON.stringify(await listCivicTopics(store, voter, 'strausberg'));
      for (const secret of ['PRIVATE-', '"author"', '"votes"', '"receipts"', '"account"', '"wallets"', createHash('sha256').update(owner.subject).digest('hex')])
        assert.equal(publicJson.includes(secret), false, `public projection must omit ${secret}`);
      assert.equal(topic.result.hash, civicResultHash({ ...topic, contributions: topic.contributions.map((item) => ({ ...item })) }, topic.result));
      for (const change of [{ question: 'Changed' }, { cityId: 'altlandsberg' }, { id: randomUUID() }, { options: [...topic.options].reverse() },
        { openedAt: '2000-01-01T00:00:00.000Z' }, { contributions: snapshot.slice(1) }])
        assert.notEqual(topic.result.hash, civicResultHash({ ...topic, ...change }, topic.result));
      assert.notEqual(topic.result.hash, civicResultHash(topic, { ...topic.result, counts: [2, 0] }));
      assert.notEqual(topic.result.hash, civicResultHash(topic, { ...topic.result, total: 3 }));
      assert.notEqual(topic.result.hash, civicResultHash(topic, { ...topic.result, closedAt: '2000-01-01T00:00:00.000Z' }));
    } finally { await store.close(); }
  });

  test(`${backend.name}: concurrent revisions, duplicate retries, votes and close are atomic`, async () => {
    const store = backend.create(); const owner = identity();
    try {
      const create = createAction();
      const [first, retry] = await Promise.all([mutateCivic(store, owner, create), mutateCivic(store, owner, create)]);
      assert.equal(first.id, retry.id);
      await rejectsCode(mutateCivic(store, owner, { ...create, title: 'Different payload' }), 'idempotency_conflict');
      const competing = await Promise.allSettled([
        mutateCivic(store, owner, action(first, 'contribute', { stance: 'pro', text: 'First revision', parentId: null })),
        mutateCivic(store, identity('other'), action(first, 'contribute', { stance: 'con', text: 'Racing revision', parentId: null })),
      ]);
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = competing.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof CivicError && rejected.reason.code === 'version_conflict');
      let current = await readCivicTopic(store, owner, first.id);
      const contribution = action(current, 'contribute', { stance: 'con', text: 'A repeatable contribution', parentId: null });
      const same = await Promise.all([mutateCivic(store, owner, contribution), mutateCivic(store, owner, contribution)]);
      assert.equal(same[0].version, same[1].version);
      assert.equal(same[0].contributions.length, 2);
      current = await openTopic(store, identity('poll-author'));
      const a = identity('a'); const b = identity('b');
      const concurrentVotes = await Promise.allSettled([
        mutateCivic(store, a, action(current, 'vote', { choice: 0 })),
        mutateCivic(store, a, action(current, 'vote', { choice: 1 })),
        mutateCivic(store, b, action(current, 'vote', { choice: 1 })),
      ]);
      assert.equal(concurrentVotes.filter((result) => result.status === 'fulfilled').length, 2);
      const duplicate = concurrentVotes.find((result) => result.status === 'rejected');
      assert.ok(duplicate?.status === 'rejected' && duplicate.reason instanceof CivicError && duplicate.reason.code === 'already_voted');
      assert.equal((await readCivicTopic(store, owner, current.id)).voteCount, 2);
      const last = action(current, 'vote', { choice: 0 });
      const [lastVote, closed] = await Promise.allSettled([
        mutateCivic(store, identity('last'), last), mutateCivic(store, identity('poll-author'), action(current, 'close')),
      ]);
      assert.equal(closed.status, 'fulfilled');
      const final = await readCivicTopic(store, owner, current.id);
      assert.equal(final.result?.total, lastVote.status === 'fulfilled' ? 3 : 2);
      assert.equal(final.result?.counts.reduce((sum, count) => sum + count, 0), final.result?.total);
      assert.equal(final.result?.hash, civicResultHash(final, final.result!));
    } finally { await store.close(); }
  });

  test(`${backend.name}: linking shares one ballot before and after close and keeps frozen hash`, async () => {
    const store = backend.create(); const owner = identity(); const neighbour = identity('neighbour');
    try {
      let topic = await openTopic(store, owner);
      const ballot = { question: topic.question, options: topic.options, contributions: topic.contributions };
      const link = action(topic, 'link-city', { cityId: 'altlandsberg' });
      await rejectsCode(mutateCivic(store, neighbour, link), 'forbidden');
      assert.deepEqual((await readCivicTopic(store, owner, topic.id)).linkedCityIds, []);
      const linked = await mutateCivic(store, owner, link);
      assert.equal(linked.version, topic.version); assert.equal(linked.canManage, true);
      assert.deepEqual(linked.linkedCityIds, ['altlandsberg']);
      assert.deepEqual((await mutateCivic(store, owner, link)).linkedCityIds, ['altlandsberg']);
      await rejectsCode(mutateCivic(store, owner, { ...link, cityId: 'rehfelde' }), 'idempotency_conflict');
      await rejectsCode(mutateCivic(store, owner, action(linked, 'link-city', { cityId: 'altlandsberg' })), 'already_linked');
      assert.equal((await listCivicTopics(store, neighbour, 'altlandsberg')).topics[0].id, topic.id);
      topic = await mutateCivic(store, neighbour, action(topic, 'vote', { choice: 1 }));
      const same = (await listCivicTopics(store, neighbour, 'strausberg')).topics[0];
      assert.equal(same.ownVote, 1); assert.equal(same.voteCount, 1);
      await rejectsCode(mutateCivic(store, neighbour, action(same, 'vote', { choice: 0 })), 'already_voted');
      topic = await mutateCivic(store, owner, action(topic, 'close'));
      const frozenResult = structuredClone(topic.result);
      await rejectsCode(mutateCivic(store, neighbour, action(topic, 'link-city', { cityId: 'rehfelde' })), 'forbidden');
      const afterClose = await mutateCivic(store, owner, action(topic, 'link-city', { cityId: 'rehfelde' }));
      assert.equal(afterClose.phase, 'closed'); assert.equal(afterClose.version, topic.version);
      assert.deepEqual(afterClose.result, frozenResult);
      assert.deepEqual({ question: afterClose.question, options: afterClose.options, contributions: afterClose.contributions }, ballot);
      assert.equal(afterClose.result?.hash, civicResultHash(afterClose, afterClose.result!));
      assert.equal((await mutateCivic(store, owner, link)).phase, 'closed');
      await rejectsCode(mutateCivic(store, owner, action(linked, 'link-city', { cityId: 'hoppegarten' })), 'version_conflict');
    } finally { await store.close(); }
  });

  test(`${backend.name}: bounded hierarchy, per-account and per-topic contributions, links and votes`, async () => {
    const store = backend.create(); const owner = identity();
    try {
      let topic = await mutateCivic(store, owner, createAction());
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: 'Missing parent', parentId: randomUUID() })), 'invalid_request');
      let parentId: string | null = null;
      for (let depth = 0; depth < CIVIC_LIMITS.depth; depth++) {
        topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: `Depth ${depth + 1}`, parentId }));
        parentId = topic.contributions.at(-1)!.id;
      }
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: 'Too deep', parentId })), 'invalid_request');
      for (let count = topic.contributions.length; count < CIVIC_LIMITS.contributionsPerAccount; count++)
        topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: `Contribution ${count}`, parentId: null }));
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: 'Too many for account', parentId: null })), 'limit_exceeded');
      for (let count = topic.contributions.length; count < CIVIC_LIMITS.contributions; count++)
        topic = await mutateCivic(store, identity(`writer-${Math.floor(count / CIVIC_LIMITS.contributionsPerAccount)}`), action(topic, 'contribute', { stance: 'pro', text: `Contribution ${count}`, parentId: null }));
      await rejectsCode(mutateCivic(store, identity('fresh'), action(topic, 'contribute', { stance: 'pro', text: 'Topic full', parentId: null })), 'limit_exceeded');
      const cities = CIVIC_CITIES.filter((item) => item.id !== topic.cityId);
      for (const item of cities.slice(0, CIVIC_LIMITS.linkedCities))
        topic = await mutateCivic(store, owner, action(topic, 'link-city', { cityId: item.id }));
      await rejectsCode(mutateCivic(store, owner, action(topic, 'link-city', { cityId: cities[CIVIC_LIMITS.linkedCities].id })), 'limit_exceeded');
      topic = await mutateCivic(store, owner, action(topic, 'ready'));
      topic = await mutateCivic(store, owner, action(topic, 'open'));
      // Explicit boundary fixture, private storage only: avoids generating 1000 unnecessary account sessions.
      await store.update(`civic:topic:${topic.id}`, (record: { votes: { account: string; choice: number }[] }) => {
        record.votes = Array.from({ length: CIVIC_LIMITS.votes }, (_, index) => ({ account: `fixture-${index}`, choice: index % 2 }));
        return record;
      });
      await rejectsCode(mutateCivic(store, owner, action(topic, 'vote', { choice: 0 })), 'limit_exceeded');
      topic = await mutateCivic(store, owner, action(topic, 'close'));
      assert.deepEqual(topic.result?.counts, [500, 500]); assert.equal(topic.result?.total, CIVIC_LIMITS.votes);
    } finally { await store.close(); }
  });

  test(`${backend.name}: empty truthful pages, city-bound cursor and bounded keyset scans`, async () => {
    const store = backend.create(); const owner = identity();
    try {
      assert.deepEqual(await listCivicTopics(store, owner, 'strausberg'), { topics: [], nextCursor: null });
      const expected: string[] = [];
      const authors = new Map<string, VerifiedIdentity>();
      for (let index = 0; index < CIVIC_LIMITS.pageSize * 2 + 1; index++) {
        const creator = identity(`creator-${index}`);
        const created = await mutateCivic(store, creator, createAction());
        expected.push(created.id); authors.set(created.id, creator);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const page = await listCivicTopics(store, owner, 'strausberg', cursor);
        assert.ok(page.topics.length <= CIVIC_LIMITS.pageSize);
        seen.push(...page.topics.map((topic) => topic.id)); cursor = page.nextCursor; pageCount += 1;
      } while (cursor);
      assert.equal(pageCount, 3); assert.deepEqual(seen.sort(), expected.sort());
      const empty = await listCivicTopics(store, owner, 'altlandsberg');
      assert.deepEqual(empty.topics, []); assert.ok(empty.nextCursor);
      await rejectsCode(listCivicTopics(store, owner, 'strausberg', empty.nextCursor), 'invalid_request');
      for (const bad of ['', 'not-json', '*', Buffer.from(JSON.stringify([1, 'strausberg', 'not-a-uuid'])).toString('base64url')])
        await rejectsCode(listCivicTopics(store, owner, 'strausberg', bad), 'invalid_request');
      const requested: number[] = [];
      const bounded: Store = {
        get: store.get.bind(store), create: store.create.bind(store), update: store.update.bind(store), close: async () => {},
        scan: async <T>(prefix: string, after?: string, size?: number) => { requested.push(size ?? 0); return store.scan<T>(prefix, after, size); },
      };
      await listCivicTopics(bounded, owner, 'altlandsberg');
      assert.deepEqual(requested, [CIVIC_LIMITS.pageSize + 1]);
      const topic = await readCivicTopic(store, owner, expected[0]);
      await mutateCivic(store, authors.get(topic.id)!, action(topic, 'link-city', { cityId: 'altlandsberg' }));
      assert.equal((await listCivicTopics(store, owner, 'altlandsberg')).topics[0].id, topic.id);
    } finally { await store.close(); }
  });

  test(`${backend.name}: create reservations survive interrupted topic insert and enforce durable quotas`, async () => {
    const store = backend.create(); const owner = identity(); let interrupted = false;
    try {
      const fault: Store = {
        get: store.get.bind(store), update: store.update.bind(store), scan: store.scan.bind(store), close: async () => {},
        create: async <T>(key: string, value: T) => {
          if (!interrupted && key.startsWith('civic:topic:')) { interrupted = true; throw new Error('Injected write interruption'); }
          return store.create(key, value);
        },
      };
      const create = createAction();
      await assert.rejects(mutateCivic(fault, owner, create), /Injected write interruption/);
      const accountKey = `civic:account:${createHash('sha256').update(owner.subject).digest('hex')}`;
      const reservation = await store.get<{ creations: { topicId: string; createdAt: string }[] }>(accountKey);
      const recovered = await mutateCivic(store, owner, create);
      assert.equal(recovered.id, reservation?.creations[0].topicId);
      assert.equal(recovered.createdAt, reservation?.creations[0].createdAt);
      for (let count = 1; count < CIVIC_LIMITS.topicsPerDay; count++) await mutateCivic(store, owner, createAction());
      await rejectsCode(mutateCivic(store, owner, createAction()), 'limit_exceeded');
      assert.equal((await mutateCivic(store, owner, create)).id, recovered.id, 'retry never consumes quota');
      // Explicit old-day fixture tests the lifetime bound independently of wall-clock sleeps.
      await store.update(accountKey, (record: { creations: unknown[] }) => {
        record.creations = Array.from({ length: CIVIC_LIMITS.topicsPerAccount }, (_, index) => ({
          operationId: randomUUID(), fingerprint: `fixture-${index}`, topicId: randomUUID(), createdAt: '2000-01-01T00:00:00.000Z',
        }));
        return record;
      });
      await rejectsCode(mutateCivic(store, owner, createAction()), 'limit_exceeded');
    } finally { await store.close(); }
  });
}

test('strict action schemas reject identity spoofing, content changes, bad sources and malformed bounds', () => {
  const base = createAction(); const id = randomUUID();
  const actions = [base,
    { action: 'contribute', topicId: id, version: 1, operationId: randomUUID(), stance: 'pro', text: 'Argument', parentId: null },
    ...['ready', 'open', 'close'].map((kind) => ({ action: kind, topicId: id, version: 1, operationId: randomUUID() })),
    { action: 'vote', topicId: id, version: 1, operationId: randomUUID(), choice: 0 },
    { action: 'link-city', topicId: id, version: 1, operationId: randomUUID(), cityId: 'altlandsberg' },
  ];
  for (const valid of actions) {
    assert.doesNotThrow(() => parseCivicAction(valid));
    for (const field of ['subject', 'author', 'account', 'wallet', 'voter', 'canManage', 'result', 'votes', '__proto__'])
      assert.throws(() => parseCivicAction({ ...valid, [field]: 'spoof' }), CivicError);
    assert.throws(() => parseCivicAction({ ...valid, operationId: 'unbounded-arbitrary-key' }), CivicError);
  }
  for (const sourceUrl of ['http://example.org', 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/x', 'https://user:pass@example.org',
    'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://localhost', 'https://thing.local', 'https://example.org:8443', 'https://exa mple.org', '//example.org', 'https://example.org/\nspoof', `https://example.org/${'x'.repeat(2048)}`])
    assert.throws(() => parseCivicAction({ ...base, sourceUrl }), CivicError, sourceUrl);
  for (const bad of [null, [], true, {}, { ...base, cityId: 'roebel-mueritz' }, { ...base, context: '' }, { ...base, title: 'x'.repeat(161) },
    { ...base, context: 'x'.repeat(6001) }, { ...base, question: 'x'.repeat(501) }, { ...base, options: ['only one'] },
    { ...base, options: ['Same', 'same'] }, { ...base, options: ['yes', 'no', 'maybe', 'other', 'fifth', 'sixth'] }, { ...base, options: ['x'.repeat(161), 'no'] },
    { ...base, sourceUrl: null }, { ...base, title: 'control\u0000character' },
    { ...actions[1], version: 0 }, { ...actions[1], version: 1.5 }, { ...actions[1], version: Number.MAX_SAFE_INTEGER + 1 },
    { ...actions[1], parentId: 'missing' }, { ...actions[1], stance: 'support' }, { ...actions[1], text: 'x'.repeat(2001) },
    { ...actions[1], action: 'edit', question: 'Changed ballot' }, { ...actions[1], action: 'delete' },
    { ...actions[5], choice: -1 }, { ...actions[5], choice: 0.5 }, { ...actions[5], choice: 5 }])
    assert.throws(() => parseCivicAction(bad), CivicError);
});

test('HTTP boundary authenticates reads, enforces same-origin writes, rejects spoof fields and does not fetch source metadata', async (t) => {
  const store = new LocalStore(':memory:'); const owner = identity(); const origin = process.env.APP_ORIGIN || 'https://ledger.example.org';
  let storageCalls = 0;
  const dependencies = {
    authenticate: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer verified-test-session') throw new IdentityError('unauthenticated', 'No session');
      return owner;
    },
    store: async () => { storageCalls += 1; return store; },
  };
  const headers = { Authorization: 'Bearer verified-test-session', Origin: origin, 'Content-Type': 'application/json' };
  const request = (path: string, body?: unknown, override: HeadersInit = headers) => new Request(origin + '/api/civic' + path,
    { method: body === undefined ? 'GET' : 'POST', headers: override, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Source URLs must never be fetched'); });
  try {
    for (const unauthenticated of [request('?city=strausberg', undefined, {}), request(`?topic=${randomUUID()}`, undefined, {}), request('', createAction(), { Origin: origin, 'Content-Type': 'application/json' })]) {
      const response = await handleCivicRequest(unauthenticated, dependencies);
      assert.equal(response.status, 401); assert.equal((await response.json()).code, 'unauthorized');
    }
    assert.equal(storageCalls, 0);
    for (const unsafeOrigin of ['https://attacker.example', 'null', '']) {
      const response = await handleCivicRequest(request('', createAction(), { ...headers, Origin: unsafeOrigin }), dependencies);
      assert.equal(response.status, 403);
    }
    assert.equal(storageCalls, 0);
    const oversized = await handleCivicRequest(request('', { ...createAction(), context: 'x'.repeat(CIVIC_LIMITS.bodyBytes) }), dependencies);
    assert.equal(oversized.status, 413); assert.equal((await oversized.json()).code, 'body_too_large');
    const malformed = await handleCivicRequest(new Request(origin + '/api/civic', { method: 'POST', headers, body: '{' }), dependencies);
    assert.equal(malformed.status, 400);
    const notJson = await handleCivicRequest(request('', createAction(), { ...headers, 'Content-Type': 'text/plain' }), dependencies);
    assert.equal(notJson.status, 400);
    for (const path of ['', '?city=strausberg&city=strausberg', '?city=strausberg&cursor=x&cursor=y', '?city=strausberg&subject=spoof', `?city=strausberg&topic=${randomUUID()}`, `?topic=${randomUUID()}&topic=${randomUUID()}`])
      assert.equal((await handleCivicRequest(request(path), dependencies)).status, 400);
    assert.equal((await handleCivicRequest(request('?city=strausberg', createAction()), dependencies)).status, 400);
    assert.equal((await handleCivicRequest(request(`?topic=${randomUUID()}`), dependencies)).status, 404);
    for (const field of ['subject', 'author', 'wallet', 'votes'])
      assert.equal((await handleCivicRequest(request('', { ...createAction(), [field]: owner.subject }), dependencies)).status, 400);
    const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const created = await handleCivicRequest(request('', { ...createAction(), title: xss, context: xss, question: xss, options: [xss, 'No'] }), dependencies);
    assert.equal(created.status, 200); assert.match(created.headers.get('content-type') || '', /application\/json/);
    assert.equal(created.headers.get('x-content-type-options'), 'nosniff'); assert.match(created.headers.get('cache-control') || '', /no-store/);
    assert.equal(created.headers.get('vary'), 'Authorization');
    const { topic } = await created.json() as { topic: CivicTopic };
    assert.equal(topic.title, xss, 'plain text remains plain text; rendering must not interpret markup');
    const contributionAction = action(topic, 'contribute', { stance: 'pro', text: xss, parentId: null });
    const added = await handleCivicRequest(request('', contributionAction), dependencies);
    assert.equal(added.status, 200);
    const addition = await added.json() as { topic: CivicTopic; contributionId: string };
    assert.equal(addition.topic.contributions[0].text, xss);
    assert.equal(addition.contributionId, addition.topic.contributions[0].id);
    await mutateCivic(store, identity('another-author'), action(addition.topic, 'contribute', { stance: 'pro', text: xss, parentId: null }));
    const replay = await handleCivicRequest(request('', contributionAction), dependencies);
    const replayed = await replay.json() as { topic: CivicTopic; contributionId: string };
    assert.equal(replayed.topic.contributions.length, 2);
    assert.equal(replayed.contributionId, addition.contributionId, 'receipt identifies the original contribution even after identical later text');
    assert.equal((await handleCivicRequest(request('?city=strausberg'), dependencies)).status, 200);
    const unavailable = await handleCivicRequest(request('?city=strausberg'), { ...dependencies, store: async () => { throw new Error('PRIVATE database password'); } });
    assert.equal(unavailable.status, 503); assert.equal((await unavailable.text()).includes('PRIVATE'), false);
    const expired = await handleCivicRequest(request('?city=strausberg'), { ...dependencies, authenticate: async () => ({ ...owner, expiresAt: 0 }) });
    assert.equal(expired.status, 401);
    const identityOutage = await handleCivicRequest(request('?city=strausberg'), { ...dependencies, authenticate: async () => { throw new IdentityError('identity_unavailable', 'PRIVATE provider'); } });
    assert.equal(identityOutage.status, 503);
  } finally { await store.close(); }
});

test('two SQLite connections and restart retain one-account vote, ownership, quota and replay receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-civic-'));
  const filename = join(directory, 'records.sqlite');
  const first = new LocalStore(filename); const second = new LocalStore(filename);
  const owner = identity(); const voter = identity('voter');
  let reopened: LocalStore | undefined;
  try {
    const topic = await openTopic(first, owner);
    const vote = action(topic, 'vote', { choice: 1 });
    const results = await Promise.all([mutateCivic(first, voter, vote), mutateCivic(second, voter, vote)]);
    assert.equal(results[0].voteCount, 1); assert.equal(results[1].voteCount, 1);
    await first.close(); await second.close();
    reopened = new LocalStore(filename);
    assert.equal((await mutateCivic(reopened, voter, vote)).voteCount, 1);
    await rejectsCode(mutateCivic(reopened, voter, action(topic, 'vote', { choice: 0 })), 'already_voted');
    const closed = await mutateCivic(reopened, owner, action(topic, 'close'));
    assert.deepEqual(closed.result?.counts, [0, 1]);
    assert.equal((await readCivicTopic(reopened, voter, topic.id)).canManage, false);
    for (let index = 1; index < CIVIC_LIMITS.topicsPerDay; index++) await mutateCivic(reopened, owner, createAction());
    await rejectsCode(mutateCivic(reopened, owner, createAction()), 'limit_exceeded');
  } finally {
    if (reopened) await reopened.close();
    else { await first.close(); await second.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const backend of stores) {
  test(`${backend.name}: City AI triggers require stored authored tags and replies stay labelled, idempotent and frozen`, async () => {
    const store = backend.create(); const owner = identity(); const outsider = identity('other');
    try {
      let topic = await mutateCivic(store, owner, { ...createAction(), context: '@city-ai Please summarize the sourced trade-offs.' });
      assert.equal(topic.canRequestAi, true);
      assert.equal((await readCivicTopic(store, outsider, topic.id)).canRequestAi, undefined);
      const triggerInput = { topicId: topic.id, contributionId: null };
      await rejectsCode(resolveCivicAiTrigger(store, outsider, triggerInput), 'forbidden');
      const trigger = await resolveCivicAiTrigger(store, owner, triggerInput);
      assert.equal(trigger.accountId, createHash('sha256').update(owner.subject).digest('hex'));
      assert.equal(trigger.topicBody, topic.context); assert.equal(trigger.topicQuestion, topic.question);
      assert.equal(trigger.topicStatus, 'discussion');
      assert.equal((await resolveCivicAiTrigger(store, outsider, triggerInput, false)).accountId, trigger.accountId);
      const append = {
        requestId: randomUUID(), topicId: topic.id, contributionId: null,
        text: 'The source describes a planning proposal, not an adopted decision. [S1]', model: 'test-contract-model',
        sources: [{ id: 'S1', title: 'Published council context', url: 'https://www.strausberg.de/', asOf: '2026-09-27', kind: 'agenda', reviewState: 'candidate' }],
        generatedAt: new Date().toISOString(),
      };
      await Promise.all([appendCivicAiContribution(store, append), appendCivicAiContribution(store, append)]);
      topic = await readCivicTopic(store, owner, topic.id);
      assert.equal(topic.contributions.length, 1); assert.equal(topic.version, 2);
      const reply = topic.contributions[0];
      assert.equal(reply.stance, 'discussion'); assert.equal(reply.parentId, null); assert.equal(reply.canRequestAi, undefined);
      assert.equal(reply.ai?.authority, 'none'); assert.equal(reply.ai?.provider, 'ledger-library');
      assert.equal(reply.ai?.jobId, append.requestId); assert.deepEqual(reply.ai?.sources, append.sources);
      assert.equal(JSON.stringify(reply).includes('aiFingerprint'), false);
      await rejectsCode(mutateCivic(store, owner, action(topic, 'ready')), 'not_ready');
      await rejectsCode(appendCivicAiContribution(store, { ...append, text: 'Different output' }), 'idempotency_conflict');
      await rejectsCode(resolveCivicAiTrigger(store, owner, { topicId: topic.id, contributionId: reply.id }), 'forbidden');
      await rejectsCode(resolveCivicAiTrigger(store, owner, { topicId: topic.id, contributionId: reply.id }, false), 'invalid_request');
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: '@Mecky Compare the benefits.', parentId: null }));
      const authored = topic.contributions.at(-1)!;
      assert.equal(authored.canRequestAi, true);
      assert.equal((await readCivicTopic(store, outsider, topic.id)).contributions.at(-1)?.canRequestAi, undefined);
      await rejectsCode(resolveCivicAiTrigger(store, outsider, { topicId: topic.id, contributionId: authored.id }), 'forbidden');
      assert.equal((await resolveCivicAiTrigger(store, owner, { topicId: topic.id, contributionId: authored.id })).triggerText, authored.text);
      topic = await mutateCivic(store, outsider, action(topic, 'contribute', { stance: 'con', text: 'The costs are unknown.', parentId: null }));
      await rejectsCode(resolveCivicAiTrigger(store, outsider, { topicId: topic.id, contributionId: topic.contributions.at(-1)!.id }), 'invalid_request');
      topic = await mutateCivic(store, owner, action(topic, 'ready'));
      assert.equal(topic.canRequestAi, undefined); assert.equal(topic.contributions.find((item) => item.id === authored.id)?.canRequestAi, undefined);
      assert.equal((await resolveCivicAiTrigger(store, owner, triggerInput)).topicStatus, 'ready', 'existing jobs can reconcile their status after freeze');
      await appendCivicAiContribution(store, append);
      await rejectsCode(appendCivicAiContribution(store, { ...append, requestId: randomUUID() }), 'invalid_phase');
      topic = await mutateCivic(store, owner, action(topic, 'open'));
      await rejectsCode(appendCivicAiContribution(store, { ...append, requestId: randomUUID() }), 'invalid_phase');
      topic = await mutateCivic(store, owner, action(topic, 'close'));
      assert.equal(topic.result?.hash, civicResultHash(topic, topic.result!));
      const changed = structuredClone(topic);
      changed.contributions[0].ai!.sources[0].reviewState = 'reviewed';
      assert.notEqual(topic.result?.hash, civicResultHash(changed, topic.result!));
      await appendCivicAiContribution(store, append);
      await rejectsCode(appendCivicAiContribution(store, { ...append, requestId: randomUUID() }), 'invalid_phase');
      await rejectsCode(mutateCivic(store, owner, action(topic, 'contribute', {
        stance: 'discussion', text: 'Spoofed assistant', parentId: null, ai: reply.ai,
      })), 'invalid_request');
    } finally { await store.close(); }
  });

  test(`${backend.name}: City AI source bounds and ready/append race never change a frozen ballot`, async () => {
    const store = backend.create(); const owner = identity();
    try {
      let topic = await mutateCivic(store, owner, { ...createAction(), context: 'Email local@city-ai.example is not an intentional tag.' });
      await rejectsCode(resolveCivicAiTrigger(store, owner, { topicId: topic.id, contributionId: null }), 'invalid_request');
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'pro', text: '@city-ai Explain the evidence.', parentId: null }));
      const triggerId = topic.contributions[0].id;
      topic = await mutateCivic(store, owner, action(topic, 'contribute', { stance: 'con', text: 'Coverage is incomplete.', parentId: null }));
      const append = {
        requestId: randomUUID(), topicId: topic.id, contributionId: triggerId, text: 'A sourced reply. [S1]', model: 'test-contract-model',
        sources: [{ id: 'S1', title: 'Source', url: 'https://example.org/', asOf: '2026-09-27', kind: 'agenda', reviewState: 'candidate' }],
        generatedAt: new Date().toISOString(),
      };
      for (const invalid of [
        { ...append, sources: [] }, { ...append, sources: Array.from({ length: 4 }, () => append.sources[0]) },
        { ...append, sources: [{ ...append.sources[0], url: 'javascript:alert(1)' }] },
        { ...append, sources: [{ ...append.sources[0], asOf: 'x'.repeat(65) }] },
        { ...append, text: 'x'.repeat(2001) }, { ...append, generatedAt: 'not-a-date' },
      ]) await rejectsCode(appendCivicAiContribution(store, invalid), 'invalid_request');
      const [ready, ai] = await Promise.allSettled([
        mutateCivic(store, owner, action(topic, 'ready')), appendCivicAiContribution(store, append),
      ]);
      assert.equal([ready, ai].filter((result) => result.status === 'fulfilled').length, 1);
      const current = await readCivicTopic(store, owner, topic.id);
      if (ready.status === 'fulfilled') {
        assert.equal(current.phase, 'ready'); assert.equal(current.contributions.length, 2);
      } else {
        assert.equal(current.phase, 'discussion'); assert.equal(current.contributions.length, 3);
        assert.ok(ready.reason instanceof CivicError && ready.reason.code === 'version_conflict');
      }
    } finally { await store.close(); }
  });
}
