import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeBuildingIncome, rentPaymentEvidence, type BuildingInflow, type IncomeEvidence } from './building-revenue-attribution.ts';
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

test('confirmed rent inflows aggregate without exposing flat labels or rent receipt hashes', () => {
  const target = { distributor: '0x2222222222222222222222222222222222222222', payoutToken: '0x3333333333333333333333333333333333333333' };
  const tenantWallet = '0x1111111111111111111111111111111111111111';
  const journal = {
    id: 'private-payment', agreementId: 'private-agreement', tenantWallet, tenantName: 'Private Tenant',
    flatLabel: 'Flat 4', state: 'pending', token: target.payoutToken, distributor: target.distributor, buildingRaw: '180000000',
    steps: [
      { kind: 'landlord', state: 'confirmed', hash: '0xLANDLORD', recipient: target.distributor, amountRaw: '720000000' },
      { kind: 'building', state: 'confirmed', hash: '0xRENT', recipient: target.distributor, amountRaw: '180000000' },
    ],
  };
  const evidence = rentPaymentEvidence([journal, { ...journal, flatLabel: 'Duplicate journal' }], target);
  const result = attributeBuildingIncome([
    transfer('0xrent', '180000001'),
    transfer('0xother', '180000000'),
    transfer('0xlandlord', '720000000'),
    transfer('0xrent', '180000000', 1),
    transfer('0xrent', '180000000', 2),
  ], evidence);
  assert.deepEqual(result.transactions.map(row => row.kind), ['unattributed', 'unattributed']);
  const rentSource = result.sources.find(row => row.kind === 'rent')!;
  assert.equal(rentSource.id, 'rent');
  assert.equal(rentSource.name, 'Rent shares');
  assert.equal(rentSource.amountRaw, '180000000');
  assert.equal(rentSource.receipts, 1);
  assert.equal(result.sources.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n), 1440000001n);
  for (const privateValue of [tenantWallet, journal.tenantName, journal.id, journal.agreementId, journal.flatLabel, 'Duplicate journal', '0xrent']) {
    assert.equal(JSON.stringify(result).toLowerCase().includes(privateValue.toLowerCase()), false);
  }
});

test('pending, stopped, missing-hash and foreign-token or distributor rent journals never explain an inflow', () => {
  const target = { distributor: '0x2222222222222222222222222222222222222222', payoutToken: '0x3333333333333333333333333333333333333333' };
  const journal = {
    flatLabel: 'Flat 5', token: target.payoutToken, distributor: target.distributor, buildingRaw: '200',
    steps: [{ kind: 'building', state: 'confirmed', hash: '0xRENT', recipient: target.distributor, amountRaw: '200' }],
  };
  const step = journal.steps[0];
  const rejected = [
    { ...journal, token: '0x4444444444444444444444444444444444444444' },
    { ...journal, distributor: '0x4444444444444444444444444444444444444444' },
    { ...journal, buildingRaw: '201' },
    ...['prepared', 'signed', 'submitted', 'stopped'].map(state => ({ ...journal, steps: [{ ...step, state }] })),
    { ...journal, steps: [{ ...step, hash: undefined }] },
    { ...journal, steps: [{ ...step, recipient: '0x4444444444444444444444444444444444444444' }] },
    { ...journal, steps: [{ ...step, kind: 'landlord' }] },
  ];
  const result = attributeBuildingIncome([transfer('0xrent', '200')], rentPaymentEvidence(rejected, target));
  assert.equal(result.transactions[0].kind, 'unattributed');
  assert.equal(result.sources[0].amountRaw, '200');
  const accepted = attributeBuildingIncome([transfer('0xrent', '200')], rentPaymentEvidence([{
    ...journal, token: target.payoutToken.toUpperCase(), distributor: target.distributor.toUpperCase(),
    steps: [{ ...step, recipient: target.distributor.toUpperCase() }],
  }], target));
  assert.equal(accepted.transactions.length, 0);
  assert.equal(accepted.sources.find(row => row.kind === 'rent')?.amountRaw, '200');
});
