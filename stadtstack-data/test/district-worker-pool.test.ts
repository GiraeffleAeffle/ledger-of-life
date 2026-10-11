import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createWorkPlan, restoreWorkPlan, resumeWorkPlanProviders, runWorkPlan, workerCapacity, type WorkPlan, type WorkTask } from '../src/district-work-plan.ts';
import { projectQuota, readQuotaMetadata, startQuotaMonitor } from '../src/district-worker-quota.ts';
import { checkResult } from '../src/district-extract.ts';
import { documentResultSchema } from '../src/district-inference.ts';
import { sha256 } from '../src/district-schema.ts';

const contract = { promptSha256: sha256('synthetic prompt'), schemaSha256: sha256('synthetic schema'), extractorSha256: sha256('synthetic implementation') };
function planFixture() {
  return createWorkPlan(Array.from({ length: 100 }, (_, index) => ({ municipalityId: 'strausberg', sourceSha256: sha256(`synthetic source ${index}`), preparedSha256: sha256(`synthetic prepared ${index}`) })), contract);
}
function receipt(task: Readonly<WorkTask>) {
  return { resultSha256: sha256(task.id), preparedSha256: task.group.preparedSha256, ...contract };
}
function quotaFixture(status = 'ok', usedFraction = 0.2, now = Date.now()) {
  return { generatedAt: now, reports: [{ provider: 'anthropic', fetchedAt: now, limits: [{ status, amount: { usedFraction, remainingFraction: 1 - usedFraction } }], metadata: { accountId: 'synthetic-private-identifier' } }], accountsWithoutUsage: [], disabledCredentials: [] };
}

test('document pool caps Anthropic at four and VM at one with serialized durable assignments and group exclusion', async () => {
  const plan = planFixture(), active = workerCapacity(1), peak = workerCapacity(1);
  active['openai-subscription'] = active['anthropic-subscription'] = 0;
  peak['openai-subscription'] = peak['anthropic-subscription'] = 0;
  const assigned = new Set<string>(), groups = new Set<string>(), barrier = Promise.withResolvers<void>();
  let durable: WorkPlan | undefined, writing = false;
  await runWorkPlan(plan, async task => {
    assert.equal(durable!.tasks.find(saved => saved.id === task.id)!.state, 'running');
    assert.ok(!assigned.has(task.id)); assigned.add(task.id);
    assert.ok(!groups.has(task.groupId)); groups.add(task.groupId);
    active[task.provider]++; peak[task.provider] = Math.max(peak[task.provider], active[task.provider]);
    if (active['anthropic-subscription'] === 4 && active['openai-subscription'] === 1) barrier.resolve();
    await barrier.promise; await turn();
    active[task.provider]--; groups.delete(task.groupId);
    return receipt(task);
  }, async snapshot => {
    assert.equal(writing, false); writing = true; await turn(); durable = snapshot; writing = false;
  }, async () => false, { anthropicWorkers: 4 });
  assert.deepEqual(peak, workerCapacity(4));
  assert.equal(assigned.size, plan.tasks.length);
  assert.deepEqual(durable, plan);
  for (const invalid of [0, 5, 1.5, NaN]) assert.throws(() => workerCapacity(invalid));
  assert.deepEqual(workerCapacity(), { 'openai-subscription': 1, 'anthropic-subscription': 1 });
});

test('one provider failure cancels sibling workers and preserves pending assignments without retry or reroute', async () => {
  const plan = planFixture(), barrier = Promise.withResolvers<void>();
  let anthropicCalls = 0;
  await runWorkPlan(plan, async (task, _contract, signal) => {
    if (task.provider === 'openai-subscription') return receipt(task);
    const number = ++anthropicCalls;
    if (number === 4) barrier.resolve();
    await barrier.promise;
    if (number === 1) throw Object.assign(Error('synthetic rate limit'), { failureCategory: 'quota' });
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return receipt(task);
  }, async () => {}, async () => false, { anthropicWorkers: 4 });
  assert.equal(anthropicCalls, 4);
  assert.equal(plan.providers['anthropic-subscription'], 'paused');
  assert.ok(plan.tasks.some(task => task.provider === 'anthropic-subscription' && task.state === 'pending'));
  assert.ok(plan.tasks.filter(task => task.provider === 'openai-subscription').every(task => task.state === 'completed'));
  assert.equal(plan.tasks.filter(task => task.failureCategory === 'quota').length, 1);
});

