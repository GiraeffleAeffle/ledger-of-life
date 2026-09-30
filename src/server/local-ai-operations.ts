import { randomUUID } from 'node:crypto';
import { encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import type { Store } from './store.ts';
import { AccessError, ConflictError } from './errors.ts';
import { WorkflowError } from '../domain/errors.ts';
import { AI_BUDGET, AI_MAX_OUTPUT, AI_MODEL, AI_PRICE, AI_CONTEXT_TOKENS, aiRpc, aiTokenAbi, assertInferenceContracts, inferencePayee } from './local-ai-runtime.ts';
import type { AiOwner, PaidAiOwner } from './local-ai.ts';
import type { LocalAiApproval, LocalAiRequest, LocalAiServiceStatus, LocalAiUsageSummary } from './local-ai-types.ts';
import { facilitatorAccount } from './local-ai-payment.ts';
import { publicConnectorHosts } from './local-ai-hosts.ts';
type ApprovalRecord = { signed: Hex | null; hash: Hex | null; transaction: NonNullable<LocalAiApproval['request']>['transaction'] };
type RecordRow = { id: string; mode: string; owner: AiOwner; request: LocalAiRequest; approvalJournal: ApprovalRecord | null; completedAt?: string };
function checked(record: RecordRow | null, owner: PaidAiOwner): asserts record is RecordRow {
  if (!record || !('payer' in owner) || !('payer' in record.owner) || record.owner.subject !== owner.subject ||
      record.owner.walletId !== owner.walletId || record.owner.payer.toLowerCase() !== owner.payer.toLowerCase())
    throw new AccessError('No request belongs to this wallet.');
}
export async function aiApproval(store: Store, id: string, owner: PaidAiOwner, action: unknown, signedTransaction?: unknown) {
  const key = `local-ai:request:${id}`;
  const row = await store.get<RecordRow>(key);
  checked(row, owner);
  if (row.mode !== 'paid' || !row.request.paymentRequired) throw new ConflictError('Only a paid quoted request can approve Permit2.');
  if (action === 'prepare') {
    if (row.request.state === 'expired' || Date.now() >= Date.parse(row.request.expiresAt))
      throw new ConflictError('This paid inference quote expired; create a new reviewed request.');
    await assertInferenceContracts();
    const allowance = await aiRpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'allowance', args: [owner.payer, PERMIT2_ADDRESS] });
    if (allowance >= AI_PRICE && allowance <= AI_BUDGET) {
      return { id: `local-ai-approval:${id}`, state: 'completed', budgetAtomic: AI_BUDGET.toString(),
        request: null, hash: null, error: null } satisfies LocalAiApproval;
    }
    if (row.request.approval && (row.request.approval.state === 'pending' ||
        row.request.approval.state === 'review' && row.request.approval.request &&
        Date.now() < Date.parse(row.request.approval.request.expiresAt))) return row.request.approval;
    const [nonce, latest, fees, native] = await Promise.all([
      aiRpc.getTransactionCount({ address: owner.payer, blockTag: 'pending' }),
      aiRpc.getTransactionCount({ address: owner.payer, blockTag: 'latest' }), aiRpc.estimateFeesPerGas(),
      aiRpc.getBalance({ address: owner.payer }),
    ]);
    if (nonce !== latest || !fees.maxFeePerGas || fees.maxFeePerGas > 100000000000n || native < fees.maxFeePerGas * 90000n)
      throw new ConflictError('Wallet nonce is busy or native testnet gas is insufficient for this finite approval.');
    const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
    const transaction = { chainId: 46630 as const, to: TEST_USDG_ADDRESS,
      data: encodeFunctionData({ abi: aiTokenAbi, functionName: 'approve', args: [PERMIT2_ADDRESS, AI_BUDGET] }),
      value: '0x0' as const, nonce, gasLimit: '0x15f90' as const,
      maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}` as Hex,
      maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}` as Hex };
    const approval: LocalAiApproval = { id: `local-ai-approval:${randomUUID()}`, state: 'review', budgetAtomic: AI_BUDGET.toString(),
      request: { walletId: owner.walletId, operationId: `local-ai-approval:${id}`, description: 'Approve a finite 0.10 tUSDG budget for Permit2; each answer separately authorizes exactly 0.01 tUSDG', expiresAt: expiry, transaction }, hash: null, error: null };
    const result = await store.update<RecordRow>(key, (value) => {
      checked(value, owner);
      if (!value.approvalJournal?.signed && (!value.request.approval || value.request.approval.state !== 'pending')) {
        value.request.approval = approval; value.request.state = 'approval_required';
        value.approvalJournal = { signed: null, hash: null, transaction };
      }
      return value;
    });
    return result.request.approval;
  }
  if (action !== 'submit' && action !== 'reconcile') throw new WorkflowError('Unknown approval action.');
  if (!row.request.approval || !row.approvalJournal) throw new ConflictError('Prepare a finite approval before signing.');
  const approval = row.request.approval;
  if (action === 'submit') {
    if (typeof signedTransaction !== 'string' || !/^0x02(?:[a-fA-F0-9]{2})+$/.test(signedTransaction) || signedTransaction.length > 20000)
      throw new WorkflowError('Provide a canonical signed approval transaction.');
    const serialized = signedTransaction as `0x02${string}`;
    const parsed = parseTransaction(serialized);
    const expected = row.approvalJournal.transaction;
    if (parsed.type !== 'eip1559' || parsed.chainId !== 46630 || !parsed.to || parsed.to.toLowerCase() !== TEST_USDG_ADDRESS.toLowerCase() ||
        parsed.data !== expected.data || parsed.nonce !== expected.nonce || parsed.value !== undefined && parsed.value !== 0n ||
        parsed.gas !== BigInt(expected.gasLimit!) || parsed.maxFeePerGas !== BigInt(expected.maxFeePerGas!) ||
        (parsed.maxPriorityFeePerGas ?? 0n) !== BigInt(expected.maxPriorityFeePerGas!) || parsed.accessList?.length)
      throw new ConflictError('Signed approval changed the finite spend, nonce, fee, or token.');
    const recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
    if (recovered.toLowerCase() !== owner.payer.toLowerCase()) throw new AccessError('Signed approval belongs to another wallet.');
    if (row.approvalJournal.signed && row.approvalJournal.signed !== serialized) throw new ConflictError('Only identical signed approval bytes may be retried.');
    if (!row.approvalJournal.signed) {
      if (approval.state !== 'review' || Date.now() >= Date.parse(approval.request!.expiresAt)) throw new ConflictError('Approval review expired.');
      await store.update<RecordRow>(key, (value) => {
        checked(value, owner);
        if (value.approvalJournal?.signed) {
          if (value.approvalJournal.signed !== serialized) throw new ConflictError('Approval already signed differently.');
          return value;
        }
        value.approvalJournal!.signed = serialized; value.approvalJournal!.hash = keccak256(serialized);
        value.request.approval!.hash = keccak256(serialized); value.request.approval!.state = 'pending';
        return value;
      });
    }
  }
  const pending = await store.get<RecordRow>(key);
  checked(pending, owner);
  const journal = pending.approvalJournal!;
  if (pending.request.approval?.state === 'completed' || pending.request.approval?.state === 'failed') return pending.request.approval;
  if (!journal.signed || !journal.hash) throw new ConflictError('No signed approval to reconcile.');
  let receipt;
  try { receipt = await aiRpc.getTransactionReceipt({ hash: journal.hash }); } catch { /* unknown receipt */ }
  if (!receipt) {
    try { await aiRpc.sendRawTransaction({ serializedTransaction: journal.signed }); } catch { /* retry same signed bytes */ }
    return pending.request.approval;
  }
  const [transaction, block, tip, allowance] = await Promise.all([
    aiRpc.getTransaction({ hash: journal.hash }), aiRpc.getBlock({ blockNumber: receipt.blockNumber }), aiRpc.getBlockNumber(),
    aiRpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'allowance', args: [owner.payer, PERMIT2_ADDRESS] }),
  ]);
  if (transaction.hash !== journal.hash || transaction.blockHash !== receipt.blockHash || block.hash !== receipt.blockHash ||
      tip < receipt.blockNumber + 2n || transaction.chainId !== 46630 || transaction.from.toLowerCase() !== owner.payer.toLowerCase() ||
      transaction.to?.toLowerCase() !== TEST_USDG_ADDRESS.toLowerCase() || transaction.input !== journal.transaction.data ||
      transaction.nonce !== journal.transaction.nonce || transaction.value !== 0n) return pending.request.approval;
  return (await store.update<RecordRow>(key, (value) => {
    checked(value, owner);
    if (value.approvalJournal?.hash !== journal.hash) throw new ConflictError('Signed approval changed.');
    if (value.request.approval?.state !== 'pending') return value;
    value.request.approval.state = receipt.status === 'success' && allowance >= AI_PRICE && allowance <= AI_BUDGET ? 'completed' : 'failed';
    value.request.approval.error = value.request.approval.state === 'failed' ? 'Finite approval did not confirm; no inference payment was sent.' : null;
    if (value.request.approval.state === 'completed' && value.request.state === 'approval_required')
      value.request.state = 'payment_required';
    return value;
  })).request.approval;
}
export async function localAiUsage(store: Store): Promise<LocalAiUsageSummary> {
  const result: LocalAiUsageSummary = { successfulPaidRequests: 0, successfulLibraryRequests: 0, failedRequests: 0,
    pendingPayments: 0, knownInputTokens: 0, knownOutputTokens: 0, requestsWithoutUsage: 0,
    meanWallMs: null, meanTokensPerSecond: null, settledAtomic: '0', asset: TEST_USDG_ADDRESS,
    network: 'eip155:46630', model: AI_MODEL, lastSuccessAt: null };
  let cursor = '', counted = 0, speedCount = 0, speed = 0;
  do {
    const rows = await store.scan<RecordRow>('local-ai:request:', cursor, 500);
    for (const { key, value } of rows) {
      cursor = key;
      const request = value.request;
      if (request.state === 'failed' || request.state === 'interrupted') result.failedRequests++;
      if (request.mode === 'paid' && request.payment.state === 'pending') result.pendingPayments++;
      if (request.state !== 'completed') continue;
      if (request.mode === 'paid') result.successfulPaidRequests++;
      else result.successfulLibraryRequests++;
      if (value.completedAt && (!result.lastSuccessAt || value.completedAt > result.lastSuccessAt))
        result.lastSuccessAt = value.completedAt;
      if (!request.usage) result.requestsWithoutUsage++;
      else {
        if (request.usage.inputTokens === null || request.usage.outputTokens === null) result.requestsWithoutUsage++;
        result.knownInputTokens += request.usage.inputTokens ?? 0;
        result.knownOutputTokens += request.usage.outputTokens ?? 0;
        counted++; result.meanWallMs = (result.meanWallMs ?? 0) + request.usage.wallMs;
        if (request.usage.tokensPerSecond !== null) { speed += request.usage.tokensPerSecond; speedCount++; }
      }
    }
    if (rows.length < 500) break;
  } while (true);
  if (counted) result.meanWallMs = Math.round(result.meanWallMs! / counted);
  if (speedCount) result.meanTokensPerSecond = Math.round(speed / speedCount * 100) / 100;
  result.settledAtomic = (BigInt(result.successfulPaidRequests) * AI_PRICE).toString();
  return result;
}
export async function localAiStatus(store: Store, owner?: AiOwner): Promise<LocalAiServiceStatus> {
  const hosts = await publicConnectorHosts(store);
  const connectorHosts = hosts.filter((host) => host.state === 'active' && host.models.includes(AI_MODEL) && host.payoutWallet &&
    (!owner || !('payer' in owner) || host.payoutWallet.toLowerCase() !== owner.payer.toLowerCase()));
  connectorHosts.sort((a, b) => Number(b.ownerSubject === (owner && 'subject' in owner ? owner.subject : '')) -
    Number(a.ownerSubject === (owner && 'subject' in owner ? owner.subject : '')));
  const direct = !!process.env.LOCAL_AI_OLLAMA_URL;
  const selected = connectorHosts.find((host) => host.availability === 'online' || host.availability === 'asleep' && host.canWake);
  const configured = direct || connectorHosts.length > 0;
  let reachable = false, modelResident = false, vramBytes: number | null = null, error: string | null = null, paidEnabled = false;
  let payee: Address | null = null;
  if (direct) {
    try {
      const response = await fetch(`${process.env.LOCAL_AI_OLLAMA_URL!.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Local model status is unavailable.');
      const data = await response.json() as { models?: { name?: string; size_vram?: number }[] };
      reachable = true;
      const resident = data.models?.find((model) => model.name === AI_MODEL);
      modelResident = !!resident;
      vramBytes = resident && Number.isFinite(resident.size_vram) ? resident.size_vram! : null;
    } catch { error = 'Local model endpoint is unreachable.'; }
  } else if (selected) { reachable = true; }
  else error = configured ? 'Connector hosts are asleep or offline.' : 'No paired inference host is configured.';
  try {
    payee = direct ? await inferencePayee() : selected ? selected.payoutWallet as Address : null;
    if (!payee) throw new ConflictError('No online connector payout is available.');
    await assertInferenceContracts();
    const account = await facilitatorAccount();
    const gas = await aiRpc.getBalance({ address: account.address });
    paidEnabled = gas > 50000000000000n && (!owner || !('payer' in owner) ||
      account.address.toLowerCase() !== owner.payer.toLowerCase() && payee.toLowerCase() !== owner.payer.toLowerCase());
    if (!paidEnabled) error ??= 'Dedicated facilitator gas or separate payment recipient is unavailable.';
  } catch { error ??= 'Payment configuration or reviewed contracts are unavailable.'; }
  let wallet: LocalAiServiceStatus['wallet'] = null;
  if (owner && 'payer' in owner) {
    wallet = { walletId: owner.walletId, address: owner.payer, cashAtomic: null, nativeAtomic: null, allowanceAtomic: null, error: null };
    try {
      const [cash, native, allowance] = await Promise.all([
        aiRpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'balanceOf', args: [owner.payer] }),
        aiRpc.getBalance({ address: owner.payer }),
        aiRpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'allowance', args: [owner.payer, PERMIT2_ADDRESS] }),
      ]);
      wallet.cashAtomic = cash.toString(); wallet.nativeAtomic = native.toString(); wallet.allowanceAtomic = allowance.toString();
    } catch { wallet.error = 'Wallet balances could not be verified.'; }
  }
  const free = process.env.LOCAL_AI_LIBRARY_ENABLED === '1';
  const global = await store.get<{ attempts: number }>(`local-ai:library-day:${new Date().toISOString().slice(0, 10)}`);
  let remainingRequests = Math.max(0, 30 - (global?.attempts ?? 0));
  if (owner && 'visitor' in owner) {
    const quota = await store.get<{ count: number }>(`local-ai:visitor:${owner.visitor}`);
    remainingRequests = Math.min(remainingRequests, Math.max(0, 3 - (quota?.count ?? 0)));
  } else remainingRequests = Math.min(remainingRequests, 3);
  const usage = await localAiUsage(store);
  return { configured, reachable, model: AI_MODEL, contextTokens: AI_CONTEXT_TOKENS, maxOutputTokens: AI_MAX_OUTPUT, hosts,
    lastSuccessAt: usage.lastSuccessAt, modelResident, vramBytes,
    hardwareLabel: direct ? process.env.LOCAL_AI_HARDWARE_LABEL || 'Local inference host' : selected?.name || 'Outbound connector hosts',
    paidEnabled: paidEnabled && configured && reachable, error,
    price: payee ? { network: 'eip155:46630', asset: TEST_USDG_ADDRESS, symbol: 'tUSDG', decimals: 6,
      amountAtomic: AI_PRICE.toString(), payTo: payee, permit2: PERMIT2_ADDRESS,
      proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001', approvalBudgetAtomic: AI_BUDGET.toString() } : null,
    wallet, library: { enabled: free && direct && reachable, maxOutputTokens: AI_MAX_OUTPUT, remainingRequests } };
}
