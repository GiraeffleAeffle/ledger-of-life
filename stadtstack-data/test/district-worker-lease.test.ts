import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { startWorkerLease, finishWorkerLease, startWorkerHeartbeat, WORKER_CONTROL_BYTES, WORKER_HEARTBEAT, WORKER_HEARTBEAT_MS, WORKER_LEASE_MS } from '../src/district-worker-lease.ts';
import { inferPreparedDocument } from '../src/district-inference.ts';
import { prepareDocument } from '../src/district-prepared-document.ts';
import { sha256 } from '../src/district-schema.ts';
import { createCivicPolicyTestContext } from './fixtures/civic-policy.ts';

const control = z.object({ task: z.literal('authorized-task') }).strict();
const frame = JSON.stringify({ task: 'authorized-task' }) + '\n';
function assertClean(input: PassThrough, signals: EventEmitter) {
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0, event);
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(event), 0, event);
  assert.equal(input.isPaused(), true);
}
function assertAborted(input: PassThrough, signals: EventEmitter) {
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0, event);
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(event), 1, event);
  assert.equal(input.isPaused(), true);
}

test('worker lease accepts split control and fixed heartbeats, expires after last heartbeat and cleans up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  try {
    input.write(frame.slice(0, 8)); input.write(frame.slice(8));
    assert.deepEqual(await lease.control, { task: 'authorized-task' });
    let cancellations = 0;
    lease.signal.addEventListener('abort', () => cancellations++, { once: true });
    t.mock.timers.tick(WORKER_LEASE_MS - 1);
    input.write(WORKER_HEARTBEAT);
    t.mock.timers.tick(WORKER_LEASE_MS - 1);
    assert.equal(lease.signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(lease.signal.aborted, true);
    assert.match(lease.signal.reason.message, /expired/);
    assert.equal(cancellations, 1);
    assertAborted(input, signals);
    t.mock.timers.tick(WORKER_LEASE_MS * 2);
    assert.equal(cancellations, 1);
  } finally { lease.dispose(); assertClean(input, signals); input.destroy(); }
});

test('worker lease deadline also bounds a missing or partial initial control', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  const rejection = assert.rejects(lease.control, /expired/);
  input.write('{'); t.mock.timers.tick(WORKER_LEASE_MS);
  await rejection;
  assert.equal(lease.signal.aborted, true);
  assertAborted(input, signals); lease.dispose(); assertClean(input, signals); input.destroy();
});

test('worker EOF aborts before control and cancels already admitted work', async () => {
  for (const admitted of [false, true]) {
    const input = new PassThrough(), signals = new EventEmitter();
    const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
    const rejection = admitted ? undefined : assert.rejects(lease.control, /ended/);
    try {
      if (admitted) { input.write(frame); await lease.control; }
      const cancelled = new Promise<void>(resolve => lease.signal.addEventListener('abort', () => resolve(), { once: true }));
      input.end(); await cancelled; await rejection;
      assert.equal(lease.signal.aborted, true);
      assertAborted(input, signals);
    } finally { lease.dispose(); assertClean(input, signals); input.destroy(); }
  }
});

test('malformed, unexpected and oversized control/heartbeat frames fail closed without their contents', async () => {
  for (const [initial, invalid] of [
    ['', 'private-source-not-json\n'], ['', '{"task":"private-source"}\n'],
    ['', 'x'.repeat(WORKER_CONTROL_BYTES + 1)], [frame, '{"task":"authorized-task"}\n'],
    [frame, 'heartbeat\r\n'], [frame, 'x'.repeat(WORKER_CONTROL_BYTES + 1)],
  ]) {
    const input = new PassThrough(), signals = new EventEmitter();
    const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
    const rejection = initial ? undefined : assert.rejects(lease.control, /invalid|bound/);
    try {
      if (initial) { input.write(initial); await lease.control; }
      input.write(invalid); await rejection;
      assert.equal(lease.signal.aborted, true);
      assert.doesNotMatch(lease.signal.reason.message, /private-source/);
      assertAborted(input, signals);
    } finally { lease.dispose(); assertClean(input, signals); input.destroy(); }
  }
});

test('signal, stream error and transport close abort input while retaining termination handlers', async () => {
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'error', 'close']) {
    const input = new PassThrough(), signals = new EventEmitter();
    const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
    try {
      input.write(frame); await lease.control;
      if (event === 'error') input.emit(event, Error('private transport details'));
      else if (event === 'close') input.emit(event);
      else signals.emit(event);
      assert.equal(lease.signal.aborted, true);
      assert.doesNotMatch(lease.signal.reason.message, /private transport/);
      assertAborted(input, signals);
    } finally { lease.dispose(); assertClean(input, signals); input.destroy(); }
  }
});

test('normal completion disposes lease timer and signal listeners without cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  input.write(frame); await lease.control;
  lease.dispose(); lease.dispose();
  assertClean(input, signals);
  t.mock.timers.tick(WORKER_LEASE_MS * 2); signals.emit('SIGTERM');
  assert.equal(lease.signal.aborted, false); input.destroy();
});

test('coordinator sends one control followed by heartbeats, keeps stdin open and disposes interval', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const output = new PassThrough(); let failure = 0;
  const dispose = startWorkerHeartbeat(output, { task: 'authorized-task' }, () => failure++);
  assert.equal(output.read().toString(), frame);
  assert.equal(output.writableEnded, false);
  t.mock.timers.tick(WORKER_HEARTBEAT_MS);
  assert.equal(output.read().toString(), WORKER_HEARTBEAT);
  dispose(); t.mock.timers.tick(WORKER_HEARTBEAT_MS * 2);
  assert.equal(output.read(), null); assert.equal(failure, 0); assert.equal(output.listenerCount('error'), 0);
  assert.throws(() => startWorkerHeartbeat(output, 'x'.repeat(WORKER_CONTROL_BYTES + 1), () => {}), /bound/);
  output.destroy();
});