test('coordinator cancellation waits for all active workers and dual resume remains explicit', async () => {
  const plan = planFixture(), controller = new AbortController();
  let started = 0, stopped = 0;
  await runWorkPlan(plan, async (_task, _contract, signal) => {
    started++;
    if (started === 5) controller.abort(Object.assign(Error('synthetic operator cancellation'), { failureCategory: 'operator_pause' }));
    try {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw Error('unreachable');
    } finally { stopped++; }
  }, async () => {}, async () => false, { anthropicWorkers: 4, signal: controller.signal });
  assert.equal(started, 5); assert.equal(stopped, 5);
  const restored = restoreWorkPlan(plan);
  assert.deepEqual(restored.providers, { 'openai-subscription': 'paused', 'anthropic-subscription': 'paused' });
  resumeWorkPlanProviders(restored, []);
  assert.ok(restored.tasks.some(task => task.state === 'failed'));
  resumeWorkPlanProviders(restored, ['anthropic-subscription', 'openai-subscription', 'anthropic-subscription']);
  assert.ok(restored.tasks.every(task => task.state === 'pending'));
  assert.deepEqual(restored.providers, { 'openai-subscription': 'ready', 'anthropic-subscription': 'ready' });
});

test('durability failure prevents undisclosed assignments and stops active workers', async () => {
  const plan = planFixture(); let calls = 0, writes = 0;
  await assert.rejects(runWorkPlan(plan, async () => { calls++; throw Error('must not execute'); }, async () => {
    if (++writes === 2) throw Error('synthetic disk failure');
  }, async () => false, { anthropicWorkers: 4 }), /recover durable state/);
  assert.equal(calls, 0);
});

test('completed results are not rerun and cached results cannot be relabelled or rebound', async () => {
  const plan = planFixture(), task = plan.tasks[0];
  task.state = 'completed'; task.resultSha256 = sha256('synthetic completed bytes');
  const result = documentResultSchema.parse({ schemaVersion: 'stadtstack-document-result-v2', taskId: task.id, groupId: task.groupId, provider: task.provider, purpose: task.purpose, municipalityId: task.group.municipalityId, sourceSha256: task.group.sourceSha256, preparedSha256: task.group.preparedSha256, promptSha256: contract.promptSha256, schemaSha256: contract.schemaSha256, generatedAt: '2026-10-11T00:00:00.000Z', records: [], quarantine: [], chunks: [] });
  checkResult(result, task, plan);
  for (const field of ['taskId', 'groupId', 'sourceSha256', 'preparedSha256', 'promptSha256', 'schemaSha256'] as const) assert.throws(() => checkResult({ ...result, [field]: sha256('wrong') }, task, plan), /mismatch/);
  assert.throws(() => checkResult({ ...result, provider: task.provider === 'openai-subscription' ? 'anthropic-subscription' : 'openai-subscription' }, task, plan), /mismatch/);
  await runWorkPlan(plan, async next => { assert.notEqual(next.id, task.id); return receipt(next); }, async () => {}, async () => false, { anthropicWorkers: 4 });
  assert.equal(task.resultSha256, sha256('synthetic completed bytes'));
});

