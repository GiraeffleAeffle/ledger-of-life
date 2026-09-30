import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import {
  atomic,
  buildEscrowInstruction,
  deriveEscrowAddresses,
  derivePayoutAddress,
  messageDigest,
  SOLANA_MAINNET_MANIFEST,
  SOLANA_TEST_USDC_MINT,
  type EscrowAction,
  type ExpectedTokenDelta,
} from '../finance/solana/index.ts';
import { agreementDigest, agreementRole, type Agreement } from './agreements.ts';
import { requireWalletRecovery, type RecoveryGate } from './recovery.ts';
import type { Store } from './store.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import {
  RpcSolanaGateway,
  EscrowAbsentError,
  solanaConfiguration,
  type SolanaConfiguration,
  type SolanaGateway,
  type SolanaSnapshot,
  type SolanaSimulation,
} from './solana-rpc.ts';

export class SolanaServiceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SolanaServiceError';
    this.status = status;
    this.code = code;
  }
}
function fail(code: string, message: string, status = 409): never {
  throw new SolanaServiceError(status, code, message);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function signingKey(wallet: string) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(getAddressEncoder().encode(address(wallet))),
    ]),
    format: 'der',
    type: 'spki',
  });
}
/** One wallet approval for a short, fixed sequence of escrow instructions (pull-v2 settlement). */
export type BundleAction =
  | { kind: 'fund_and_supply' }
  | { kind: 'accept_and_settle' }
  | { kind: 'resolve_and_settle'; amountAtomic: string }
  | { kind: 'redeem_and_settle' };
