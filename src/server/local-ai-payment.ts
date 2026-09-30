import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme as ExactServer } from '@x402/evm/exact/server';
import { ExactEvmScheme as ExactFacilitator } from '@x402/evm/exact/facilitator';
import { PERMIT2_ADDRESS, isPermit2Payload, permit2WitnessTypes, x402ExactPermit2ProxyABI, x402ExactPermit2ProxyAddress, type ExactEvmPayloadV2, type FacilitatorEvmSigner } from '@x402/evm';
import { decodeEventLog, encodeFunctionData, keccak256, parseTransaction, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AI_PRICE, aiRpc, aiTokenAbi, assertInferenceContracts } from './local-ai-runtime.ts';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { ConflictError } from './errors.ts';
import type { Store } from './store.ts';

export type AiPayment = { payload: PaymentPayload; requirements: PaymentRequirements; signed: Hex | null; hash: Hex | null; nonce: number | null };
export type AiPaidRecord = { id: string; owner: { payer: Address }; payee: Address | null; request: {
  answer: string | null; state: string; error: string | null; payment: { state: string };
}; paymentJournal: AiPayment | null };
type FeeEnvelope = { chainId: 46630; to: Address; data: Hex; value: '0'; nonce: number; gas: '300000'; maxFeePerGas: string; maxPriorityFeePerGas: string };
type FeeLane = { id: string; envelope: FeeEnvelope | null };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const keyFile = () => resolve(/* turbopackIgnore: true */ process.env.LOCAL_AI_FACILITATOR_KEY_FILE || '.testnet-secrets/local-ai/facilitator.key');
export async function facilitatorAccount() {
  // A hosted deployment supplies the key from its Secret, like the sponsor and price-updater keys; a local run keeps
  // it in an owner-only file.
  const fromEnvironment = process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY?.trim();
  if (fromEnvironment) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(fromEnvironment)) throw new ConflictError('Invalid dedicated facilitator key.');
    return privateKeyToAccount(fromEnvironment as Hex);
  }
  const filename = keyFile();
  const metadata = await stat(/* turbopackIgnore: true */ filename);
  if (metadata.mode & 0o077) throw new ConflictError('Dedicated fee signer key is not owner-only.');
  const raw = (await readFile(/* turbopackIgnore: true */ filename, 'utf8')).trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) throw new ConflictError('Invalid dedicated facilitator key file.');
  return privateKeyToAccount(raw as Hex);
}
export function validatePaymentPayload(payload: PaymentPayload, requirements: PaymentRequirements, id: string, payer: Address, payee: Address, url: string) {
  const identifier = payload.extensions?.['payment-identifier'];
  const info = identifier && typeof identifier === 'object' && 'info' in identifier ? identifier.info : null;
  if (payload.x402Version !== 2 || payload.accepted.scheme !== 'exact' || payload.accepted.network !== 'eip155:46630' ||
      requirements.scheme !== 'exact' || requirements.network !== 'eip155:46630' ||
      requirements.amount !== AI_PRICE.toString() || !same(requirements.asset, TEST_USDG_ADDRESS) || !same(requirements.payTo, payee) ||
      requirements.extra?.assetTransferMethod !== 'permit2' || payload.accepted.extra?.assetTransferMethod !== 'permit2' ||
      payload.resource?.url !== url || !info || typeof info !== 'object' || !('id' in info) || info.id !== id ||
      !('required' in info) || info.required !== true ||
      Object.keys(payload.extensions || {}).some((key) => key !== 'payment-identifier'))
    throw new ConflictError('Payment did not match the reviewed inference request.');
  const raw = payload.payload;
  if (!raw || typeof raw !== 'object' || !('signature' in raw) || !('permit2Authorization' in raw) ||
      !/^0x[a-fA-F0-9]{130}$/.test(String(raw.signature)))
    throw new ConflictError('A canonical Permit2 authorization is required.');
  const auth = raw.permit2Authorization;
  if (!auth || typeof auth !== 'object' || !('from' in auth) || !('permitted' in auth) ||
      !('spender' in auth) || !('nonce' in auth) || !('deadline' in auth) || !('witness' in auth) ||
      !auth.permitted || typeof auth.permitted !== 'object' || !('token' in auth.permitted) ||
      !('amount' in auth.permitted) || !auth.witness || typeof auth.witness !== 'object' ||
      !('to' in auth.witness) || !('validAfter' in auth.witness) ||
      typeof auth.from !== 'string' || typeof auth.spender !== 'string' ||
      typeof auth.permitted.token !== 'string' || typeof auth.permitted.amount !== 'string' ||
      typeof auth.witness.to !== 'string' || typeof auth.nonce !== 'string' ||
      typeof auth.deadline !== 'string' || typeof auth.witness.validAfter !== 'string')
    throw new ConflictError('Malformed Permit2 authorization.');
  const now = Math.floor(Date.now() / 1000);
  if (!same(auth.from, payer) || !same(auth.permitted.token, TEST_USDG_ADDRESS) || auth.permitted.amount !== AI_PRICE.toString() ||
      !same(auth.spender, x402ExactPermit2ProxyAddress) || !same(auth.witness.to, payee) ||
      !/^(0|[1-9][0-9]*)$/.test(auth.nonce) || !/^(0|[1-9][0-9]*)$/.test(auth.deadline) ||
      !/^(0|[1-9][0-9]*)$/.test(auth.witness.validAfter) || BigInt(auth.nonce) >= 2n ** 256n ||
      BigInt(auth.witness.validAfter) > BigInt(now) || BigInt(auth.deadline) < BigInt(now + 60) ||
      BigInt(auth.deadline) > BigInt(now + 20 * 60))
    throw new ConflictError('Payment signature exceeds the reviewed amount, recipient or lifetime.');
  return auth;
}
export function verifyCanonicalTransfer(receipt: TransactionReceipt, payer: Address, payee: Address) {
  if (receipt.status !== 'success') return false;
  let matching = 0;
  for (const log of receipt.logs) {
    if (!same(log.address, TEST_USDG_ADDRESS)) continue;
    try {
      const event = decodeEventLog({ abi: aiTokenAbi, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === 'Transfer') {
        if (same(event.args.from, payer) || same(event.args.to, payee)) {
          if (!same(event.args.from, payer) || !same(event.args.to, payee) || event.args.value !== AI_PRICE) return false;
          matching++;
        }
      }
    } catch { return false; }
  }
  return matching === 1;
}
function exactProxyCall(payment: AiPayment, payer: Address, payee: Address): Hex {
  // The saved payload passed the immutable-quote policy before being journaled.
  const candidate = payment.payload.payload as ExactEvmPayloadV2;
  if (!isPermit2Payload(candidate)) throw new ConflictError('Only a Permit2 exact authorization may settle.');
  const auth = candidate.permit2Authorization;
  if (!same(auth.from, payer) || !same(auth.permitted.token, TEST_USDG_ADDRESS) ||
      auth.permitted.amount !== AI_PRICE.toString() || !same(auth.spender, x402ExactPermit2ProxyAddress) ||
      !same(auth.witness.to, payee) || !/^0x[a-fA-F0-9]{130}$/.test(candidate.signature))
    throw new ConflictError('Saved settlement authorization differs from this quote.');
  return encodeFunctionData({ abi: x402ExactPermit2ProxyABI, functionName: 'settle', args: [
    { permitted: { token: TEST_USDG_ADDRESS, amount: AI_PRICE }, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) },
    payer, { to: payee, validAfter: BigInt(auth.witness.validAfter) }, candidate.signature,
  ] });
}
export async function inspectAiReceipt(payment: AiPayment, payer: Address, payee: Address, rpc: typeof aiRpc = aiRpc, feeAddress?: Address): Promise<'settled' | 'pending' | 'failed'> {
  if (!payment.signed || !payment.hash || payment.nonce === null) return 'pending';
  let receipt: TransactionReceipt;
  try { receipt = await rpc.getTransactionReceipt({ hash: payment.hash }); }
  catch { return 'pending'; }
  const [tx, block, tip] = await Promise.all([
    rpc.getTransaction({ hash: payment.hash }), rpc.getBlock({ blockNumber: receipt.blockNumber }), rpc.getBlockNumber(),
  ]);
  const parsed = parseTransaction(payment.signed);
  const signer = feeAddress ?? (await facilitatorAccount()).address;
  let expected: Hex;
  try { expected = exactProxyCall(payment, payer, payee); } catch { return 'pending'; }
  if (keccak256(payment.signed) !== payment.hash || receipt.transactionHash !== payment.hash || tx.hash !== payment.hash ||
      receipt.blockHash !== tx.blockHash || block.hash !== receipt.blockHash || tip < receipt.blockNumber + 2n ||
      !same(tx.from, signer) || !tx.to || !same(tx.to, x402ExactPermit2ProxyAddress) ||
      tx.input !== parsed.data || tx.input !== expected || tx.value !== 0n || tx.nonce !== payment.nonce || tx.chainId !== 46630 ||
      tx.gas !== parsed.gas || tx.maxFeePerGas !== parsed.maxFeePerGas ||
      (tx.maxPriorityFeePerGas ?? 0n) !== (parsed.maxPriorityFeePerGas ?? 0n)) return 'pending';
  if (receipt.status === 'reverted') return 'failed';
  return verifyCanonicalTransfer(receipt, payer, payee) ? 'settled' : 'pending';
}
/** Expired, never-journaled signing may be abandoned; signed/ambiguous bytes are never released. */
export async function recoverExpiredUnsignedSettlement(
  store: Store, recordKey: string, payer: Address, payee: Address,
  rpc: typeof aiRpc = aiRpc, feeAddress?: Address, now = Date.now(),
): Promise<boolean> {
  const record = await store.get<AiPaidRecord>(recordKey);
  if (!record?.paymentJournal || !record.request.answer || !record.payee || !same(record.owner.payer, payer) || !same(record.payee, payee) ||
      record.paymentJournal.signed || record.paymentJournal.hash || record.request.state === 'completed') return false;
  const candidate = record.paymentJournal.payload.payload as ExactEvmPayloadV2;
  if (!isPermit2Payload(candidate) || !/^(0|[1-9][0-9]*)$/.test(candidate.permit2Authorization.deadline) ||
      BigInt(candidate.permit2Authorization.deadline) >= BigInt(Math.floor(now / 1000))) return false;
  const lane = await store.get<FeeLane>('local-ai:fee-lane');
  if (lane?.id === record.id) {
    if (!lane.envelope || lane.envelope.data !== exactProxyCall(record.paymentJournal, payer, payee))
      return false;
    const signer = feeAddress ?? (await facilitatorAccount()).address;
    const [latest, pending] = await Promise.all([
      rpc.getTransactionCount({ address: signer, blockTag: 'latest' }),
      rpc.getTransactionCount({ address: signer, blockTag: 'pending' }),
    ]);
    if (latest !== lane.envelope.nonce || pending !== lane.envelope.nonce) return false;
  }
  await store.update<AiPaidRecord>(recordKey, (value) => {
    if (!value.paymentJournal || value.paymentJournal.signed || value.paymentJournal.hash ||
        value.request.state === 'completed' || value.request.payment.state === 'settled')
      throw new ConflictError('Unsigned fee reservation changed before expiry recovery.');
    value.request.state = 'failed'; value.request.payment.state = 'failed';
    value.request.error = 'The payment authorization expired before a fee transaction was signed. No inference tokens were charged.';
    return value;
  });
  if (lane?.id === record.id) await store.update<FeeLane>('local-ai:fee-lane', (current) => {
    if (!current.id && !current.envelope) return current;
    if (current.id !== record.id || JSON.stringify(current.envelope) !== JSON.stringify(lane.envelope))
      throw new ConflictError('Fee envelope changed during unsigned recovery.');
    return { id: '', envelope: null };
  });
  return true;
}
export async function createAiResource(store: Store, recordKey: string, payer: Address, payee: Address) {
  await assertInferenceContracts();
  const account = await facilitatorAccount();
  if (same(account.address, payer) || same(account.address, payee)) throw new ConflictError('Dedicated fee payer must be separate from both payment parties.');
  const readRecord = async () => {
    const record = await store.get<AiPaidRecord>(recordKey);
    if (!record || !record.owner || !same(record.owner.payer, payer) || !record.payee || !same(record.payee, payee)) throw new ConflictError('Payment context changed.');
    return record;
  };
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [account.address],
    readContract: (args) => aiRpc.readContract(args as Parameters<typeof aiRpc.readContract>[0]),
    verifyTypedData: (args) => {
      // Official SDK types admit broad objects; only this chain's canonical witness is verified.
      if (!same(args.address, payer) || args.domain.name !== 'Permit2' || args.domain.chainId !== 46630 ||
          typeof args.domain.verifyingContract !== 'string' || !same(args.domain.verifyingContract, PERMIT2_ADDRESS) ||
          JSON.stringify(args.types) !== JSON.stringify(permit2WitnessTypes))
        throw new ConflictError('Unexpected facilitator signature-verification domain.');
      const reviewed = args as unknown as Parameters<typeof aiRpc.verifyTypedData>[0];
      return aiRpc.verifyTypedData(reviewed);
    },
    getCode: (args: { address: Address }) => aiRpc.getCode(args),
    sendTransaction: async (): Promise<Hex> => { throw new ConflictError('Generic fee sponsorship is disabled.'); },
    writeContract: async (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint; dataSuffix?: Hex }): Promise<Hex> => {
      const record = await readRecord();
      const payment = record.paymentJournal;
      if (!record.request.answer || record.request.state !== 'settling' || !payment || payment.signed || args.functionName !== 'settle' ||
          !same(args.address, x402ExactPermit2ProxyAddress) || args.dataSuffix || args.gas && args.gas > 300000n)
        throw new ConflictError('Unreviewed facilitator write rejected.');
      const paymentPayload = payment.payload.payload as { permit2Authorization: { from: string; nonce: string; deadline: string; permitted: { token: string; amount: string }; witness: { to: string; validAfter: string } }; signature: Hex };
      const auth = paymentPayload.permit2Authorization;
      const permitted = args.args[0] as { permitted: { token: string; amount: bigint }; nonce: bigint; deadline: bigint };
      const witness = args.args[2] as { to: string; validAfter: bigint };
      if (args.args.length !== 4 || !permitted || !witness ||
          !same(permitted.permitted.token, TEST_USDG_ADDRESS) || permitted.permitted.amount !== AI_PRICE ||
          permitted.nonce !== BigInt(auth.nonce) || permitted.deadline !== BigInt(auth.deadline) ||
          !same(args.args[1] as string, payer) || !same(witness.to, payee) ||
          witness.validAfter !== BigInt(auth.witness.validAfter) || args.args[3] !== paymentPayload.signature)
        throw new ConflictError('Facilitator settlement differs from the saved signed authorization.');
      const data = exactProxyCall(payment, payer, payee);
      const current = await store.get<FeeLane>('local-ai:fee-lane');
      if (current?.id && current.id !== record.id) throw new ConflictError('Another fee transaction awaits reconciliation.');
      const nonce = await aiRpc.getTransactionCount({ address: account.address, blockTag: 'pending' });
      let envelope = current?.id === record.id ? current.envelope : null;
      if (!envelope) {
        if (current?.id) throw new ConflictError('An incomplete fee envelope needs operator reconciliation.');
        const fees = await aiRpc.estimateFeesPerGas();
        if (!fees.maxFeePerGas || fees.maxFeePerGas > 100000000000n)
          throw new ConflictError('Facilitator fee ceiling unavailable.');
        envelope = { chainId: 46630, to: x402ExactPermit2ProxyAddress, data, value: '0', nonce, gas: '300000',
          maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? 0n).toString() };
        if (current) await store.update<FeeLane>('local-ai:fee-lane', (lane) => {
          if (lane.id) throw new ConflictError('Another fee transaction awaits reconciliation.');
          return { id: record.id, envelope };
        });
        else await store.create<FeeLane>('local-ai:fee-lane', { id: record.id, envelope });
      }
      if (envelope.nonce !== nonce || envelope.chainId !== 46630 || !same(envelope.to, x402ExactPermit2ProxyAddress) ||
          envelope.data !== data || envelope.value !== '0' || envelope.gas !== '300000' ||
          BigInt(envelope.maxFeePerGas) > 100000000000n ||
          BigInt(envelope.maxPriorityFeePerGas) > BigInt(envelope.maxFeePerGas))
        throw new ConflictError('Saved fee transaction envelope changed; no replacement will be signed.');
      const signed = await account.signTransaction({ type: 'eip1559', chainId: envelope.chainId, to: envelope.to,
        data: envelope.data, value: 0n, nonce: envelope.nonce, gas: BigInt(envelope.gas),
        maxFeePerGas: BigInt(envelope.maxFeePerGas), maxPriorityFeePerGas: BigInt(envelope.maxPriorityFeePerGas) });
      const hash = keccak256(signed);
      await store.update<AiPaidRecord>(recordKey, (value) => {
        if (!value.request.answer || value.request.state !== 'settling' || !value.paymentJournal)
          throw new ConflictError('Inference output or settlement intent changed before payment.');
        if (value.paymentJournal.signed && value.paymentJournal.signed !== signed) throw new ConflictError('Signed fee transaction changed.');
        value.paymentJournal.signed = signed; value.paymentJournal.hash = hash; value.paymentJournal.nonce = envelope.nonce;
        return value;
      });
      try { await aiRpc.sendRawTransaction({ serializedTransaction: signed }); } catch { /* persisted bytes remain pending */ }
      return hash;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      const record = await readRecord();
      if (record.paymentJournal?.hash !== hash) throw new ConflictError('Unrecognized fee transaction.');
      const receipt = await aiRpc.waitForTransactionReceipt({ hash, timeout: 10000 });
      if (await inspectAiReceipt(record.paymentJournal, payer, payee) !== 'settled')
        throw new ConflictError('Canonical confirmed proxy transfer not yet proven.');
      return receipt;
    },
  };
  const facilitator = new x402Facilitator().register('eip155:46630', new ExactFacilitator(signer, { simulateInSettle: true, eip6492AllowedFactories: [] }));
  const client: FacilitatorClient = {
    getSupported: async () => {
      const supported = facilitator.getSupported();
      if (supported.kinds.some((kind) => kind.network !== 'eip155:46630' || kind.scheme !== 'exact'))
        throw new ConflictError('Unexpected payment facilitator capability.');
      return { ...supported, kinds: supported.kinds.map((kind) => ({ ...kind, network: 'eip155:46630' as const })) };
    },
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) => facilitator.verify(payload, requirements),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const record = await readRecord();
      if (!record.request.answer || !record.paymentJournal) throw new ConflictError('Inference output must be stored before charging.');
      if (record.paymentJournal.signed && record.paymentJournal.hash) {
        const outcome = await inspectAiReceipt(record.paymentJournal, payer, payee);
        if (outcome === 'pending') {
          try { await aiRpc.sendRawTransaction({ serializedTransaction: record.paymentJournal.signed }); } catch { /* same bytes only */ }
        }
        if (outcome !== 'pending') await store.update<FeeLane>('local-ai:fee-lane', (lane) =>
          lane.id === record.id ? { id: '', envelope: null } : lane);
        return { success: outcome === 'settled', transaction: record.paymentJournal.hash, network: 'eip155:46630', payer,
          ...(outcome === 'settled' ? { amount: AI_PRICE.toString() } : { errorReason: outcome === 'failed' ? 'transaction_failed' : 'settlement_pending' }) };
      }
      const result = await facilitator.settle(payload, requirements);
      const persisted = await readRecord();
      if (persisted.paymentJournal?.hash && result.transaction === persisted.paymentJournal.hash) {
        const outcome = await inspectAiReceipt(persisted.paymentJournal, payer, payee);
        if (outcome !== 'pending') await store.update<FeeLane>('local-ai:fee-lane', (lane) =>
          lane.id === record.id ? { id: '', envelope: null } : lane);
      }
      return result;
    },
  };
  const resource = new x402ResourceServer(client).register('eip155:46630', new ExactServer());
  await resource.initialize();
  return resource;
}