test('quota projection discards identifiers and fails closed on stale, malformed or ambiguous reports', () => {
  const now = Date.now(), projected = projectQuota(quotaFixture('ok', 0.2, now), now);
  assert.deepEqual(projected, { state: 'healthy', checkedAt: now, maxUsedFraction: 0.2, limitCount: 1 });
  assert.ok(!JSON.stringify(projected).includes('synthetic-private'));
  assert.equal(projectQuota(quotaFixture('warning'), now).state, 'warning');
  assert.equal(projectQuota(quotaFixture('ok', 0.8), now).state, 'warning');
  assert.equal(projectQuota(quotaFixture('ok', 0.2, now - 90_001), now).state, 'unknown');
  assert.equal(projectQuota(null, now).state, 'unknown');
  const ambiguous = quotaFixture(); ambiguous.reports.push(ambiguous.reports[0]);
  assert.equal(projectQuota(ambiguous, now).state, 'unknown');
});

test('single monitor downshifts unknown initial capacity and never scales it back up automatically', async () => {
  const controller = new AbortController(), second = Promise.withResolvers<void>(); let reads = 0, active = 0;
  const monitor = await startQuotaMonitor({ requestedWorkers: 4, signal: controller.signal, intervalMs: 1,
    read: async () => { assert.equal(active++, 0); await turn(); active--; return ++reads === 1 ? null : quotaFixture(); },
    pause: async () => { assert.fail('unknown initial metadata must cap rather than retry or scale'); },
    persist: async () => { if (reads === 2) second.resolve(); },
  });
  try {
    assert.equal(monitor.capacity()['anthropic-subscription'], 1);
    await second.promise;
    assert.equal(monitor.capacity()['anthropic-subscription'], 1);
  } finally { await monitor.dispose(); }
});

test('warning or monitor loss after scaling pauses every new worker and requires explicit resume', async () => {
  for (const next of [quotaFixture('warning'), null, quotaFixture('ok', 0.2, Date.now() - 90_001)]) {
    const controller = new AbortController(), paused = Promise.withResolvers<void>(); let reads = 0, pauses = 0;
    const monitor = await startQuotaMonitor({ requestedWorkers: 4, signal: controller.signal, intervalMs: 1,
      read: async () => ++reads === 1 ? quotaFixture() : next,
      pause: async () => { pauses++; }, persist: async summary => { if (summary.effectiveWorkers === 0) paused.resolve(); },
    });
    try {
      assert.equal(monitor.capacity()['anthropic-subscription'], 4);
      await paused.promise;
      assert.equal(monitor.capacity()['anthropic-subscription'], 0); assert.equal(pauses, 1);
      const plan = planFixture(); let anthropicCalls = 0;
      await runWorkPlan(plan, async task => { if (task.provider === 'anthropic-subscription') anthropicCalls++; return receipt(task); }, async () => {}, async () => false, { anthropicWorkers: 4, capacity: monitor.capacity });
      assert.equal(anthropicCalls, 0); assert.equal(plan.providers['anthropic-subscription'], 'paused');
    } finally { await monitor.dispose(); }
  }
});

test('a shared quota warning cancels an already active four-worker pool without another assignment', async () => {
  const plan = planFixture(), controller = new AbortController(), full = Promise.withResolvers<void>();
  let reads = 0, started = 0, stopped = 0, marker = false;
  const monitor = await startQuotaMonitor({
    requestedWorkers: 4, signal: controller.signal, intervalMs: 1,
    read: async () => { if (++reads === 1) return quotaFixture(); await full.promise; return quotaFixture('warning'); },
    pause: async () => { marker = true; }, persist: async () => {},
  });
  try {
    await runWorkPlan(plan, async (task, _contract, signal) => {
      if (task.provider === 'openai-subscription') return receipt(task);
      if (++started === 4) full.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw Error('unreachable');
      } finally { stopped++; }
    }, async () => {}, async provider => provider === 'anthropic-subscription' && marker, { anthropicWorkers: 4, capacity: monitor.capacity });
    assert.equal(started, 4); assert.equal(stopped, 4); assert.equal(marker, true);
    assert.equal(plan.providers['anthropic-subscription'], 'paused');
    assert.ok(plan.tasks.some(task => task.provider === 'anthropic-subscription' && task.state === 'pending'));
  } finally { await monitor.dispose(); }
});

