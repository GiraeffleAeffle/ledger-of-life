import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, custom, decodeFunctionData, verifyTypedData, type Address, type TypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress, type FacilitatorEvmSigner } from '@x402/evm';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import { UptoEvmScheme as UptoFacilitator } from '@x402/evm/upto/facilitator';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import type { PaymentPayload } from '@x402/core/types';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { aiRpc, inferenceMaximum, inferenceCharge } from './local-ai-runtime.ts';
import { assertAiPaymentVerified, facilitatorReadContract, reviewedAiSettlement, uptoProxyCall, type AiPaidRecord } from './local-ai-payment.ts';
import { prepareInferencePayment } from '../wallets/inference-signing.ts';

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

test('funded Permit2 authorization verifies with the fee payer as the proxy simulation caller', async () => {
  const tenant = privateKeyToAccount(`0x${'12'.repeat(32)}`);
  const wallet = { id: 'tenant', address: tenant.address, connected: true, chainType: 'ethereum' as const };
  // A deterministic RPC model of the proxy's UnauthorizedFacilitator guard. Use viem's real
  // eth_call encoding and the real SDK so an omitted sender rejects a correctly signed quote.
  const rpc = createPublicClient({ transport: custom({ async request({ method, params }) {
    if (method === 'eth_getCode') return '0x6000';
    if (method !== 'eth_call') throw new Error(`Unexpected RPC method: ${method}`);
    const [call] = params as [{ to: Address; from?: Address; data: `0x${string}` }];
    if (call.to.toLowerCase() === x402UptoPermit2ProxyAddress.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: x402UptoPermit2ProxyABI, data: call.data });
      if (decoded.functionName === 'settle') {
        if (call.from?.toLowerCase() !== decoded.args[3].facilitator.toLowerCase())
          throw new Error('UnauthorizedFacilitator');
        if (decoded.args[1] > decoded.args[0].permitted.amount) throw new Error('AmountExceedsPermit');
        return '0x';
      }
    }
    throw new Error('Unexpected contract call');
  } }) });
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [facilitator],
    getCode: async ({ address }) => address === tenant.address ? '0x' : '0x6000',
    readContract: facilitatorReadContract(facilitator, rpc as unknown as typeof aiRpc),
    verifyTypedData: async (args) => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
    writeContract: async () => { throw new Error('No transactions allowed in verification'); },
    sendTransaction: async () => { throw new Error('No transactions allowed in verification'); },
    waitForTransactionReceipt: async () => { throw new Error('No transactions allowed in verification'); },
  };
  const sdk = new x402Facilitator().register('eip155:46630', new UptoFacilitator(signer));
  const resource = new x402ResourceServer({
    getSupported: async () => {
      const supported = sdk.getSupported();
      return { ...supported, kinds: supported.kinds.map((kind) => ({ ...kind, network: 'eip155:46630' as const })) };
    },
    verify: (payload, requirements) => sdk.verify(payload, requirements),
    settle: async () => { throw new Error('No settlement allowed in verification'); },
  }).register('eip155:46630', new UptoServer());
  await resource.initialize();
  const [requirements] = await resource.buildPaymentRequirements({
    scheme: 'upto', network: 'eip155:46630', payTo: payee,
    price: { asset: TEST_USDG_ADDRESS, amount: '12800' }, maxTimeoutSeconds: 1200,
    extra: { assetTransferMethod: 'permit2', paymentFlow: 'authorization' },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  const now = Math.floor(Date.now() / 1000);
  const typed = prepareInferencePayment({
    walletId: wallet.id, operationId: id, description: 'Reviewed answer',
    requestId: id, requestFingerprint: `0x${'44'.repeat(32)}`,
    resourceUrl: `https://ledger.example/api/local-ai/requests/${id}`,
    expiresAt: new Date((now + 600) * 1000).toISOString(),
    chainId: 46630, asset: TEST_USDG_ADDRESS, payTo: payee, facilitatorAddress: facilitator,
    maxOutputTokens: 128, amountAtomic: '12800', nonce: '1', deadline: String(now + 600), validAfter: '0',
  }, wallet);
  const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: {
    signature: await tenant.signTypedData<TypedData, 'PermitWitnessTransferFrom'>(typed),
    permit2Authorization: { from: tenant.address, ...typed.message },
  } };
  const result = await resource.verifyPayment(payload, requirements);
  assert.equal(result.isValid, true, result.invalidReason);
  assert.equal(result.payer, tenant.address);
  assertAiPaymentVerified(result, tenant.address);
  const impostor = privateKeyToAccount(`0x${'13'.repeat(32)}`);
  const tampered = { ...payload, payload: { ...payload.payload, signature: await impostor.signTypedData<TypedData, 'PermitWitnessTransferFrom'>(typed) } };
  const rejected = await resource.verifyPayment(tampered, requirements);
  assert.equal(rejected.isValid, false);
  assert.equal(rejected.invalidReason, 'invalid_permit2_signature');
});

test('verification refusals expose safe SDK reasons and reject absent or mismatched payers', () => {
  assert.throws(() => assertAiPaymentVerified({ isValid: false, invalidReason: 'permit2_simulation_failed', payer }, payer),
    /permit2_simulation_failed \(payer: 0x1111111111111111111111111111111111111111\)/);
  assert.throws(() => assertAiPaymentVerified({ isValid: true }, payer), /payer_missing/);
  assert.throws(() => assertAiPaymentVerified({ isValid: true, payer: payee }, payer), /payer_mismatch/);
  assert.throws(() => assertAiPaymentVerified({ isValid: false, invalidReason: 'secret payload\\nbytes', payer: 'secret' }, payer),
    { message: 'Signed payment could not be verified: verification_failed (payer: unavailable).' });
});