export type ServiceAction = EscrowAction | BundleAction;
export type SolanaOperation = {
  id: string;
  requestId: string;
  fingerprint: string;
  agreementId: string;
  subject: string;
  walletId: string;
  actor: string;
  role: 'tenant' | 'landlord' | 'arbitrator';
  action: ServiceAction;
  /** Escrow instructions in this transaction; each consumes one tenancy nonce. */
  steps?: number;
  deployment: { genesisHash: string; escrowProgram: string; programSha256: string };
  nonce: string;
  state: 'prepared' | 'signed' | 'broadcast' | 'unknown' | 'finalized' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  lastValidBlockHeight: string;
  messageSha256: string;
  transactionBase64: string;
  signedTxBase64: string | null;
  signature: string | null;
  simulation: SolanaSimulation;
  expectedDeltas: ExpectedTokenDelta[];
  receipt: unknown | null;
  lastError: string | null;
};
type Lane = {
  network: 'solana';
  genesisHash: string;
  tenancy: string;
  operations: SolanaOperation[];
  payoutAttempts?: { side: 'tenant' | 'landlord'; nonce: string; at: string; error: string }[];
};
export type FeeSponsor = {
  address: string;
  sign(transactionBytes: Uint8Array): Promise<Uint8Array>;
};
type Dependencies = {
  store: Store;
  config: SolanaConfiguration;
  gateway: SolanaGateway;
  sponsor: FeeSponsor;
  now?: () => number;
  recoveryGate?: RecoveryGate;
};
function publicOperation(op: SolanaOperation) {
  const { signedTxBase64: _, subject: __, fingerprint: ___, ...visible } = op;
  void _;
  void __;
  void ___;
  return visible;
}
function strictFields(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    fail('invalid_action', 'Unexpected action field.', 400);
}
export function decodeSolanaAction(value: unknown, source: string): ServiceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_action', 'Choose a supported escrow action.', 400);
  const row = value as Record<string, unknown>;
  const amount = (key: string) => {
    try {
      atomic(row[key]);
      return row[key] as string;
    } catch {
      return fail('invalid_amount', 'Use a canonical atomic-unit amount.', 400);
    }
  };
  switch (row.kind) {
    case 'fund':
    case 'fund_and_supply':
    case 'accept_and_settle':
    case 'redeem_and_settle':
      strictFields(row, ['kind']);
      return row.kind === 'fund' ? { kind: 'fund', source } : { kind: row.kind };
    case 'settle':
      strictFields(row, ['kind']);
      return { kind: 'settle' };
    case 'payout':
      strictFields(row, ['kind', 'landlord']);
      if (typeof row.landlord !== 'boolean')
        fail('invalid_action', 'Choose which fixed payout is due.', 400);
      return { kind: 'payout', landlord: row.landlord };
    case 'supply':
    case 'release_earnings':
    case 'propose_claim':
    case 'resolve_claim':
    case 'resolve_and_settle':
      strictFields(row, ['kind', 'amountAtomic']);
      return { kind: row.kind, amountAtomic: amount('amountAtomic') };
    case 'redeem':
      strictFields(row, ['kind', 'receiptAtomic', 'minimumReceivedAtomic']);
      return {
        kind: 'redeem',
        receiptAtomic: amount('receiptAtomic'),
        minimumReceivedAtomic: amount('minimumReceivedAtomic'),
      };
    case 'respond_to_claim':
      strictFields(row, ['kind', 'accept']);
      if (typeof row.accept !== 'boolean')
        fail('invalid_action', 'Choose acceptance or dispute.', 400);
      return { kind: 'respond_to_claim', accept: row.accept };
    default:
      return fail(
        'unsupported_action',
        'This endpoint only supports restricted test escrow actions.',
        400,
      );
  }
}
function allowed(action: ServiceAction, role: string, snapshot: SolanaSnapshot, config: SolanaConfiguration) {
  const phase = snapshot.tenancy.phase;
  const pull = config.escrowVersion === 'pull-v2';
  if (snapshot.tenancy.depositMint === SOLANA_TEST_USDC_MINT &&
    (action.kind === 'supply' || action.kind === 'release_earnings' || action.kind === 'redeem'))
    fail('action_not_available', 'This test-dollar deposit stays in cash and has no lending earnings.', 403);
  const valid =
    action.kind === 'fund' || action.kind === 'fund_and_supply'
      ? role === 'tenant' && phase === 'awaiting-funding'
      : action.kind === 'supply' || action.kind === 'release_earnings'
        ? role === 'tenant' && phase === 'active'
        : action.kind === 'redeem'
          ? (role === 'tenant' && phase === 'active') || phase === 'settling'
          : action.kind === 'propose_claim'
            ? role === 'landlord' && phase === 'active'
            : action.kind === 'respond_to_claim'
              ? role === 'tenant' && phase === 'claim-proposed'
              : action.kind === 'accept_and_settle'
                ? pull && role === 'tenant' && phase === 'claim-proposed'
                : action.kind === 'resolve_claim'
                  ? role === 'arbitrator' && phase === 'disputed'
                  : action.kind === 'resolve_and_settle'
                    ? pull && role === 'arbitrator' && phase === 'disputed'
                    : action.kind === 'redeem_and_settle'
                      ? pull && phase === 'settling'
                      : action.kind === 'payout'
                        ? pull && phase === 'closed' &&
                          atomic(action.landlord ? snapshot.tenancy.landlordOwedAtomic : snapshot.tenancy.tenantOwedAtomic) > 0n
                        : phase === 'settling';
  if (!valid)
    fail(
      'action_not_available',
      'This action is not available to this party in the current tenancy state.',
      403,
    );
}
/** Expand a bundle into the exact escrow instructions it signs, in nonce order. */
function stepsFor(action: ServiceAction, snapshot: SolanaSnapshot): EscrowAction[] {
  const t = snapshot.tenancy;
  const redeemAll: EscrowAction[] = atomic(t.accountedReceiptsAtomic) > 0n
    ? [{ kind: 'redeem', receiptAtomic: t.accountedReceiptsAtomic, minimumReceivedAtomic: snapshot.receiptValueAtomic }]
    : [];
  switch (action.kind) {
    case 'fund_and_supply':
      return [{ kind: 'fund', source: t.tenantDestination }, { kind: 'supply', amountAtomic: t.requiredSecurityAtomic }];
    case 'accept_and_settle':
      return [{ kind: 'respond_to_claim', accept: true }, ...redeemAll, { kind: 'settle' }];
    case 'resolve_and_settle':
      return [{ kind: 'resolve_claim', amountAtomic: action.amountAtomic }, ...redeemAll, { kind: 'settle' }];
    case 'redeem_and_settle':
      return [...redeemAll, { kind: 'settle' }];
    default:
      return [action];
  }
}
async function deltasFor(
  action: EscrowAction,
  snapshot: SolanaSnapshot,
  config: SolanaConfiguration,
): Promise<ExpectedTokenDelta[]> {
  const t = snapshot.tenancy,
    derived = await deriveEscrowAddresses(config.escrowProgram, t.tenant, t.leaseId);
  const delta = (
    account: string,
    mint: string,
    owner: string,
    direction: 'credit' | 'debit',
    min: string,
    max = min,
  ): ExpectedTokenDelta => ({
    account,
    mint,
    owner,
    direction,
    minimumAtomic: min,
    maximumAtomic: max,
  });
  switch (action.kind) {
    case 'fund':
      return [
        delta(t.tenantDestination, t.depositMint, t.tenant, 'debit', t.requiredSecurityAtomic),
        delta(derived.cash, t.depositMint, t.address, 'credit', t.requiredSecurityAtomic),
      ];
    case 'supply':
      return [
        delta(derived.cash, t.depositMint, t.address, 'debit', '1', action.amountAtomic),
        delta(derived.receipts, t.receiptMint, t.address, 'credit', '1', '18446744073709551615'),
      ];
    case 'redeem':
      return [
        delta(derived.receipts, t.receiptMint, t.address, 'debit', action.receiptAtomic),
        delta(
          derived.cash,
          t.depositMint,
          t.address,
          'credit',
          atomic(action.minimumReceivedAtomic) > 0n ? action.minimumReceivedAtomic : '1',
          '18446744073709551615',
        ),
      ];
    case 'release_earnings':
      return [
        delta(derived.cash, t.depositMint, t.address, 'debit', action.amountAtomic),
        delta(t.tenantDestination, t.depositMint, t.tenant, 'credit', action.amountAtomic),
      ];
    case 'settle':
      return config.escrowVersion === 'pull-v2' ? [] : [
        delta(derived.cash, t.depositMint, t.address, 'debit', t.accountedIdleAtomic),
        delta(t.landlordDestination, t.depositMint, t.landlord, 'credit', t.approvedClaimAtomic),
        delta(
          t.tenantDestination,
          t.depositMint,
          t.tenant,
          'credit',
          (atomic(t.accountedIdleAtomic) - atomic(t.approvedClaimAtomic)).toString(),
        ),
      ];
    case 'payout': {
      const amount = action.landlord ? t.landlordOwedAtomic : t.tenantOwedAtomic;
      return [
        delta(derived.cash, t.depositMint, t.address, 'debit', amount),
        delta(action.landlord ? t.landlordDestination : t.tenantDestination, t.depositMint,
          action.landlord ? t.landlord : t.tenant, 'credit', amount),
      ];
    }
    default:
      return [];
  }
}
/** Net token effects a finalized bundle must show; intermediate hops inside the escrow cancel out. */
async function bundleDeltas(
  action: ServiceAction,
  steps: EscrowAction[],
  snapshot: SolanaSnapshot,
  config: SolanaConfiguration,
): Promise<ExpectedTokenDelta[]> {
  if (steps.length === 1) return deltasFor(steps[0], snapshot, config);
  if (action.kind === 'fund_and_supply') {
    const [tenantDebit] = await deltasFor(steps[0], snapshot, config);
    const [, receiptCredit] = await deltasFor(steps[1], snapshot, config);
    return [tenantDebit, receiptCredit];
  }
  // Settlement bundles only exist for pull-v2, whose settle moves no tokens.
  const redeem = steps.find((step) => step.kind === 'redeem');
  return redeem ? deltasFor(redeem, snapshot, config) : [];
}

