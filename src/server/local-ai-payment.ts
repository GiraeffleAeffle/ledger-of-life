import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import { UptoEvmScheme as UptoFacilitator } from '@x402/evm/upto/facilitator';
import { PERMIT2_ADDRESS, isUptoPermit2Payload, uptoPermit2WitnessTypes, x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress, type UptoPermit2Payload, type FacilitatorEvmSigner } from '@x402/evm';
import { decodeEventLog, encodeFunctionData, keccak256, parseTransaction, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { inferenceCharge, inferenceMaximum, inferencePayee, aiRpc, aiTokenAbi, assertInferenceContracts } from './local-ai-runtime.ts';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { ConflictError } from './errors.ts';
import type { Store } from './store.ts';
import { address, createNoopSigner, createSolanaRpc, type Instruction } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, fetchMaybeToken, findAssociatedTokenPda, getApproveInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { addressesForHouse, depositRewardsInstruction } from '../finance/solana/house.ts';
import { loadSolanaHouseManifest } from './solana-house-config.ts';
import { configuredSolanaOperations } from './solana-operations.ts';
import { configuredFeeSponsor, SolanaServiceError } from './solana-service.ts';
import { loadBuildingManifest } from './building-revenue.ts';
import type { SolanaInferenceReview, LocalAiRequest } from './local-ai-types.ts';
import type { PaidAiOwner } from './local-ai.ts';
import type { ConnectorHost } from './local-ai-hosts.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { AI_PRICE } from '../domain/ai-pricing.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
import type { PreparedSolanaOperation, SolanaOperationResult, SolanaOperations } from './solana-operations.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';

export type AiPayment = { payload: PaymentPayload; requirements: PaymentRequirements; amount?: string; signed: Hex | null; hash: Hex | null; nonce: number | null };
export type AiPaidRecord = { id: string; owner: { payer: Address }; payee: Address | null; request: {
  answer: string | null; state: string; error: string | null; maxOutputTokens: number; usage: { outputTokens: number | null } | null; payment: { state: string; amountAtomic: string };
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
/** Proxy simulations must use the same msg.sender as the eventual fee transaction. */
export function facilitatorReadContract(facilitator: Address, rpc: typeof aiRpc = aiRpc): FacilitatorEvmSigner['readContract'] {
  return (args) => rpc.readContract({ ...args, account: facilitator } as Parameters<typeof aiRpc.readContract>[0]);
}
export function assertAiPaymentVerified(result: VerifyResponse, payer: Address) {
  if (result.isValid && result.payer?.toLowerCase() === payer.toLowerCase()) return;
  const reason = !result.isValid
    ? typeof result.invalidReason === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(result.invalidReason) ? result.invalidReason : 'verification_failed'
    : result.payer ? 'payer_mismatch' : 'payer_missing';
  const verifiedPayer = typeof result.payer === 'string' && /^0x[a-fA-F0-9]{40}$/.test(result.payer) ? result.payer : 'unavailable';
  throw new ConflictError(`Signed payment could not be verified: ${reason} (payer: ${verifiedPayer}).`);
}
export function validatePaymentPayload(payload: PaymentPayload, requirements: PaymentRequirements, id: string, payer: Address, payee: Address, url: string, maximum: bigint, facilitator: Address) {
  const identifier = payload.extensions?.['payment-identifier'];
  const info = identifier && typeof identifier === 'object' && 'info' in identifier ? identifier.info : null;
  if (payload.x402Version !== 2 || payload.accepted.scheme !== 'upto' || payload.accepted.network !== 'eip155:46630' ||
      requirements.scheme !== 'upto' || requirements.network !== 'eip155:46630' ||
      requirements.amount !== maximum.toString() || payload.accepted.amount !== requirements.amount || !same(requirements.asset, TEST_USDG_ADDRESS) || !same(requirements.payTo, payee) ||
      requirements.extra?.facilitatorAddress !== facilitator ||
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
      !('to' in auth.witness) || !('facilitator' in auth.witness) || typeof auth.witness.facilitator !== 'string' || !('validAfter' in auth.witness) ||
      typeof auth.from !== 'string' || typeof auth.spender !== 'string' ||
      typeof auth.permitted.token !== 'string' || typeof auth.permitted.amount !== 'string' ||
      typeof auth.witness.to !== 'string' || typeof auth.nonce !== 'string' ||
      typeof auth.deadline !== 'string' || typeof auth.witness.validAfter !== 'string')
    throw new ConflictError('Malformed Permit2 authorization.');
  const now = Math.floor(Date.now() / 1000);
  if (!same(auth.from, payer) || !same(auth.permitted.token, TEST_USDG_ADDRESS) || auth.permitted.amount !== maximum.toString() ||
      !same(auth.spender, x402UptoPermit2ProxyAddress) || !same(auth.witness.to, payee) || !same(auth.witness.facilitator, facilitator) ||
      !/^(0|[1-9][0-9]*)$/.test(auth.nonce) || !/^(0|[1-9][0-9]*)$/.test(auth.deadline) ||
      !/^(0|[1-9][0-9]*)$/.test(auth.witness.validAfter) || BigInt(auth.nonce) >= 2n ** 256n ||
      BigInt(auth.witness.validAfter) > BigInt(now) || BigInt(auth.deadline) < BigInt(now + 60) ||
      BigInt(auth.deadline) > BigInt(now + 20 * 60))
    throw new ConflictError('Payment signature exceeds the reviewed amount, recipient or lifetime.');
  return auth;
}
export function verifyCanonicalTransfer(receipt: TransactionReceipt, payer: Address, payee: Address, amount: bigint) {
  if (receipt.status !== 'success') return false;
  let matching = 0;
  for (const log of receipt.logs) {
    if (!same(log.address, TEST_USDG_ADDRESS)) continue;
    try {
      const event = decodeEventLog({ abi: aiTokenAbi, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === 'Transfer') {
        if (same(event.args.from, payer) || same(event.args.to, payee)) {
          if (!same(event.args.from, payer) || !same(event.args.to, payee) || event.args.value !== amount) return false;
          matching++;
        }
      }
    } catch { return false; }
  }
  return matching === 1;
}
export function uptoProxyCall(payment: AiPayment, payer: Address, payee: Address): Hex {
  const candidate = payment.payload.payload as UptoPermit2Payload;
  if (!isUptoPermit2Payload(candidate)) throw new ConflictError('Only a Permit2 upto authorization may settle.');
  const auth = candidate.permit2Authorization;
  const maximum = BigInt(payment.requirements.amount);
  const amount = BigInt(payment.amount ?? '-1');
  if (amount <= 0n || amount > maximum || !same(auth.from, payer) || !same(auth.permitted.token, TEST_USDG_ADDRESS) ||
      auth.permitted.amount !== maximum.toString() || !same(auth.spender, x402UptoPermit2ProxyAddress) ||
      !same(auth.witness.to, payee) || !same(auth.witness.facilitator, String(payment.requirements.extra?.facilitatorAddress)) ||
      !/^0x[a-fA-F0-9]{130}$/.test(candidate.signature))
    throw new ConflictError('Saved settlement authorization differs from this quote.');
  return encodeFunctionData({ abi: x402UptoPermit2ProxyABI, functionName: 'settle', args: [
    { permitted: { token: TEST_USDG_ADDRESS, amount: maximum }, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) },
    amount, payer, { to: payee, facilitator: auth.witness.facilitator as Address, validAfter: BigInt(auth.witness.validAfter) }, candidate.signature,
  ] });
}
type SettlementWrite = { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint; dataSuffix?: Hex };
/** The fee signer can encode only this saved authorization and this measured completed answer. */
export function reviewedAiSettlement(record: AiPaidRecord, payer: Address, payee: Address, args: SettlementWrite): Hex {
  const payment = record.paymentJournal;
  if (!record.request.answer || record.request.state !== 'settling' || !payment || payment.signed ||
      args.functionName !== 'settle' || !same(args.address, x402UptoPermit2ProxyAddress) ||
      args.dataSuffix || args.gas !== undefined && (args.gas <= 0n || args.gas > 300000n))
    throw new ConflictError('Unreviewed facilitator write rejected.');
  const maximum = inferenceMaximum(record.request.maxOutputTokens);
  const computed = inferenceCharge(record.request.usage?.outputTokens ?? null, maximum);
  if (payment.requirements.amount !== maximum.toString() || payment.amount !== computed.toString() ||
      record.request.payment.amountAtomic !== computed.toString())
    throw new ConflictError('Facilitator amount differs from measured usage.');
  const expected = uptoProxyCall(payment, payer, payee);
  let data: Hex;
  try { data = encodeFunctionData({ abi: args.abi, functionName: args.functionName, args: args.args } as Parameters<typeof encodeFunctionData>[0]); }
  catch { throw new ConflictError('Malformed facilitator settlement.'); }
  if (data !== expected) throw new ConflictError('Facilitator settlement differs from the saved signed authorization.');
  return data;
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
  try { expected = uptoProxyCall(payment, payer, payee); } catch { return 'pending'; }
  if (keccak256(payment.signed) !== payment.hash || receipt.transactionHash !== payment.hash || tx.hash !== payment.hash ||
      receipt.blockHash !== tx.blockHash || block.hash !== receipt.blockHash || tip < receipt.blockNumber + 2n ||
      !same(tx.from, signer) || !tx.to || !same(tx.to, x402UptoPermit2ProxyAddress) ||
      tx.input !== parsed.data || tx.input !== expected || tx.value !== 0n || tx.nonce !== payment.nonce || tx.chainId !== 46630 ||
      tx.gas !== parsed.gas || tx.maxFeePerGas !== parsed.maxFeePerGas ||
      (tx.maxPriorityFeePerGas ?? 0n) !== (parsed.maxPriorityFeePerGas ?? 0n)) return 'pending';
  if (receipt.status === 'reverted') return 'failed';
  return verifyCanonicalTransfer(receipt, payer, payee, BigInt(payment.amount!)) ? 'settled' : 'pending';
}
/** Expired, never-journaled signing may be abandoned; signed/ambiguous bytes are never released. */
export async function recoverExpiredUnsignedSettlement(
  store: Store, recordKey: string, payer: Address, payee: Address,
  rpc: typeof aiRpc = aiRpc, feeAddress?: Address, now = Date.now(),
): Promise<boolean> {
  const record = await store.get<AiPaidRecord>(recordKey);
  if (!record?.paymentJournal || !record.request.answer || !record.payee || !same(record.owner.payer, payer) || !same(record.payee, payee) ||
      record.paymentJournal.signed || record.paymentJournal.hash || record.request.state === 'completed') return false;
  const candidate = record.paymentJournal.payload.payload as UptoPermit2Payload;
  if (!isUptoPermit2Payload(candidate) || !/^(0|[1-9][0-9]*)$/.test(candidate.permit2Authorization.deadline) ||
      BigInt(candidate.permit2Authorization.deadline) >= BigInt(Math.floor(now / 1000))) return false;
  const lane = await store.get<FeeLane>('local-ai:fee-lane');
  if (lane?.id === record.id) {
    if (!lane.envelope || lane.envelope.data !== uptoProxyCall(record.paymentJournal, payer, payee))
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
    readContract: facilitatorReadContract(account.address),
    verifyTypedData: (args) => {
      // Official SDK types admit broad objects; only this chain's canonical witness is verified.
      if (!same(args.address, payer) || args.domain.name !== 'Permit2' || args.domain.chainId !== 46630 ||
          typeof args.domain.verifyingContract !== 'string' || !same(args.domain.verifyingContract, PERMIT2_ADDRESS) ||
          JSON.stringify(args.types) !== JSON.stringify(uptoPermit2WitnessTypes))
        throw new ConflictError('Unexpected facilitator signature-verification domain.');
      const reviewed = args as unknown as Parameters<typeof aiRpc.verifyTypedData>[0];
      return aiRpc.verifyTypedData(reviewed);
    },
    getCode: (args: { address: Address }) => aiRpc.getCode(args),
    sendTransaction: async (): Promise<Hex> => { throw new ConflictError('Generic fee sponsorship is disabled.'); },
    writeContract: async (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint; dataSuffix?: Hex }): Promise<Hex> => {
      const record = await readRecord();
      const payment = record.paymentJournal;
      const data = reviewedAiSettlement(record, payer, payee, args);
      if (!payment) throw new ConflictError('Missing saved payment.');
      const current = await store.get<FeeLane>('local-ai:fee-lane');
      if (current?.id && current.id !== record.id) throw new ConflictError('Another fee transaction awaits reconciliation.');
      const nonce = await aiRpc.getTransactionCount({ address: account.address, blockTag: 'pending' });
      let envelope = current?.id === record.id ? current.envelope : null;
      if (!envelope) {
        if (current?.id) throw new ConflictError('An incomplete fee envelope needs operator reconciliation.');
        const fees = await aiRpc.estimateFeesPerGas();
        if (!fees.maxFeePerGas || fees.maxFeePerGas > 100000000000n)
          throw new ConflictError('Facilitator fee ceiling unavailable.');
        envelope = { chainId: 46630, to: x402UptoPermit2ProxyAddress, data, value: '0', nonce, gas: '300000',
          maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? 0n).toString() };
        if (current) await store.update<FeeLane>('local-ai:fee-lane', (lane) => {
          if (lane.id) throw new ConflictError('Another fee transaction awaits reconciliation.');
          return { id: record.id, envelope };
        });
        else await store.create<FeeLane>('local-ai:fee-lane', { id: record.id, envelope });
      }
      if (envelope.nonce !== nonce || envelope.chainId !== 46630 || !same(envelope.to, x402UptoPermit2ProxyAddress) ||
          envelope.data !== data || envelope.value !== '0' || envelope.gas !== '300000' ||
          BigInt(envelope.maxFeePerGas) > 100000000000n ||
          BigInt(envelope.maxPriorityFeePerGas) > BigInt(envelope.maxFeePerGas))
        throw new ConflictError('Saved fee transaction envelope changed; no replacement will be signed.');
      const signed = await account.signTransaction({ type: 'eip1559', chainId: envelope.chainId, to: envelope.to,
        data: envelope.data, value: 0n, nonce: envelope.nonce, gas: BigInt(envelope.gas),
        maxFeePerGas: BigInt(envelope.maxFeePerGas), maxPriorityFeePerGas: BigInt(envelope.maxPriorityFeePerGas) });
      const hash = keccak256(signed);
      await store.update<AiPaidRecord>(recordKey, (value) => {
        if (!value.paymentJournal || reviewedAiSettlement(value, payer, payee, args) !== data)
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
  const facilitator = new x402Facilitator().register('eip155:46630', new UptoFacilitator(signer));
  const client: FacilitatorClient = {
    getSupported: async () => {
      const supported = facilitator.getSupported();
      if (supported.kinds.some((kind) => kind.network !== 'eip155:46630' || kind.scheme !== 'upto'))
        throw new ConflictError('Unexpected payment facilitator capability.');
      return { ...supported, kinds: supported.kinds.map((kind) => ({ ...kind, network: 'eip155:46630' as const })) };
    },
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) => facilitator.verify(payload, requirements),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const record = await readRecord();
      if (!record.request.answer || !record.paymentJournal) throw new ConflictError('Inference output must be stored before charging.');
      const amount = inferenceCharge(record.request.usage?.outputTokens ?? null, inferenceMaximum(record.request.maxOutputTokens));
      if (requirements.amount !== amount.toString() || record.paymentJournal.amount !== amount.toString() ||
          amount > BigInt(record.paymentJournal.requirements.amount)) throw new ConflictError('Unreviewed settlement amount.');
      if (amount === 0n) return { success: true, transaction: '', network: 'eip155:46630', payer, amount: '0' };
      if (record.paymentJournal.signed && record.paymentJournal.hash) {
        const outcome = await inspectAiReceipt(record.paymentJournal, payer, payee);
        if (outcome === 'pending') {
          try { await aiRpc.sendRawTransaction({ serializedTransaction: record.paymentJournal.signed }); } catch { /* same bytes only */ }
        }
        if (outcome !== 'pending') await store.update<FeeLane>('local-ai:fee-lane', (lane) =>
          lane.id === record.id ? { id: '', envelope: null } : lane);
        return { success: outcome === 'settled', transaction: record.paymentJournal.hash, network: 'eip155:46630', payer,
          ...(outcome === 'settled' ? { amount: amount.toString() } : { errorReason: outcome === 'failed' ? 'transaction_failed' : 'settlement_pending' }) };
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
  const resource = new x402ResourceServer(client).register('eip155:46630', new UptoServer());
  await resource.initialize();
  return resource;
}

export type SolanaAiJournal = { approvalId: string | null; settlementId: string | null };
type SolanaAiRecord = { id: string; owner: PaidAiOwner; request: LocalAiRequest; solanaJournal: SolanaAiJournal; completedAt?: string; progressEvents?: { authorizedAt?: string; finishedAt?: string } };
export const solanaAiEnabled = () => !!loadSolanaHouseManifest();
async function solanaAiContext(store: Store) {
  const manifest = loadSolanaHouseManifest();
  if (!manifest) throw new ConflictError('Solana house payments are not configured.');
  const context = await configuredSolanaOperations(store, { cluster: manifest.cluster, genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n });
  return { ...context, manifest };
}
export async function solanaAiRecipient(host: Pick<ConnectorHost, 'ownerSubject' | 'payoutWallet'> | null,
  dependencies?: { manifest: SolanaHouseManifest; distributor: string | null; wallet: (subject: string) => Promise<{ id: string; address: string } | null> }) {
  const manifest = dependencies?.manifest ?? loadSolanaHouseManifest();
  if (!manifest) throw new ConflictError('Solana house payments are not configured.');
  const distributor = dependencies ? dependencies.distributor : (await loadBuildingManifest())?.distributor;
  const payout = host?.payoutWallet ?? await inferencePayee();
  if (distributor && same(payout!, distributor))
    return { route: 'house' as const, payTo: manifest.houses['neighbourhood-homes'].house, hostOwnerSubject: host?.ownerSubject ?? null };
  if (!host?.ownerSubject) throw new ConflictError('This host has no verified owner for Solana payments.');
  // Plain Node payment tests cannot load Next's server-only identity module; lookup is lazy at its server boundary.
  const lookup = dependencies?.wallet ?? (await import('./identity.ts')).verifiedSolanaWalletForSubject;
  const wallet = await lookup(host.ownerSubject);
  if (!wallet) throw new ConflictError("This host's owner has no Solana wallet yet.");
  return { route: 'wallet' as const, payTo: wallet.address, hostOwnerSubject: host.ownerSubject };
}
export async function createSolanaAiQuote(id: string, owner: PaidAiOwner, maxOutputTokens: number, host: ConnectorHost | null) {
  const manifest = loadSolanaHouseManifest();
  const sponsor = await configuredFeeSponsor();
  if (!manifest || !sponsor) throw new ConflictError('Sponsored Solana AI payments are unavailable.');
  const recipient = await solanaAiRecipient(host);
  if (recipient.payTo === owner.payer || sponsor.address === owner.payer) throw new ConflictError('Paid requests require separate payer and provider wallets.');
  const [source] = await findAssociatedTokenPda({ owner: address(owner.payer), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return {
    walletId: owner.walletId, operationId: id, requestId: id, network: 'solana-devnet' as const,
    description: `Approve at most ${Number(inferenceMaximum(maxOutputTokens)) / 1e6} tUSDC for this answer; charge the host-reported token count capped by the job limit and UTF-8 bytes of answer plus reasoning received.`,
    asset: manifest.cashMint, payer: owner.payer, source, delegate: sponsor.address, ...recipient,
    maxOutputTokens, amountAtomic: inferenceMaximum(maxOutputTokens).toString(), priceAtomic: AI_PRICE.toString(),
  };
}
export function solanaAiApprovalInstructions(review: SolanaInferenceReview): Instruction[] {
  if (review.amountAtomic !== inferenceMaximum(review.maxOutputTokens).toString() || review.priceAtomic !== AI_PRICE.toString())
    throw new ConflictError('AI allowance differs from the reviewed token cap.');
  return [getApproveInstruction({ source: address(review.source), delegate: address(review.delegate), owner: createNoopSigner(address(review.payer)), amount: BigInt(review.amountAtomic) })];
}
/** Reserve one outstanding answer per token account: a new approve must not replace a running answer's allowance. */
async function reserveSolanaAiAllowance(store: Store, row: SolanaAiRecord, dependencies?: Pick<SolanaAiSettlementDependencies, 'context'>) {
  const lane = `local-ai:solana-allowance:${row.request.solanaReview!.payer}`;
  try { await store.create(lane, { requestId: row.id }); } catch {
    const previous = await store.get<{ requestId: string }>(lane);
    if (previous?.requestId === row.id) return;
    let active = previous ? await store.get<SolanaAiRecord>(`local-ai:request:${previous.requestId}`) : null;
    if (active?.request.solanaReview && active.solanaJournal.approvalId &&
        (active.request.approval?.state === 'review' || active.request.approval?.state === 'pending')) {
      await reconcileSolanaAiApproval(store, `local-ai:request:${active.id}`, dependencies);
      active = await store.get<SolanaAiRecord>(`local-ai:request:${active.id}`);
    }
    if (active?.request.approval?.state === 'pending') throw new ConflictError('Reconcile the earlier signed Solana approval before replacing its allowance.');
    if (active && !['completed', 'failed', 'expired', 'interrupted'].includes(active.request.state))
      throw new ConflictError('Finish or reconcile your earlier Solana AI question before replacing its allowance.');
    // An ambiguous settlement is never released, even if an outer request has failed.
    if (active && (active.solanaJournal.settlementId || active.request.answer && active.request.usage) &&
        active.request.payment.state !== 'settled' && active.request.payment.state !== 'failed')
      throw new ConflictError('The earlier Solana settlement must be reconciled first.');
    await store.update<{ requestId: string }>(lane, current => {
      if (current.requestId !== previous?.requestId) throw new ConflictError('Another question reserved this allowance.');
      return { requestId: row.id };
    });
  }
}
async function applySolanaAiApprovalResult(store: Store, key: string, result: SolanaOperationResult, prepared?: PreparedSolanaOperation) {
  return store.update<SolanaAiRecord>(key, current => {
    if (current.solanaJournal.approvalId && current.solanaJournal.approvalId !== result.id)
      throw new ConflictError('This question already has a different Solana approval.');
    if (prepared) {
      current.solanaJournal.approvalId = prepared.id;
      current.request.approval = { id: prepared.id, state: 'review', budgetAtomic: current.request.solanaReview!.amountAtomic,
        request: null, hash: null, error: null, solanaRequest: result.state === 'prepared'
          ? { ...prepared, operationId: `local-ai-approval:${current.id}`, description: current.request.solanaReview!.description, chain: 'solana:devnet' }
          : null };
    }
    const approval = current.request.approval;
    if (!approval) throw new ConflictError('This question has no saved Solana approval.');
    approval.hash = result.signature ?? null; approval.error = result.error ?? null;
    approval.state = result.state === 'prepared' ? 'review' : result.state === 'confirmed' ? 'completed' :
      result.state === 'failed' ? 'failed' : result.state === 'expired' ? 'expired' : 'pending';
    if (result.state !== 'prepared') approval.solanaRequest = null;
    if (current.request.recovery?.stage === 'approval') delete current.request.recovery;
    if (!current.request.answer && ['payment_required', 'approval_required', 'ready', 'expired'].includes(current.request.state)) {
      if (result.state === 'confirmed') {
        current.request.payment.state = 'authorized'; current.request.state = 'ready'; current.request.error = null;
        (current.progressEvents ??= {}).authorizedAt = new Date().toISOString();
        if (Date.now() >= Date.parse(current.request.expiresAt)) {
          current.request.state = 'expired';
          current.request.error = 'The inference quote expired before execution. The confirmed SPL allowance remains bounded; no inference tokens were charged.';
          current.request.recovery = { stage: 'approval', code: 'inference_quote_expired', retryable: false };
          current.completedAt = new Date().toISOString(); (current.progressEvents ??= {}).finishedAt = current.completedAt;
        }
      } else if (result.state === 'expired' || result.state === 'failed') {
        current.request.state = result.state === 'expired' ? 'expired' : 'failed';
        current.request.error = result.state === 'expired' && !result.signature
          ? 'This unsigned Solana approval review expired before submission. Create a new question for a new approval review. No inference tokens were charged.'
          : 'The Solana approval transaction did not complete. Create a new question for a new approval review. No inference tokens were charged.';
        approval.error ??= current.request.error;
        current.request.recovery = { stage: 'approval', code: result.state === 'failed' ? 'approval_failed' :
          result.signature ? 'approval_transaction_expired' : 'approval_expired', retryable: false };
        current.completedAt = new Date().toISOString(); (current.progressEvents ??= {}).finishedAt = current.completedAt;
      } else {
        current.request.state = 'approval_required';
      }
    }
    return current;
  });
}

/** Canonical operation state, not quote time, resolves a potentially signed approval. */
export async function reconcileSolanaAiApproval(store: Store, key: string, dependencies?: Pick<SolanaAiSettlementDependencies, 'context'>) {
  const row = await store.get<SolanaAiRecord>(key);
  if (!row?.request.solanaReview || !row.solanaJournal.approvalId ||
      (row.request.approval?.state !== 'review' && row.request.approval?.state !== 'pending')) return;
  try {
    const { operations } = await (dependencies?.context ?? solanaAiContext)(store);
    await applySolanaAiApprovalResult(store, key, await operations.reconcile({ id: row.solanaJournal.approvalId }));
  } catch (error) {
    const cause = settlementRecoveryCode(error), code = cause === 'settlement_unavailable' ? 'approval_unavailable' : cause;
    const saved = await store.update<SolanaAiRecord>(key, current => {
      if (current.request.approval?.state !== 'review' && current.request.approval?.state !== 'pending') return current;
      if (current.request.approval.state === 'pending' && current.request.state === 'expired') current.request.state = 'approval_required';
      current.request.error = 'Solana approval is unresolved. Check this saved question before approving another payment.';
      current.request.recovery = { stage: 'approval', code, retryable: !Object.hasOwn(settlementNonRetryableCodes, code) };
      return current;
    });
    if (saved.request.recovery?.stage === 'approval' && saved.request.recovery.code === code)
      console.warn('local-ai-approval', { requestId: row.id, stage: 'approval', code });
  }
}

export async function solanaAiApproval(store: Store, key: string, identity: VerifiedIdentity, action: unknown, signedTransaction?: unknown,
  dependencies?: Pick<SolanaAiSettlementDependencies, 'context'>) {
  const row = await store.get<SolanaAiRecord>(key), review = row?.request.solanaReview;
  if (!row || !review || row.owner.subject !== identity.subject || !identity.wallets.some(wallet => wallet.id === review.walletId && wallet.address === review.payer && wallet.chainType === 'solana'))
    throw new ConflictError('This Solana AI question belongs to another wallet.');
  const { operations, sponsor, manifest } = await (dependencies?.context ?? solanaAiContext)(store);
  if (review.delegate !== sponsor.address || review.asset !== manifest.cashMint) throw new ConflictError('Solana AI deployment changed; review a new question.');
  if (action === 'prepare') {
    if (!['payment_required', 'approval_required'].includes(row.request.state) || Date.now() >= Date.parse(row.request.expiresAt))
      throw new ConflictError('This AI quote is no longer available for approval.');
    await reserveSolanaAiAllowance(store, row, dependencies);
    const prepared = await operations.prepare({ identity, kind: 'ai-approve', requestId: row.id,
      actor: address(review.payer), walletId: review.walletId, instructions: solanaAiApprovalInstructions(review), review: { ...review },
      expectedDeltas: [{ account: review.source, mint: review.asset, owner: review.payer, direction: 'unchanged', minimumAtomic: '0', maximumAtomic: '0' }] });
    const result = await operations.reconcile({ identity, id: prepared.id });
    return (await applySolanaAiApprovalResult(store, key, result, prepared)).request.approval!;
  }
  if ((action !== 'submit' && action !== 'reconcile') || !row.solanaJournal.approvalId) throw new ConflictError('Prepare this Solana AI approval first.');
  const reconciled = await operations.reconcile({ identity, id: row.solanaJournal.approvalId });
  const result = action === 'submit' && reconciled.state === 'prepared'
    ? await operations.submit({ identity, id: row.solanaJournal.approvalId, signedTransactionBase64: typeof signedTransaction === 'string' ? signedTransaction : '' })
    : reconciled;
  return (await applySolanaAiApprovalResult(store, key, result)).request.approval!;
}
export async function solanaAiSettlementInstructions(review: SolanaInferenceReview, amount: bigint, programId: string) {
  if (amount < 0n || amount > BigInt(review.amountAtomic)) throw new ConflictError('Measured AI settlement exceeds the approval.');
  if (review.route === 'house') return [await depositRewardsInstruction({ authority: review.delegate, source: review.source, house: review.payTo, amount, sourceKind: 1, programId })];
  const [destination] = await findAssociatedTokenPda({ owner: address(review.payTo), mint: address(review.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const authority = createNoopSigner(address(review.delegate));
  return [
    getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: destination, owner: address(review.payTo), mint: address(review.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getTransferCheckedInstruction({ source: address(review.source), mint: address(review.asset), destination, authority, amount, decimals: 6 }),
  ];
}
export type SolanaAiSettlementContext = { operations: SolanaOperations; manifest: SolanaHouseManifest; sponsor: { address: string } };
export type SolanaAiSettlementDependencies = {
  context: (store: Store) => Promise<SolanaAiSettlementContext>;
  wallet: (subject: string) => Promise<{ id: string; address: string } | null>;
};
type SolanaAiSettlementStage = Exclude<NonNullable<LocalAiRequest['recovery']>['stage'], 'host' | 'approval'>;
const settlementServiceCodes: Record<string, true> = {
  invalid_operation: true, operation_owner: true, operation_pending: true, sponsor_configuration: true,
  sponsor_limit: true, sponsor_reservation: true, sponsor_subject_budget: true, sponsor_global_budget: true,
};
const settlementErrorCodes: Record<string, string> = {
  'Simulation bank changed; request a fresh review': 'simulation_bank_changed',
  'Exact transaction simulation failed': 'simulation_failed',
  'Wrong simulated token owner or mint': 'simulation_token_owner',
  'Missing simulated token balance': 'simulation_balance_missing',
  'Simulated token delta differs from review': 'simulation_delta_mismatch',
  'RPC unavailable': 'rpc_unavailable',
  'RPC request failed': 'rpc_unavailable',
};
const settlementNonRetryableCodes: Record<string, true> = {
  invalid_operation: true, operation_owner: true, sponsor_configuration: true,
  simulation_token_owner: true, simulation_balance_missing: true, simulation_delta_mismatch: true,
};
function settlementRecoveryCode(error: unknown) {
  if (error instanceof SolanaServiceError && Object.hasOwn(settlementServiceCodes, error.code)) return error.code;
  return error instanceof Error && Object.hasOwn(settlementErrorCodes, error.message) ? settlementErrorCodes[error.message] : 'settlement_unavailable';
}
export async function settleSolanaAi(store: Store, key: string, dependencies?: SolanaAiSettlementDependencies) {
  const row = await store.get<SolanaAiRecord>(key), review = row?.request.solanaReview;
  if (!row || !review || row.request.state === 'completed' || row.request.payment.state === 'settled') return;
  if (row.request.state !== 'settling' || !row.request.answer || !row.request.usage || row.request.approval?.state !== 'completed')
    throw new ConflictError('No completed approved Solana AI answer is available.');
  const amount = inferenceCharge(row.request.usage.outputTokens, BigInt(review.amountAtomic));
  if (amount.toString() !== row.request.payment.amountAtomic) throw new ConflictError('Saved AI usage differs from settlement.');
  let stage: SolanaAiSettlementStage = 'settlement_context';
  try {
    const { operations, manifest, sponsor } = await (dependencies?.context ?? solanaAiContext)(store);
    if (review.delegate !== sponsor.address || review.asset !== manifest.cashMint) throw new ConflictError('AI payment deployment changed.');
    let result: SolanaOperationResult | null = null;
    if (amount !== 0n) {
      if (row.solanaJournal.settlementId) {
        stage = 'settlement_reconcile';
        result = await operations.reconcile({ id: row.solanaJournal.settlementId });
      } else {
        stage = 'settlement_prepare';
        const intent = { kind: 'ai-settle', requestId: row.id, sponsorshipSubject: row.owner.subject,
          instructions: await solanaAiSettlementInstructions(review, amount, manifest.programId),
          review: { ...review, actualAmountAtomic: amount.toString(), sourceKind: 1 },
          expectedDeltas: await solanaAiSettlementDeltas(review, amount, manifest.programId) };
        // Preparation also finds operations from older releases whose signed-write succeeded
        // before the inference journal was linked. Persist that link before any signing.
        const prepared = await operations.prepareAsSponsor(intent);
        const linked = await store.update<SolanaAiRecord>(key, current => {
          if (current.solanaJournal.settlementId && current.solanaJournal.settlementId !== prepared.id)
            throw new ConflictError('This answer already has a different Solana settlement.');
          current.solanaJournal.settlementId = prepared.id;
          return current;
        });
        if (linked.request.state !== 'settling' || linked.request.payment.state === 'settled' || linked.request.payment.state === 'failed') return;
        stage = 'settlement_reconcile';
        result = await operations.reconcile({ id: prepared.id });
        if (result.state === 'prepared') {
          if (review.route === 'wallet') {
            stage = 'settlement_recipient';
            // Revalidate only before signing, never block recovery of already signed bytes.
            // Static Next server-only identity imports cannot run in focused Node payment tests.
            const lookup = dependencies?.wallet ?? (await import('./identity.ts')).verifiedSolanaWalletForSubject;
            const recipient = review.hostOwnerSubject ? await lookup(review.hostOwnerSubject) : null;
            if (!recipient || recipient.address !== review.payTo) throw new ConflictError('The host owner wallet changed; this answer cannot be settled to a different recipient.');
          }
          stage = 'settlement_submit';
          result = await operations.executeAsSponsor(intent);
        }
      }
    }
    await store.update<SolanaAiRecord>(key, current => {
      if (current.request.payment.state === 'settled' || current.request.payment.state === 'failed') return current;
      if (!result || result.state === 'confirmed') {
        current.request.payment.state = 'settled'; current.request.state = 'completed'; current.request.error = null;
        delete current.request.recovery;
        current.request.payment.receipt = { success: true, network: 'solana:devnet', payer: review.payer,
          transaction: result?.signature ?? '', amount: amount.toString() };
        current.completedAt = new Date().toISOString(); (current.progressEvents ??= {}).finishedAt = current.completedAt;
      } else if (result.state === 'failed' || result.state === 'expired') {
        current.request.payment.state = 'failed'; current.request.state = 'failed'; current.request.error = result.error ?? 'Solana AI settlement failed; no new settlement is created.';
        current.request.recovery = { stage: 'settlement_reconcile',
          code: result.state === 'expired' ? 'settlement_expired' : 'settlement_failed', retryable: false };
        (current.progressEvents ??= {}).finishedAt = new Date().toISOString();
      } else {
        current.request.payment.state = 'pending'; current.request.error = 'Solana settlement confirmation is pending. The saved answer remains private.';
        delete current.request.recovery;
      }
      return current;
    });
  } catch (error) {
    const code = settlementRecoveryCode(error);
    // If storage cannot safely read/update the record this rejects, rather than fabricating
    // a recoverable saved resource. Unknown signing outcomes remain linked and unresolved.
    const saved = await store.update<SolanaAiRecord>(key, current => {
      if (current.request.state !== 'settling' || current.request.payment.state === 'settled' || current.request.payment.state === 'failed') return current;
      current.request.payment.state = 'pending';
      current.request.error = 'Solana payment is unresolved. The saved answer remains private; check this request again without approving another payment.';
      current.request.recovery = { stage, code, retryable: !Object.hasOwn(settlementNonRetryableCodes, code) };
      return current;
    });
    if (saved.request.recovery?.stage === stage && saved.request.recovery.code === code)
      console.warn('local-ai-settlement', { requestId: row.id, stage, code });
  }
}
export async function solanaAiWalletBalance(payer: string, mint: string) {
  if (!process.env.SOLANA_RPC_URL) throw new ConflictError('Solana RPC is unavailable.');
  const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL);
  const [source] = await findAssociatedTokenPda({ owner: address(payer), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const token = await fetchMaybeToken(rpc, source, { commitment: 'confirmed' });
  return { cashAtomic: token.exists ? token.data.amount.toString() : '0', allowanceAtomic: token.exists ? token.data.delegatedAmount.toString() : '0' };
}

export async function solanaAiSettlementDeltas(review: SolanaInferenceReview, amount: bigint, programId: string): Promise<ExpectedTokenDelta[]> {
  const destination = review.route === 'house' ? (await addressesForHouse(review.payTo, programId)).rewardVault :
    (await findAssociatedTokenPda({ owner: address(review.payTo), mint: address(review.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  return [
    { account: review.source, mint: review.asset, owner: review.payer, direction: 'debit', minimumAtomic: amount.toString(), maximumAtomic: amount.toString() },
    { account: destination, mint: review.asset, owner: review.payTo, direction: 'credit', minimumAtomic: amount.toString(), maximumAtomic: amount.toString(), allowCreated: review.route === 'wallet' },
  ];
}
