import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { planRobinhoodBuy, ROBINHOOD_TESTNET } from './robinhood-demo.ts';

const abi = parseAbi(['function approve(address,uint256) returns (bool)', 'function buy(uint256,uint256) returns (uint256)']);
const input = { balance: 12_000_000n, amount: 5_000_000n, allowance: 0n, minOut: 20_000_000_000_000_000n };

test('short allowance approves only requested spend, then buys quoted amount', () => {
  const calls = planRobinhoodBuy(input);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, ROBINHOOD_TESTNET.usd);
  assert.deepEqual(decodeFunctionData({ abi, data: calls[0].data }), { functionName: 'approve', args: [ROBINHOOD_TESTNET.desk, input.amount] });
  assert.equal(calls[1].to, ROBINHOOD_TESTNET.desk);
  assert.deepEqual(decodeFunctionData({ abi, data: calls[1].data }), { functionName: 'buy', args: [input.amount, input.minOut] });
});

test('existing sufficient allowance buys without signing another approval', () => {
  const calls = planRobinhoodBuy({ ...input, allowance: input.amount });
  assert.equal(calls.length, 1);
  assert.deepEqual(decodeFunctionData({ abi, data: calls[0].data }), { functionName: 'buy', args: [input.amount, input.minOut] });
});

test('invalid spend and zero-output quote never produce calls', () => {
  assert.throws(() => planRobinhoodBuy({ ...input, amount: 0n }), /Enter an amount above zero/);
  assert.throws(() => planRobinhoodBuy({ ...input, amount: input.balance + 1n }), /more than the test USD in your wallet/);
  assert.throws(() => planRobinhoodBuy({ ...input, minOut: 0n }), /too small to buy any TSLA/);
});