test('coordinator heartbeat failure cleans interval and reports only controlled failure', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const output = new PassThrough(); let failures = 0;
  const dispose = startWorkerHeartbeat(output, { task: 'authorized-task' }, () => failures++);
  output.read(); output.emit('error', Error('private connection details'));
  t.mock.timers.tick(WORKER_HEARTBEAT_MS * 2);
  assert.equal(failures, 1); assert.equal(output.read(), null); assert.equal(output.listenerCount('error'), 0);
  dispose(); output.destroy();
});

test('lease AbortSignal reaches prepared inference and halts before readiness or model calls', async t => {
  const fixture = await createCivicPolicyTestContext(t);
  const bytes = Buffer.from('Synthetic municipal document for cancellation-path testing only. No real public claim, date, person or model response is asserted by this fixture.');
  const prepared = await prepareDocument({ bytes, municipalityId: 'strausberg', mimeType: 'text/plain', extractorSha256: sha256('extractor'), toolVersions: { node: process.versions.node }, references: [{ id: 'source', url: 'https://example.org/source', sha256: sha256(bytes), retrievedAt: '2026-10-01T00:00:00.000Z', locator: 'source', mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } }] }, async () => { throw Error('Synthetic text fixture must not execute parser commands'); });
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  try {
    input.write(frame); await lease.control; signals.emit('SIGTERM');
    await assert.rejects(inferPreparedDocument({ taskId: sha256('task'), groupId: sha256('group'), purpose: 'production', provider: 'openai-subscription', municipality: { id: 'strausberg', name: 'Strausberg', ags: '12064472', districtId: 'maerkisch-oderland' }, prepared, expected: prepared, contract: { promptSha256: sha256('prompt'), schemaSha256: sha256('schema') }, out: 'unused-no-model-call', policy: fixture.policy, usage: { ledgerPath: 'unused-ledger', pausePath: 'unused-pause', signal: lease.signal } }), error => error === lease.signal.reason);
    assertAborted(input, signals);
  } finally { lease.dispose(); assertClean(input, signals); input.destroy(); }
});

test('repeated EOF and signals stay handled through inference close and every async lock release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  input.write(frame); await lease.control;
  const inferenceClosed = Promise.withResolvers<void>();
  const groupStarted = Promise.withResolvers<void>(), groupReleased = Promise.withResolvers<void>();
  const taskStarted = Promise.withResolvers<void>(), taskReleased = Promise.withResolvers<void>();
  const order: string[] = [];
  let cancellations = 0;
  lease.signal.addEventListener('abort', () => { cancellations++; }, { once: true });
  const worker = (async () => {
    try { await inferenceClosed.promise; order.push('inference closed'); }
    finally {
      await finishWorkerLease(lease, [
        async () => { order.push('task releasing'); taskStarted.resolve(); await taskReleased.promise; order.push('task released'); },
        async () => { order.push('group releasing'); groupStarted.resolve(); await groupReleased.promise; order.push('group released'); },
      ]);
    }
  })();
  const repeatTermination = () => {
    input.emit('end'); input.emit('close');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.emit(signal), true, signal);
    assertAborted(input, signals);
    assert.equal(cancellations, 1);
    assert.match(lease.signal.reason.message, /ended/);
  };
  try {
    input.emit('end'); repeatTermination();
    t.mock.timers.tick(WORKER_LEASE_MS * 2);
    assert.deepEqual(order, []);
    inferenceClosed.resolve(); await groupStarted.promise;
    repeatTermination(); assert.deepEqual(order, ['inference closed', 'group releasing']);
    groupReleased.resolve(); await taskStarted.promise;
    repeatTermination(); assert.deepEqual(order, ['inference closed', 'group releasing', 'group released', 'task releasing']);
    taskReleased.resolve(); await worker;
    assert.deepEqual(order, ['inference closed', 'group releasing', 'group released', 'task releasing', 'task released']);
    assertClean(input, signals);
    lease.dispose(); assert.equal(signals.emit('SIGTERM'), false);
  } finally {
    inferenceClosed.resolve(); groupReleased.resolve(); taskReleased.resolve();
    await worker; lease.dispose(); input.destroy();
  }
});

test('async worker finally attempts all lock releases before disposal even when releases fail', async () => {
  const input = new PassThrough(), signals = new EventEmitter();
  const lease = startWorkerLease(input, raw => control.parse(raw), { signals });
  input.write(frame); await lease.control;
  const lastStarted = Promise.withResolvers<void>(), lastReleased = Promise.withResolvers<void>();
  const groupError = Error('synthetic group release failure'), taskError = Error('synthetic task release failure');
  const order: string[] = [];
  const finishing = finishWorkerLease(lease, [
    async () => { order.push('task'); lastStarted.resolve(); await lastReleased.promise; throw taskError; },
    async () => { order.push('group'); throw groupError; },
  ]);
  const rejected = assert.rejects(finishing, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [groupError, taskError]);
    return true;
  });
  try {
    await lastStarted.promise;
    assert.deepEqual(order, ['group', 'task']);
    assert.equal(signals.emit('SIGTERM'), true);
    assert.equal(signals.emit('SIGHUP'), true);
    assertAborted(input, signals);
    lastReleased.resolve(); await rejected;
    assertClean(input, signals);
  } finally { lastReleased.resolve(); await rejected; lease.dispose(); input.destroy(); }
});
