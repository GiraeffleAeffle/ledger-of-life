import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishProvisionerJournal, readProvisionerJournal, type ProvisionerFundingJournal } from './ownership-funding-journal.ts';

const funding = { recipient: '0x1111111111111111111111111111111111111111', operator: '0x2222222222222222222222222222222222222222', amountWei: '30000000000000000' };

test('concurrent provisioner funding reservations retain one immutable envelope, not the losing signed transaction', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ownership-funding-'));
  const file = join(folder, 'funding.json');
  try {
    const first: ProvisionerFundingJournal = { ...funding, step: { signed: '0x02aa', hash: '0xaaaa' } };
    const second: ProvisionerFundingJournal = { ...funding, step: { signed: '0x02bb', hash: '0xbbbb' } };
    const [winnerA, winnerB] = await Promise.all([publishProvisionerJournal(file, first), publishProvisionerJournal(file, second)]);
    assert.deepEqual(winnerA, winnerB);
    assert.deepEqual(await readProvisionerJournal(file), winnerA);
    assert.ok(winnerA.step.signed === first.step.signed || winnerA.step.signed === second.step.signed);
    const replay = await publishProvisionerJournal(file, winnerA.step.signed === first.step.signed ? second : first);
    assert.deepEqual(replay, winnerA);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