export function createSolanaService(dependencies: Dependencies) {
  const { store, config, gateway, sponsor } = dependencies;
  const now = dependencies.now ?? Date.now;
  const recovery = dependencies.recoveryGate ?? requireWalletRecovery;
  if (
    !['devnet', 'localnet'].includes(config.cluster) ||
    config.genesisHash === SOLANA_MAINNET_MANIFEST.genesisHash
  )
    fail('mainnet_disabled', 'Mainnet execution is disabled.', 503);
  const laneKey = `solana-lane:${hash(config.genesisHash + ':' + config.tenancyAddress)}`;
  async function lane() {
    let found = await store.get<Lane>(laneKey);
    if (!found) {
      try {
        await store.create<Lane>(laneKey, {
          network: 'solana',
          genesisHash: config.genesisHash,
          tenancy: config.tenancyAddress,
          operations: [],
        });
      } catch {
        if (!(await store.get(laneKey))) throw new Error('Operation storage unavailable');
      }
      found = await store.get<Lane>(laneKey);
    }
    return found!;
  }
  async function requireFundingOpen(identity: VerifiedIdentity, action: { kind: string }) {
    if (action.kind !== 'fund' && action.kind !== 'fund_and_supply') return;
    const agreement = await store.get<Agreement>(`agreement:${config.agreementId}`);
    if (agreement?.cancelled) {
      agreementRole(agreement, identity);
      fail('agreement_cancelled', 'This tenancy was cancelled before the deposit was secured.');
    }
  }
  async function access(identity: VerifiedIdentity) {
    const agreement = await store.get<Agreement>(`agreement:${config.agreementId}`);
    if (!agreement || agreement.network !== 'solana')
      fail('agreement_unavailable', 'A recorded Solana tenancy is required.', 403);
    const role = agreementRole(agreement, identity),
      party = agreement.parties[role]!;
    if (party.wallet.chainType !== 'solana' || identity.expiresAt * 1000 <= now())
      fail('identity_expired', 'Sign in again before authorizing test funds.', 401);
    await recovery(store, identity, party.wallet.id);
    const digest = agreementDigest(agreement);
    if (
      !digest ||
      agreement.accepted.tenant?.digest !== digest ||
      agreement.accepted.landlord?.digest !== digest
    )
      fail(
        'agreement_not_accepted',
        'Tenant and landlord must accept the same complete agreement.',
      );
    const snapshot = await gateway.snapshot();
    const [tenantDestination, landlordDestination] = await Promise.all([
      derivePayoutAddress(agreement.parties.tenant!.wallet.address, snapshot.tenancy.depositMint),
      derivePayoutAddress(agreement.parties.landlord!.wallet.address, snapshot.tenancy.depositMint),
    ]);
    const t = snapshot.tenancy;
    if (
      snapshot.genesisHash !== config.genesisHash ||
      t.address !== config.tenancyAddress ||
      Buffer.from(t.policyHash).toString('hex') !== digest.slice(2) ||
      t.requiredSecurityAtomic !== agreement.requiredSecurity ||
      t.releasePermitted !== agreement.releaseAllowed ||
      (['tenant', 'landlord', 'arbitrator'] as const).some(
        (role) => t[role] !== agreement.parties[role]?.wallet.address,
      ) ||
      t.tenantDestination !== tenantDestination ||
      t.landlordDestination !== landlordDestination
    )
      fail(
        'tenancy_binding_mismatch',
        'The deployed tenancy does not match the accepted parties and policy.',
        403,
      );
    if (
      sponsor.address === party.wallet.address ||
      [t.tenant, t.landlord, t.arbitrator].includes(sponsor.address)
    )
      fail('invalid_sponsor', 'A separate fee sponsor is required.');
    return { agreement, role, wallet: party.wallet, snapshot };
  }
  async function operation(id: string) {
    const op = (await lane()).operations.find((item) => item.id === id);
    if (!op) fail('operation_unavailable', 'Operation not found.', 404);
    return op;
  }
  const update = (id: string, change: (op: SolanaOperation) => SolanaOperation) =>
    store
      .update<Lane>(laneKey, (record) => ({
        ...record,
        operations: record.operations.map((op) => (op.id === id ? change(op) : op)),
      }))
      .then((record) => record.operations.find((op) => op.id === id)!);
  /** Each instruction consumes the next nonce; later steps see the nonce the earlier ones leave. */
  async function escrowInstructions(steps: EscrowAction[], t: SolanaSnapshot['tenancy'], actor: string) {
    const instructions: Instruction[] = [];
    let nonce = atomic(t.nextNonce);
    for (const step of steps) {
      const tenancy = { ...t, nextNonce: nonce.toString() };
      instructions.push(await buildEscrowInstruction({ manifest: config, tenancy, actor, nonce: tenancy.nextNonce, action: step }));
      nonce++;
    }
    return instructions;
  }
  async function compileWithSponsor(
    instructions: Instruction[],
    computeUnits: number,
    lifetime: { blockhash: string; lastValidBlockHeight: string },
  ) {
    const computeData = new Uint8Array(5);
    computeData[0] = 2;
    new DataView(computeData.buffer).setUint32(1, computeUnits, true);
    const message = appendTransactionMessageInstructions(
      [{ programAddress: address('ComputeBudget111111111111111111111111111111'), data: computeData }, ...instructions],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
        setTransactionMessageFeePayer(address(sponsor.address), createTransactionMessage({ version: 0 })),
      ),
    );
    const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
    if (bytes.length > 1232)
      fail('transaction_too_large', 'This action needs a reviewed account-list reduction.');
    return bytes;
  }
  async function reconcileStored(id: string) {
    const op = await operation(id);
    if (
      !op.signature ||
      op.state === 'finalized' ||
      op.state === 'failed' ||
      op.state === 'expired'
    )
      return op;
    // Reverify the deployed program and network before interpreting a native receipt.
    const snapshot = await gateway.snapshot();
    let receipt = await gateway.reconcile(op.signature, op.messageSha256, op.expectedDeltas);
    if (receipt.status === 'finalized') {
      const nextNonce = atomic(snapshot.tenancy.nextNonce);
      const finalNonce = atomic(op.nonce) + BigInt(op.steps ?? 1);
      if (atomic(snapshot.slot) < atomic(receipt.slot) || nextNonce < finalNonce) {
        receipt = { status: 'unknown', reason: 'awaiting-finalized-tenancy-state' };
      } else if (nextNonce === finalNonce) {
        // Claim approval moves no tokens, so also require its recorded state transition.
        const tenancy = snapshot.tenancy;
        const action = op.action;
        const closedWithObligations =
          tenancy.phase === 'closed' &&
          (config.escrowVersion !== 'pull-v2' ||
            atomic(tenancy.tenantOwedAtomic) + atomic(tenancy.landlordOwedAtomic) === atomic(tenancy.accountedIdleAtomic));
        const matches =
          action.kind === 'propose_claim'
            ? tenancy.phase === 'claim-proposed' && tenancy.claimAtomic === action.amountAtomic
            : action.kind === 'respond_to_claim'
              ? action.accept
                ? tenancy.phase === 'settling' &&
                  tenancy.approvedClaimAtomic === tenancy.claimAtomic
                : tenancy.phase === 'disputed'
              : action.kind === 'resolve_claim'
                ? tenancy.phase === 'settling' &&
                  tenancy.approvedClaimAtomic === action.amountAtomic
                : action.kind === 'settle' || action.kind === 'redeem_and_settle'
                  ? closedWithObligations
                  : action.kind === 'accept_and_settle'
                    ? closedWithObligations && tenancy.approvedClaimAtomic === tenancy.claimAtomic
                    : action.kind === 'resolve_and_settle'
                      ? closedWithObligations && tenancy.approvedClaimAtomic === action.amountAtomic
                      : action.kind === 'fund_and_supply'
                        ? tenancy.phase === 'active' && atomic(tenancy.accountedReceiptsAtomic) > 0n
                        : action.kind === 'payout'
                          ? tenancy.phase === 'closed' &&
                            (action.landlord ? tenancy.landlordOwedAtomic : tenancy.tenantOwedAtomic) === '0'
                          : true;
        if (!matches) receipt = { status: 'unknown', reason: 'tenancy-transition-not-observed' };
      }
    }
    return update(id, (current) =>
      ['finalized', 'failed'].includes(current.state)
        ? current
        : {
            ...current,
            state:
              receipt.status === 'finalized'
                ? 'finalized'
                : receipt.status === 'failed'
                  ? 'failed'
                  : 'unknown',
            receipt,
            lastError: receipt.status === 'finalized' ? null : receipt.reason,
          },
    );
  }
  async function sendStored(op: SolanaOperation) {
    if (!op.signedTxBase64 || !op.signature) throw new Error('Signed operation was not persisted');
    if (op.action.kind === 'fund' || op.action.kind === 'fund_and_supply') {
      // The signed operation is already durable. Advancing the agreement revision makes a
      // concurrent cancellation's earlier chain check stale, before any broadcast can start.
      await store.update<Agreement>(`agreement:${config.agreementId}`, (agreement) => {
        if (agreement.cancelled)
          fail('agreement_cancelled', 'This tenancy was cancelled before the deposit was secured.');
        return { ...agreement, revision: agreement.revision + 1 };
      });
    }
    try {
      const signature = await gateway.broadcast(
        new Uint8Array(Buffer.from(op.signedTxBase64, 'base64')),
      );
      if (signature !== op.signature) throw new Error('RPC returned another signature');
      return update(op.id, (current) =>
        ['finalized', 'failed'].includes(current.state)
          ? current
          : { ...current, state: 'broadcast', lastError: null },
      );
    } catch {
      return update(op.id, (current) =>
        ['finalized', 'failed'].includes(current.state)
          ? current
          : {
              ...current,
              state: 'unknown',
              lastError: 'Broadcast result is unknown. Reconcile this same signed transaction.',
            },
      );
    }
  }
  const retainUnknown = (id: string, reason: string) =>
    update(id, (current) =>
      ['finalized', 'failed'].includes(current.state)
        ? current
        : { ...current, state: 'unknown', lastError: reason },
    );
  async function retryStored(id: string, snapshot: SolanaSnapshot) {
    let op = await operation(id);
    if (!op.signedTxBase64 || !op.signature || op.state === 'expired')
      fail('operation_not_signed', 'Only an already signed operation can be retried.');
    if (op.state === 'finalized' || op.state === 'failed') return op;
    try {
      op = await reconcileStored(id);
    } catch {
      return retainUnknown(
        id,
        'Receipt evidence is unavailable. The original nonce remains reserved.',
      );
    }
    if (op.state === 'finalized' || op.state === 'failed') return op;
    // Rebroadcast only after a successful RPC lookup reports this signature absent.
    // Missing receipt details or transport errors do not establish absence.
    const receipt = op.receipt as { status?: unknown; reason?: unknown } | null;
    if (
      receipt?.status !== 'unknown' ||
      receipt.reason !== 'signature-not-observed-do-not-resubmit-new-intent'
    )
      return op;
    const expiresAt = Date.parse(op.expiresAt);
    let height: bigint;
    try {
      height = atomic((await gateway.lifetime()).blockHeight);
    } catch {
      return retainUnknown(
        id,
        'Block-height evidence is unavailable. The original nonce remains reserved.',
      );
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= now())
      return retainUnknown(
        id,
        'The authorization review expired. Reconcile the original signature; its nonce remains reserved.',
      );
    if (height >= atomic(op.lastValidBlockHeight))
      return retainUnknown(
        id,
        'The original blockhash lifetime ended. Reconcile the original signature; its nonce remains reserved.',
      );
    if (op.nonce !== snapshot.tenancy.nextNonce)
      return retainUnknown(
        id,
        'The tenancy nonce changed without a complete receipt. Reconcile the original signature.',
      );
    return sendStored(op);
  }
  return {
    async cancellationState(identity: VerifiedIdentity) {
      const agreement = await store.get<Agreement>(`agreement:${config.agreementId}`);
      if (!agreement) fail('agreement_unavailable', 'This tenancy is unavailable.', 403);
      agreementRole(agreement, identity);
      let phase: SolanaSnapshot['tenancy']['phase'] | null = null;
      try {
        phase = (await gateway.snapshot()).tenancy.phase;
      } catch (error) {
        if (!(error instanceof EscrowAbsentError)) throw error;
      }
      const operations = (await lane()).operations;
      return { phase, fundingPending: operations.some((op) =>
        (op.action.kind === 'fund' || op.action.kind === 'fund_and_supply') &&
        ['signed', 'broadcast', 'unknown'].includes(op.state)) };
    },
    async snapshot(identity: VerifiedIdentity) {
      const verified = await access(identity);
      const records = await lane();
      return {
        available: true as const,
        network: 'solana' as const,
        cluster: config.cluster,
        walletChain: config.cluster === 'devnet' ? 'solana:devnet' : null,
        agreementId: config.agreementId,
        escrowVersion: config.escrowVersion ?? 'direct-v1',
        role: verified.role,
        walletId: verified.wallet.id,
        feePayer: sponsor.address,
        ...verified.snapshot,
        operations: records.operations.map(publicOperation),
        trading: { available: false, reason: 'No verified issuer test-network execution route.' },
      };
    },
    async get(identity: VerifiedIdentity, id: string) {
      await access(identity);
      return publicOperation(await operation(id));
    },
    async prepare(identity: VerifiedIdentity, requestId: string, input: unknown) {
      if (input && typeof input === 'object' && 'kind' in input && typeof input.kind === 'string')
        await requireFundingOpen(identity, { kind: input.kind });
      if (!/^[a-zA-Z0-9_-]{8,120}$/.test(requestId))
        fail('invalid_request_id', 'Use a stable request identifier.', 400);
      const verified = await access(identity),
        t = verified.snapshot.tenancy;
      const decoded = decodeSolanaAction(input, t.tenantDestination);
      const action: ServiceAction = decoded.kind === 'fund_and_supply' && t.depositMint === SOLANA_TEST_USDC_MINT
        ? { kind: 'fund', source: t.tenantDestination }
        : decoded;
      allowed(action, verified.role, verified.snapshot, config);
      if ((action.kind === 'fund' || action.kind === 'fund_and_supply') &&
        atomic(verified.snapshot.tenantCashAtomic) < atomic(t.requiredSecurityAtomic))
        fail('insufficient_funds', `Your wallet needs ${(Number(t.requiredSecurityAtomic) / 1e6).toFixed(2)} test USDC for this deposit. Get it from the faucet, then try again.`);
      const id = hash(
          identity.subject +
            ':' +
            config.genesisHash +
            ':' +
            config.tenancyAddress +
            ':' +
            requestId,
        ),
        fingerprint = hash(JSON.stringify(action));
      const prior = (await lane()).operations.find((op) => op.id === id);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail('request_reused', 'This request identifier already represents another action.');
        if (prior.deployment &&
          (prior.deployment.genesisHash !== config.genesisHash ||
            prior.deployment.escrowProgram !== config.escrowProgram ||
            prior.deployment.programSha256 !== config.programSha256))
          fail('deployment_changed', 'The recorded review belongs to another deployment.');
        return publicOperation(prior);
      }
      const lifetime = await gateway.lifetime();
      if (atomic(lifetime.blockHeight) >= atomic(lifetime.lastValidBlockHeight))
        throw new Error('Recent blockhash expired');
      const steps = stepsFor(action, verified.snapshot);
      const transactionBytes = await compileWithSponsor(
        await escrowInstructions(steps, t, verified.wallet.address),
        steps.length === 1 ? 300_000 : Math.min(250_000 * steps.length, 1_000_000),
        lifetime,
      );
      const simulation = await gateway.simulate(
        transactionBytes,
        sponsor.address,
        verified.wallet.address,
      );
      if (atomic(simulation.sponsorDebitCeilingLamports) > atomic(config.maximumSponsorLamports))
        fail('sponsor_limit', 'The sponsor fee and rent limit would be exceeded.');
      const createdAt = now(),
        expiresAt =
          createdAt +
          Math.min(
            Number(atomic(lifetime.lastValidBlockHeight) - atomic(lifetime.blockHeight)) * 300,
            60_000,
          );
      const op: SolanaOperation = {
        id,
        requestId,
        fingerprint,
        agreementId: config.agreementId,
        subject: identity.subject,
        walletId: verified.wallet.id,
        actor: verified.wallet.address,
        role: verified.role,
        action,
        steps: steps.length,
        deployment: {
          genesisHash: config.genesisHash,
          escrowProgram: config.escrowProgram,
          programSha256: config.programSha256,
        },
        nonce: t.nextNonce,
        state: 'prepared',
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        messageSha256: await messageDigest(transactionBytes),
        transactionBase64: Buffer.from(transactionBytes).toString('base64'),
        signedTxBase64: null,
        signature: null,
        simulation,
        expectedDeltas: await bundleDeltas(action, steps, verified.snapshot, config),
        receipt: null,
        lastError: null,
      };
      const next = await store.update<Lane>(laneKey, (record) => {
        const duplicate = record.operations.find((item) => item.id === id);
        if (duplicate) {
          if (duplicate.fingerprint !== fingerprint)
            fail('request_reused', 'This request identifier already represents another action.');
          if (duplicate.deployment &&
            (duplicate.deployment.genesisHash !== config.genesisHash ||
              duplicate.deployment.escrowProgram !== config.escrowProgram ||
              duplicate.deployment.programSha256 !== config.programSha256))
            fail('deployment_changed', 'The recorded review belongs to another deployment.');
          return record;
        }
        const operations = record.operations.map((item) =>
          item.state === 'prepared' &&
          !item.signedTxBase64 &&
          (Date.parse(item.expiresAt) <= now() ||
            atomic(item.lastValidBlockHeight) < atomic(lifetime.blockHeight))
            ? { ...item, state: 'expired' as const }
            : item,
        );
        if (
          operations.some(
            (item) =>
              item.nonce === op.nonce && !['failed', 'expired', 'finalized'].includes(item.state),
          )
        )
          fail(
            'nonce_reserved',
            'Another operation already reserves this tenancy nonce. Reconcile it first.',
          );
        if (operations.length >= 500)
          fail(
            'operation_limit',
            'This demonstration needs operator archival before more operations.',
          );
        return { ...record, operations: [...operations, op] };
      });
      return publicOperation(next.operations.find((item) => item.id === id)!);
    },
    async authorize(identity: VerifiedIdentity, id: string, signedTxBase64: string) {
      await requireFundingOpen(identity, (await operation(id)).action);
      const verified = await access(identity);
      let op = await operation(id);
      if (
        op.subject !== identity.subject ||
        op.walletId !== verified.wallet.id ||
        op.actor !== verified.wallet.address
      )
        fail('operation_owner', 'Only the recorded actor can authorize this operation.', 403);
      if (op.deployment &&
        (op.deployment.genesisHash !== config.genesisHash ||
          op.deployment.escrowProgram !== config.escrowProgram ||
          op.deployment.programSha256 !== config.programSha256))
        fail('deployment_changed', 'This signature belongs to another deployment.');
      if (typeof signedTxBase64 !== 'string' || signedTxBase64.length > 1800)
        fail('invalid_signature', 'Invalid signed transaction.', 400);
      const raw = Buffer.from(signedTxBase64, 'base64');
      if (raw.toString('base64') !== signedTxBase64 || raw.length > 1232)
        fail('invalid_signature', 'Invalid transaction encoding.', 400);
      const tx = getTransactionDecoder().decode(raw);
      if ((await messageDigest(raw)) !== op.messageSha256)
        fail('changed_message', 'The signed message differs from the persisted operation.', 400);
      const signature = tx.signatures[address(op.actor)],
        key = signingKey(op.actor);
      if (
        Object.keys(tx.signatures).length !== 2 ||
        !signature ||
        !verifyEd25519(null, Buffer.from(tx.messageBytes), key, Buffer.from(signature))
      )
        fail(
          'invalid_signature',
          'The actor signature does not verify the persisted message.',
          400,
        );
      if (op.signedTxBase64) {
        return publicOperation(await retryStored(id, verified.snapshot));
      }
      if (tx.signatures[address(sponsor.address)])
        fail(
          'unexpected_sponsor_signature',
          'Only this server adds its configured sponsor signature.',
          400,
        );
      if (
        op.state !== 'prepared' ||
        Date.parse(op.expiresAt) <= now() ||
        op.nonce !== verified.snapshot.tenancy.nextNonce
      )
        fail('operation_expired', 'This operation expired or the tenancy changed.');
      const lifetime = await gateway.lifetime();
      if (atomic(lifetime.blockHeight) >= atomic(op.lastValidBlockHeight))
        fail('operation_expired', 'The transaction blockhash expired.');
      const simulation = await gateway.simulate(new Uint8Array(raw), sponsor.address, op.actor);
      if (atomic(simulation.sponsorDebitCeilingLamports) > atomic(config.maximumSponsorLamports))
        fail('sponsor_limit', 'Sponsor fee and rent limit exceeded.');
      const fullySigned = await sponsor.sign(new Uint8Array(raw));
      if ((await messageDigest(fullySigned)) !== op.messageSha256)
        throw new Error('Sponsor changed the reviewed message');
      const completed = getTransactionDecoder().decode(fullySigned);
      const payerSig = completed.signatures[address(sponsor.address)];
      const actorSig = completed.signatures[address(op.actor)];
      if (
        !payerSig ||
        !actorSig ||
        !Buffer.from(actorSig).equals(Buffer.from(signature)) ||
        !verifyEd25519(
          null,
          Buffer.from(completed.messageBytes),
          signingKey(sponsor.address),
          Buffer.from(payerSig),
        )
      )
        throw new Error('Sponsor signature invalid or actor signature changed');
      const expectedSignature = getBase58Decoder().decode(payerSig);
      const storedBytes = Buffer.from(fullySigned).toString('base64');
      op = await update(id, (current) => {
        if (current.signedTxBase64) {
          if (current.signedTxBase64 !== storedBytes)
            fail('signature_conflict', 'An immutable signed operation already exists.');
          return current;
        }
        if (current.state !== 'prepared')
          fail('operation_changed', 'This operation is no longer awaiting authorization.');
        return {
          ...current,
          state: 'signed',
          signedTxBase64: storedBytes,
          signature: expectedSignature,
          simulation,
        };
      });
      return publicOperation(await sendStored(op));
    },
    async retry(identity: VerifiedIdentity, id: string) {
      await requireFundingOpen(identity, (await operation(id)).action);
      const verified = await access(identity);
      const op = await operation(id);
      if (
        op.subject !== identity.subject ||
        op.walletId !== verified.wallet.id ||
        op.actor !== verified.wallet.address
      )
        fail('operation_owner', 'Only the recorded actor can retry this operation.', 403);
      return publicOperation(await retryStored(id, verified.snapshot));
    },
    async reconcile(identity: VerifiedIdentity, id: string) {
      await access(identity);
      return publicOperation(await reconcileStored(id));
    },
    /**
     * pull-v2 payouts are permissionless on-chain, so the sponsor runs them after settlement:
     * one side per transaction, so a party that breaks its own payout account only blocks itself.
     * Returns the payout operation it advanced, or null when nothing is owed.
     */
    async payout(identity: VerifiedIdentity) {
      const verified = await access(identity);
      const t = verified.snapshot.tenancy;
      if (config.escrowVersion !== 'pull-v2' || t.phase !== 'closed') return null;
      const initial = await lane();
      const pending = initial.operations.find((op) =>
        op.action.kind === 'payout' && op.signature && !['finalized', 'failed', 'expired'].includes(op.state));
      if (pending) {
        const settled = await reconcileStored(pending.id);
        if (settled.state !== 'failed') {
          // An unobserved signature is not a failed payout until its blockhash
          // has expired on the finalized chain.
          const receipt = settled.receipt as { status?: string; reason?: string } | null;
          if (settled.state !== 'unknown' ||
            receipt?.reason !== 'signature-not-observed-do-not-resubmit-new-intent' ||
            atomic((await gateway.lifetime()).blockHeight) < atomic(settled.lastValidBlockHeight))
            return publicOperation(settled);
          const expired = await update(settled.id, (current) =>
            current.state === 'unknown' ? { ...current, state: 'expired' } : current);
          if (expired.state !== 'expired' && expired.state !== 'failed') return publicOperation(expired);
        }
      }
      const owed = (['tenant', 'landlord'] as const).filter((side) =>
        atomic(side === 'landlord' ? t.landlordOwedAtomic : t.tenantOwedAtomic) > 0n);
      if (!owed.length) return null;
      const failures = (side: 'tenant' | 'landlord', record: Lane) =>
        record.operations.filter((op) =>
          op.action.kind === 'payout' && op.action.landlord === (side === 'landlord') &&
          ['failed', 'expired'].includes(op.state)).length +
        (record.payoutAttempts ?? []).filter((attempt) => attempt.side === side).length;
      const record = await lane();
      owed.sort((a, b) => failures(a, record) - failures(b, record));
      let simulationFailure: unknown;
      for (const side of owed) {
        const action: EscrowAction = { kind: 'payout', landlord: side === 'landlord' };
        const current = await lane();
        const attempt = current.operations.filter((op) =>
          op.action.kind === 'payout' && op.nonce === t.nextNonce && op.action.landlord === action.landlord).length +
          (current.payoutAttempts ?? []).filter((item) => item.nonce === t.nextNonce && item.side === side).length;
        const id = hash(`payout:${config.genesisHash}:${config.tenancyAddress}:${t.nextNonce}:${side}:${attempt}`);
        const existing = current.operations.find((op) => op.id === id);
        if (existing && !['failed', 'expired'].includes(existing.state)) return publicOperation(existing);
        const lifetime = await gateway.lifetime();
        const unsigned = await compileWithSponsor(await escrowInstructions([action], t, sponsor.address), 200_000, lifetime);
        const transactionBase64 = Buffer.from(unsigned).toString('base64');
        if (current.operations.some((item) =>
          item.action.kind === 'payout' && item.transactionBase64 === transactionBase64))
          fail('payout_blockhash_unchanged', 'A fresh blockhash is required to replace this payout.');
        let simulation: SolanaSimulation;
        try {
          simulation = await gateway.simulate(unsigned, sponsor.address, sponsor.address);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Exact transaction simulation failed') throw error;
          await store.update<Lane>(laneKey, (row) => ({
            ...row,
            payoutAttempts: [...(row.payoutAttempts ?? []), {
              side, nonce: t.nextNonce, at: new Date(now()).toISOString(), error: error.message,
            }],
          }));
          simulationFailure = error;
          continue;
        }
        if (atomic(simulation.sponsorDebitCeilingLamports) > atomic(config.maximumSponsorLamports))
          fail('sponsor_limit', 'The sponsor fee limit would be exceeded.');
        const signed = await sponsor.sign(unsigned);
        const payerSignature = getTransactionDecoder().decode(signed).signatures[address(sponsor.address)];
        if (!payerSignature) throw new Error('Sponsor did not sign the payout');
        const createdAt = new Date(now()).toISOString();
        const op: SolanaOperation = {
          id,
          requestId: `payout-${t.nextNonce}-${side}-${attempt}`,
          fingerprint: hash(JSON.stringify(action)),
          agreementId: config.agreementId,
          subject: identity.subject,
          walletId: verified.wallet.id,
          actor: sponsor.address,
          role: verified.role,
          action,
          steps: 1,
          deployment: { genesisHash: config.genesisHash, escrowProgram: config.escrowProgram, programSha256: config.programSha256 },
          nonce: t.nextNonce,
          state: 'signed',
          createdAt,
          expiresAt: new Date(now() + 60_000).toISOString(),
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
          messageSha256: await messageDigest(unsigned),
          transactionBase64,
          signedTxBase64: Buffer.from(signed).toString('base64'),
          signature: getBase58Decoder().decode(payerSignature),
          simulation,
          expectedDeltas: await deltasFor(action, verified.snapshot, config),
          receipt: null,
          lastError: null,
        };
        const stored = await store.update<Lane>(laneKey, (row) => {
          if (row.operations.some((item) => item.id === id)) return row;
          if (row.operations.some((item) =>
            item.action.kind === 'payout' && item.transactionBase64 === transactionBase64))
            fail('payout_blockhash_unchanged', 'A fresh blockhash is required to replace this payout.');
          if (row.operations.some((item) => item.nonce === op.nonce && !['failed', 'expired', 'finalized'].includes(item.state)))
            fail('nonce_reserved', 'Another operation already reserves this tenancy nonce. Reconcile it first.');
          return { ...row, operations: [...row.operations, op] };
        });
        const saved = stored.operations.find((item) => item.id === id)!;
        return publicOperation(saved.signedTxBase64 === op.signedTxBase64 ? await sendStored(saved) : saved);
      }
      throw simulationFailure;
    },
    reconcileStored,
    laneKey,
  };
}

