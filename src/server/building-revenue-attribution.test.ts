import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeBuildingIncome, type BuildingInflow, type IncomeEvidence } from './building-revenue-attribution.ts';
const transfer = (transactionHash: string, amountRaw: string, logIndex = 0, from = '0x1111111111111111111111111111111111111111'): BuildingInflow => ({ transactionHash, amountRaw, from, logIndex, blockNumber: '42', explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${transactionHash}` });
const gpu: IncomeEvidence = { transactionHash: '0xAAA', amountRaw: '10400', kind: 'gpu', hostId: 'nuc', hostName: 'Home NUC' };
const solar: IncomeEvidence = { transactionHash: '0xBBB', amountRaw: '80000', kind: 'solar', hostId: 'roof', hostName: 'Roof node' };
test('all inflows reconcile to GPU host, simulated solar, or unattributed source totals', () => {
  const result = attributeBuildingIncome([transfer('0xaaa', '10400'), transfer('0xbbb', '80000', 0, `0x${'0'.repeat(40)}`), transfer('0xccc', '750'), transfer('0xddd', '10400')], [gpu, solar]);
  assert.deepEqual(result.transactions.map(row => [row.kind, row.sourceName]), [['gpu', 'GPU · Home NUC'], ['solar', 'Simulated solar · Roof node'], ['unattributed', 'Unattributed transfers'], ['unattributed', 'Unattributed transfers']]);
  assert.deepEqual(result.sources.map(row => [row.id, row.amountRaw]), [['gpu:nuc', '10400'], ['solar:roof', '80000'], ['unattributed', '11150']]);
  assert.equal(result.sources.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n), 101550n);
});
test('mismatched amounts, unrelated mints and duplicate same-transaction inflows cannot borrow evidence', () => {
  const result = attributeBuildingIncome([transfer('0xaaa', '10401'), transfer('0xaaa', '10400', 1), transfer('0xaaa', '10400', 2), transfer('0xbbb', '80000', 0), transfer('0xccc', '80000', 0, `0x${'0'.repeat(40)}`)], [gpu, gpu, solar]);
  assert.deepEqual(result.transactions.map(row => row.kind), ['unattributed', 'gpu', 'unattributed', 'unattributed', 'unattributed']);
  assert.equal(result.sources.find(row => row.kind === 'gpu')?.amountRaw, '10400');
});
