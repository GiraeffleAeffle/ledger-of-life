import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, type Address } from 'viem';
import { x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { inferenceMaximum, inferenceCharge } from './local-ai-runtime.ts';
import { reviewedAiSettlement, uptoProxyCall, type AiPaidRecord } from './local-ai-payment.ts';

const payer = '0x1111111111111111111111111111111111111111' as Address;
const payee = '0x2222222222222222222222222222222222222222' as Address;
const facilitator = '0x3333333333333333333333333333333333333333' as Address;
function record(): AiPaidRecord {
  const requirements = { scheme: 'upto', network: 'eip155:46630' as const, amount: '12800', asset: TEST_USDG_ADDRESS, payTo: payee, maxTimeoutSeconds: 1200, extra: { facilitatorAddress: facilitator } };
  return { id: 'answer', owner: { payer }, payee, request: { answer: 'Complete answer', state: 'settling', error: null, maxOutputTokens: 128, usage: { outputTokens: 37 }, payment: { state: 'pending', amountAtomic: '3700' } }, paymentJournal: { payload: { x402Version: 2, accepted: requirements, payload: { signature: `0x${'11'.repeat(65)}`, permit2Authorization: { from: payer, permitted: { token: TEST_USDG_ADDRESS, amount: '12800' }, spender: x402UptoPermit2ProxyAddress, nonce: '1', deadline: '9999999999', witness: { to: payee, facilitator, validAfter: '0' } } } }, requirements, amount: '3700', signed: null, hash: null, nonce: null } };
}
test('quote ceiling and actual output usage are distinct, bounded amounts', () => {
  assert.equal(inferenceMaximum(128), 12800n);
  assert.equal(inferenceCharge(37, 12800n), 3700n);
  assert.equal(inferenceCharge(128, 12800n), 12800n);
  assert.equal(inferenceCharge(0, 12800n), 0n);
  for (const n of [129, null, -1, 1.5]) assert.throws(() => inferenceCharge(n, 12800n));
});
test('restricted signer permits only saved upto calldata and exact measured usage', () => {
  const value = record();
  const data = uptoProxyCall(value.paymentJournal!, payer, payee);
  const decoded = decodeFunctionData({ abi: x402UptoPermit2ProxyABI, data });
  assert.equal(decoded.functionName, 'settle');
  assert.equal(decoded.args[1], 3700n);
  const write = { address: x402UptoPermit2ProxyAddress, abi: x402UptoPermit2ProxyABI, functionName: 'settle', args: decoded.args };
  assert.equal(reviewedAiSettlement(value, payer, payee, write), data);
  assert.throws(() => reviewedAiSettlement(value, payer, payee, { ...write, address: TEST_USDG_ADDRESS }));
  assert.throws(() => reviewedAiSettlement(value, payer, payee, { ...write, args: [decoded.args[0], 3701n, ...decoded.args.slice(2)] }));
  assert.throws(() => reviewedAiSettlement(value, payer, payee, { ...write, args: [decoded.args[0], 12801n, ...decoded.args.slice(2)] }));
  assert.throws(() => reviewedAiSettlement(value, payer, payee, { ...write, gas: 300001n }));
  value.request.usage = { outputTokens: 38 };
  assert.throws(() => reviewedAiSettlement(value, payer, payee, write));
  value.request.usage = { outputTokens: 37 }; value.request.state = 'failed'; value.request.answer = null;
  assert.throws(() => reviewedAiSettlement(value, payer, payee, write));
});