test('quota polling invalidates the CLI cache before its single fresh query', async () => {
  const calls: string[][] = [], stale = quotaFixture('ok', 0.28, Date.now() - 120_000);
  let cached = stale;
  const raw = await readQuotaMetadata(new AbortController().signal, async args => {
    calls.push(args);
    if (args[1] === 'invalidate') { cached = quotaFixture('ok', 0.28); return { ok: true, output: 'cache invalidated' }; }
    return { ok: true, output: JSON.stringify(cached) };
  });
  assert.deepEqual(calls, [
    ['usage', 'invalidate', '--provider', 'anthropic', '--no-extensions'],
    ['usage', '--provider', 'anthropic', '--json', '--no-extensions'],
  ]);
  assert.equal(projectQuota(stale).state, 'unknown');
  assert.equal(projectQuota(raw).state, 'healthy');
  const stillCached = await readQuotaMetadata(new AbortController().signal, async args => ({ ok: true, output: args[1] === 'invalidate' ? '' : JSON.stringify(stale) }));
  assert.equal(projectQuota(stillCached).state, 'unknown');
});

test('quota invalidation and query failures never reuse cached healthy metadata', async () => {
  for (const failure of ['invalidate', 'query', 'malformed'] as const) {
    let calls = 0;
    const raw = await readQuotaMetadata(new AbortController().signal, async args => {
      calls++;
      if (args[1] === 'invalidate') return { ok: failure !== 'invalidate', output: '' };
      return { ok: failure !== 'query', output: failure === 'malformed' ? 'invalid json' : JSON.stringify(quotaFixture()) };
    });
    assert.equal(raw, null);
    assert.equal(calls, failure === 'invalidate' ? 1 : 2);
    assert.equal(projectQuota(raw).state, 'unknown');
  }
});

test('quota cancellation stops before invalidation, between commands, and after a cancelled query', async () => {
  for (const abortAt of [0, 1, 2]) {
    const controller = new AbortController(); let calls = 0;
    if (abortAt === 0) controller.abort(Error('synthetic cancellation'));
    await assert.rejects(readQuotaMetadata(controller.signal, async (_args, signal) => {
      assert.equal(signal, controller.signal);
      if (++calls === abortAt) controller.abort(Error('synthetic cancellation'));
      return { ok: true, output: JSON.stringify(quotaFixture()) };
    }), /synthetic cancellation/);
    assert.equal(calls, abortAt);
  }
});

test('explicit owner-watched quota policy keeps unknown metadata honest and native failures fail closed', async () => {
  const controller = new AbortController();
  let reads = 0, pauses = 0;
  const monitor = await startQuotaMonitor({
    requestedWorkers: 4, ownerWatchesQuota: true, signal: controller.signal,
    read: async () => { reads++; return null; },
    pause: async () => { pauses++; }, persist: async summary => {
      assert.equal(summary.state, 'unknown');
      assert.equal(summary.maxUsedFraction, null);
      assert.equal(summary.effectiveWorkers, 4);
    },
  });
  assert.equal(reads, 0); assert.equal(pauses, 0);
  assert.equal(monitor.summary().policy, 'owner-watched');
  assert.equal(monitor.capacity()['anthropic-subscription'], 4);
  const plan = planFixture();
  await runWorkPlan(plan, async task => {
    if (task.provider === 'anthropic-subscription') throw Object.assign(Error('Native auth failure'), { failureCategory: 'subscription_authentication' });
    return receipt(task);
  }, async () => {}, async () => false, { anthropicWorkers: 4, capacity: monitor.capacity });
  assert.equal(plan.providers['anthropic-subscription'], 'paused');
  assert.ok(plan.tasks.some(task => task.provider === 'anthropic-subscription' && task.state === 'pending'));
  controller.abort();
  assert.equal(monitor.capacity()['anthropic-subscription'], 0);
  assert.equal(monitor.summary().paused, true);
  await monitor.dispose();
});
