import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorHostStatus } from '../server/local-ai-types.ts';
import { cityQuestionStart, deskAvailability, lastAnswerText, libraryCityFromParam } from './local-ai-availability.ts';

const MODEL = 'qwen';
const host = (patch: Partial<ConnectorHostStatus> = {}): ConnectorHostStatus => ({
  id: 'h', name: 'Library GPU', own: false, payoutWallet: '0x1', models: [MODEL], lastHeartbeat: 1, state: 'active',
  ollamaReachable: true, awake: true, availability: 'online', canWake: false, freePublicAnswers: true, ...patch,
});
const desk = (hosts: ConnectorHostStatus[]) => ({ mode: 'connector' as const, reachable: true, model: MODEL, hosts });

test('a desk with a free online host can be asked without a notice', () => {
  assert.deepEqual(deskAvailability(desk([host()]), 'library', 'city'), { canAsk: true, reason: '', notice: '' });
});

test('sleeping hosts that can wake are askable but warn about the wait', () => {
  const state = deskAvailability(desk([host({ availability: 'asleep', canWake: true })]), 'library', 'city');
  assert.equal(state.canAsk, true);
  assert.match(state.notice, /asleep; a question wakes one, which can take up to 4 minutes/);
  // One awake host removes the wait.
  assert.equal(deskAvailability(desk([host({ availability: 'asleep', canWake: true }), host({ id: 'b' })]), 'library', 'city').notice, '');
});

test('asleep hosts that cannot wake and offline hosts say so and block asking', () => {
  const asleep = deskAvailability(desk([host({ availability: 'asleep', canWake: false })]), 'library', 'city');
  assert.equal(asleep.canAsk, false);
  assert.match(asleep.reason, /asleep and cannot be woken/);
  const offline = deskAvailability(desk([host({ availability: 'offline' })]), 'library', 'city');
  assert.equal(offline.canAsk, false);
  assert.match(offline.reason, /offline/);
});

test('free answers need a host that opted in; paid answers do not', () => {
  const hosts = [host({ freePublicAnswers: false })];
  const free = deskAvailability(desk(hosts), 'library', 'city');
  assert.equal(free.canAsk, false);
  assert.match(free.reason, /No host offers free answers right now/);
  assert.equal(deskAvailability(desk(hosts), 'paid', 'city').canAsk, true);
});

test('no host for the model, a missing status and an unreachable direct model are explained', () => {
  assert.match(deskAvailability(desk([host({ models: ['other'] })]), 'library', 'city').reason, /No city host is connected/);
  assert.match(deskAvailability(desk([]), 'paid', 'city').reason, /No city host is connected/);
  assert.equal(deskAvailability(null, 'library', 'city').canAsk, false);
  assert.equal(deskAvailability({ mode: 'direct', reachable: false, model: MODEL }, 'library', 'city').canAsk, false);
  assert.equal(deskAvailability({ mode: 'direct', reachable: true, model: MODEL }, 'library', 'city').canAsk, true);
});

test('"only my own hosts" is left to the workspace and revoked hosts never count', () => {
  assert.equal(deskAvailability(desk([]), 'paid', 'own').canAsk, true);
  assert.equal(deskAvailability(desk([host({ state: 'revoked' })]), 'library', 'city').canAsk, false);
});

test('the last answer time is shown in UTC, or the lack of one is stated', () => {
  assert.equal(lastAnswerText('2026-10-01T14:03:00.000Z'), 'Last successful answer: 1 Oct 2026, 14:03 UTC.');
  assert.equal(lastAnswerText(null), 'No answer has been completed yet.');
  assert.equal(lastAnswerText('not a date'), 'No answer has been completed yet.');
});

test('only covered city ids are accepted from the library link', () => {
  assert.equal(libraryCityFromParam('muenster'), 'muenster');
  assert.equal(libraryCityFromParam('Münster'), null);
  assert.equal(libraryCityFromParam('hamburg'), null);
  assert.equal(libraryCityFromParam('constructor'), null);
  assert.equal(libraryCityFromParam('__proto__'), null);
  assert.equal(libraryCityFromParam(['koeln', 'muenster']), null);
  assert.equal(libraryCityFromParam(undefined), null);
  assert.equal(cityQuestionStart('muenster'), 'Public information for Münster: ');
});
