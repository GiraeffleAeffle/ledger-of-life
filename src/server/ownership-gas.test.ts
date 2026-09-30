import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';

test('native Robinhood transfers include estimated posting gas and reject excessive grants', () => {
  assert.equal(reviewedOperatorGas(21_000n, 'transfer'), 36_250n);
  assert.equal(reviewedOperatorGas(370_000n, 'transfer'), 472_500n);
  assert.throws(() => reviewedOperatorGas(400_000n, 'transfer'), /reviewed testnet ceiling/);
  assert.throws(() => reviewedOperatorGas(0n, 'transfer'), /positive testnet gas estimate/);
  assert.ok(reviewedOperatorGas(4_000_000n, 'deploy') > 4_000_000n);
  assert.throws(() => reviewedOperatorGas(5_000_000n, 'deploy'), /reviewed testnet ceiling/);
});

test('operator envelope rejects unavailable or unbounded gas prices before signing', () => {
  assert.deepEqual(reviewedOperatorFees({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n }), {
    maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
  });
  assert.throws(() => reviewedOperatorFees({}), /unavailable/);
  assert.throws(() => reviewedOperatorFees({ maxFeePerGas: 11_000_000_000n }), /reviewed testnet ceiling/);
});
