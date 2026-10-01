import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount } from './assets.ts';
import { maximumDepositSecurity, validateDepositSecurity } from './deposit-form.ts';

test('deposit maxima preserve six-decimal test-dollar precision and accept the boundary', () => {
  const rent = parseAmount('900.123456');
  for (const [kind, maximum] of [['shares', '1800.246912'], ['cash', '2700.370368']] as const) {
    const security = maximumDepositSecurity(rent, kind);
    assert.equal(security, parseAmount(maximum));
    validateDepositSecurity(rent, security, kind);
    assert.throws(() => validateDepositSecurity(rent, (BigInt(security) + 1n).toString(), kind), /must not exceed/);
  }
  assert.equal(maximumDepositSecurity('1', 'shares'), '2');
  assert.equal(maximumDepositSecurity('1', 'cash'), '3');
  assert.throws(() => maximumDepositSecurity('900.123456', 'shares'), /atomic units/);
  assert.throws(() => validateDepositSecurity(rent, '1800.246912', 'shares'), /atomic units/);
});