export async function configuredFeeSponsor(
  environment: Record<string, string | undefined> = process.env,
): Promise<FeeSponsor | null> {
  if (!environment.SOLANA_SPONSOR_KEYPAIR) return null;
  const parsed: unknown = JSON.parse(environment.SOLANA_SPONSOR_KEYPAIR);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw new Error('Invalid sponsor keypair configuration');
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(parsed));
  return {
    address: signer.address,
    sign: async (bytes) =>
      new Uint8Array(
        getTransactionEncoder().encode(
          await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(bytes)),
        ),
      ),
  };
}
export async function configuredSolanaService(
  store: Store,
  environment: Record<string, string | undefined> = process.env,
) {
  const config = solanaConfiguration(environment);
  const sponsor = await configuredFeeSponsor(environment);
  if (!config || !sponsor) return null;
  return createSolanaService({ store, config, gateway: new RpcSolanaGateway(config), sponsor });
}
export async function reconcileSolanaOperations(
  store: Store,
  after = '',
  environment: Record<string, string | undefined> = process.env,
) {
  const service = await configuredSolanaService(store, environment);
  if (!service) return { available: false, scanned: 0, reconciled: 0, next: null };
  const records = await store.scan<Lane>('solana-lane:', after, 100);
  let reconciled = 0;
  for (const record of records) {
    if (record.key !== service.laneKey) continue;
    for (const operation of record.value.operations) {
      if (operation.signature && !['finalized', 'failed', 'expired'].includes(operation.state)) {
        await service.reconcileStored(operation.id);
        reconciled++;
      }
    }
  }
  return {
    available: true,
    scanned: records.length,
    reconciled,
    next: records.length === 100 ? records.at(-1)!.key : null,
  };
}
