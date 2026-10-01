import test from 'node:test';
import assert from 'node:assert/strict';
import { belowGasDripThreshold, GAS_DRIP_THRESHOLD } from './gas-threshold.ts';
import { GAS_DRIP_THRESHOLD as serverThreshold } from '../server/gas-drip.ts';

test('the button threshold is the server drip threshold: below shows, at or above does not', () => {
  assert.equal(GAS_DRIP_THRESHOLD, serverThreshold);
  for (const low of ['0', '0.000001', '0.000009999999999999']) assert.equal(belowGasDripThreshold(low), true, low);
  for (const enough of ['0.00001', '0.000010000000000001', '0.0005']) assert.equal(belowGasDripThreshold(enough), false, enough);
});

test('an unknown or unreadable balance never offers the drip', () => {
  assert.equal(belowGasDripThreshold(undefined), false);
  assert.equal(belowGasDripThreshold('not a number'), false);
});
