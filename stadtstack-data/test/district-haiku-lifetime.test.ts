import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { HAIKU_SANDBOX_PROFILE } from '../src/district-haiku-bridge.ts';
import { HAIKU_LIFETIME_VERSION, HAIKU_LIFETIME_TEARDOWN_MS, superviseHaikuLifetime, type HaikuLifetimeAck, type HaikuLifetimeLaunch, type HaikuLifetimeProcess } from '../src/district-haiku-lifetime.ts';

// Pure descriptor/process/clock fixtures: no sandbox, model, filesystem or real
// process is executed. Native fork/setsid/reparent denial remains a Main probe.
function lifetimeFixture(options: { stubbornGroup?: boolean; cannotInspect?: boolean } = {}) {
  const lifeline = new PassThrough(), control = new PassThrough(), acknowledge = new PassThrough();
  const model = Object.assign(new EventEmitter(), { pid: 424242 });
  const acks: HaikuLifetimeAck[] = [], launches: HaikuLifetimeLaunch[] = [], kills: number[] = [], finished: boolean[] = [];
  const deadlines = new Map<number, { at: number; fn: () => void }>();
  let now = 0, id = 0, groupAlive = true;
  acknowledge.on('data', chunk => { acks.push(JSON.parse(chunk.toString())); });
  const supervisor = superviseHaikuLifetime({ lifeline, control, acknowledge }, {
    spawn: launch => { launches.push(launch); return model as unknown as HaikuLifetimeProcess; },
    killGroup: pid => { kills.push(pid); if (!options.stubbornGroup) groupAlive = false; },
    groupExists: () => { if (options.cannotInspect) throw Error('synthetic inspection failure'); return groupAlive; },
    now: () => now,
    timeout: (fn, ms) => { const handle = ++id; deadlines.set(handle, { at: now + ms, fn }); return handle; },
    clearTimeout: handle => { deadlines.delete(handle as number); },
    finished: gone => { finished.push(gone); },
  });
  return { lifeline, control, acknowledge, model, acks, launches, kills, finished, supervisor,
    launch(extra: Partial<HaikuLifetimeLaunch> = {}) {
      control.write(JSON.stringify({ operation: 'launch', executable: '/usr/bin/sandbox-exec', args: ['-p', HAIKU_SANDBOX_PROFILE, '/fixed/claude'],
        env: { HOME: '/approved/account' }, timeoutMs: 100, leaseMs: 60, freshnessMs: 20, ...extra }) + '\n');
      model.emit('spawn');
    },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        const next = [...deadlines.entries()].filter(([, deadline]) => deadline.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; deadlines.delete(next[0]); next[1].fn();
      }
      now = target;
    },
    groupGone() { groupAlive = false; },
    dispose() { lifeline.destroy(); control.destroy(); acknowledge.destroy(); },
  };
}

test('dedicated parent lifeline EOF independently kills source-bearing group after bridge death', async () => {
  const f = lifetimeFixture(); f.launch();
  assert.deepEqual(f.acks, [{ version: HAIKU_LIFETIME_VERSION, state: 'ready' }]);
  const ended = once(f.lifeline, 'end'); f.lifeline.end(); await ended;
  assert.deepEqual(f.kills, [f.model.pid]);
  assert.deepEqual(f.acks.at(-1), { version: HAIKU_LIFETIME_VERSION, state: 'closed', code: null, treeGone: true });
  assert.deepEqual(f.finished, [true]); f.dispose();
});

test('normal leader exit kills descendants that closed stdout and delays ACK until group absence', () => {
  const f = lifetimeFixture({ stubbornGroup: true }); f.launch();
  // Stream/close notifications alone do not prove that the process group died.
  f.model.emit('close', 0); assert.equal(f.acks.length, 1);
  f.model.emit('exit', 0);
  assert.deepEqual(f.kills, [f.model.pid]); assert.equal(f.acks.length, 1);
  f.advance(20); assert.equal(f.acks.length, 1);
  f.groupGone(); f.advance(20);
  assert.deepEqual(f.acks.at(-1), { version: HAIKU_LIFETIME_VERSION, state: 'closed', code: 0, treeGone: true });
  assert.deepEqual(f.finished, [true]); f.dispose();
});

test('independent lease deadline and authenticated-check freshness deadline stop stalled bridge work', () => {
  for (const freshness of [false, true]) {
    const f = lifetimeFixture(); f.launch({ leaseMs: 60, freshnessMs: freshness ? 20 : 0 });
    f.advance(freshness ? 20 : 60);
    assert.deepEqual(f.kills, [f.model.pid]); assert.equal(f.acks.at(-1)?.state, 'closed'); f.dispose();
  }
});

test('renewal extends only current lease/freshness and cannot extend independent hard runtime', () => {
  const f = lifetimeFixture(); f.launch({ freshnessMs: 0 });
  f.advance(50); f.control.write('{"operation":"renew","leaseMs":100}\n');
  f.advance(49); assert.equal(f.kills.length, 0);
  f.advance(1); assert.deepEqual(f.kills, [f.model.pid]); f.dispose();
});

test('lost control pipe and malformed or source-bearing control fail closed', async () => {
  for (const malicious of [false, true]) {
    const f = lifetimeFixture(); f.launch();
    if (malicious) f.control.write('{"operation":"renew","leaseMs":100,"evidence":"SOURCE_MUST_NOT_ENTER_CONTROL"}\n');
    else { const ended = once(f.control, 'end'); f.control.end(); await ended; }
    assert.deepEqual(f.kills, [f.model.pid]); assert.deepEqual(f.finished, [true]); f.dispose();
  }
});

test('parent dies before launch: no child receives evidence or creates a process group', async () => {
  const f = lifetimeFixture(); const ended = once(f.lifeline, 'end'); f.lifeline.end(); await ended;
  f.control.write('{"operation":"launch","executable":"/fixed/claude"}\n');
  assert.equal(f.launches.length, 0); assert.equal(f.kills.length, 0);
  assert.deepEqual(f.finished, [true]); f.dispose();
});

test('surviving group or failed absence inspection never produces a positive teardown ACK', () => {
  for (const cannotInspect of [false, true]) {
    const f = lifetimeFixture({ stubbornGroup: true, cannotInspect }); f.launch(); f.model.emit('exit', 0);
    f.advance(HAIKU_LIFETIME_TEARDOWN_MS);
    assert.deepEqual(f.acks.at(-1), { version: HAIKU_LIFETIME_VERSION, state: 'closed', code: 0, treeGone: false });
    assert.deepEqual(f.finished, [false]); f.dispose();
  }
});

test('fork/setsid/reparent escape fixtures pin the approved no-fork model containment', () => {
  const f = lifetimeFixture(); f.launch();
  const profile = f.launches[0].args[1];
  for (const attemptedEscape of ['fork', 'fork-and-setsid', 'double-fork-and-reparent']) {
    // All these escape paths first require process-fork; the fixed profile denies
    // it, with no per-path allowance. This fixture checks the launch contract,
    // not actual OS enforcement (which requires the authorized Mac sentinel run).
    assert.ok(profile.includes('(deny process-fork)'), attemptedEscape);
    assert.ok(!profile.includes('(allow process-fork)'), attemptedEscape);
  }
  assert.ok(profile.includes('(deny file-write*)')); f.supervisor.stop(); f.dispose();
});
