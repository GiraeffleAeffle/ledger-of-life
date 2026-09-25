import { createHash, randomUUID } from 'node:crypto';
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, morphoVaultAbi } from '../finance/robinhood/abi.ts';
import { assertRentalEscrowRuntime } from '../finance/robinhood/deployment.ts';
import {
  atomic,
  robinhoodMainnet,
  sameAddress,
  type RobinhoodManifest,
} from '../finance/robinhood/manifest.ts';
import {
  planFundingApproval,
  simulateEscrowCall,
  type EscrowCallPlan,
  type EscrowIntent,
} from '../finance/robinhood/plan.ts';
import { readEscrow, type EscrowSnapshot } from '../finance/robinhood/read.ts';
import { encodeSignedOperation, prepareSignedOperation } from '../finance/robinhood/relay.ts';
import { reconcileReceipt, type EscrowReconciliation } from '../finance/robinhood/reconcile.ts';
import type { VerifiedIdentity, VerifiedWallet } from '../wallets/identity-policy.ts';
import type { Store } from './store.ts';
import { errorResponse } from './http.ts';
import { agreementDigest, type Agreement } from './agreements.ts';

const operationPrefix = 'native:robinhood:operation:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const seconds = () => BigInt(Math.floor(Date.now() / 1000));

export class RobinhoodServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 409, details?: unknown) {
    super(message);
    this.name = 'RobinhoodServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface SponsorConfig {
  privateKey: Hex;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxTotalFee: bigint;
}
export interface RobinhoodServerConfig {
  manifest: RobinhoodManifest;
  escrow: Address;
  deploymentCodeHash: Hex;
  sendEnabled: boolean;
  sponsor: SponsorConfig | null;
  confirmations: bigint;
  agreementId: string | null;
}

/** Hosted runtime has exactly one reviewed mainnet escrow. No request can select an RPC or token. */
export function loadRobinhoodConfig(
  env: Record<string, string | undefined> = process.env,
): RobinhoodServerConfig {
  const rpcUrl = env.ROBINHOOD_RPC_URL?.trim();
  const escrow = env.ROBINHOOD_ESCROW_ADDRESS?.trim();
  const deploymentCodeHash = env.ROBINHOOD_ESCROW_CODE_HASH?.trim();
  if (!rpcUrl || !escrow || !deploymentCodeHash)
    throw new RobinhoodServiceError(
      'unconfigured',
      'A reviewed Robinhood escrow deployment is not configured.',
      503,
    );
  let url: URL;
  try {
    url = new URL(rpcUrl);
    getAddress(escrow);
  } catch {
    throw new RobinhoodServiceError(
      'unconfigured',
      'Invalid Robinhood deployment configuration.',
      503,
    );
  }
  if (url.protocol !== 'https:' || !hashPattern.test(deploymentCodeHash))
    throw new RobinhoodServiceError(
      'unconfigured',
      'Robinhood requires an HTTPS RPC and exact deployment code hash.',
      503,
    );
  const sendEnabled = env.ROBINHOOD_SEND_ENABLED === '1';
  let sponsor: SponsorConfig | null = null;
  if (sendEnabled) {
    try {
      const privateKey = env.ROBINHOOD_SPONSOR_PRIVATE_KEY as Hex;
      privateKeyToAccount(privateKey);
      const maxGas = atomic(env.ROBINHOOD_SPONSOR_MAX_GAS || '');
      const maxFeePerGas = atomic(env.ROBINHOOD_SPONSOR_MAX_FEE_WEI || '');
      const maxTotalFee = atomic(env.ROBINHOOD_SPONSOR_MAX_TOTAL_FEE_WEI || '');
      if (
        maxGas < 21000n ||
        maxGas > 2000000n ||
        maxFeePerGas === 0n ||
        maxFeePerGas > 100000000000n ||
        maxTotalFee === 0n ||
        maxTotalFee > 100000000000000000n
      )
        throw new Error('Out of bounds');
      sponsor = { privateKey, maxGas, maxFeePerGas, maxTotalFee };
    } catch {
      throw new RobinhoodServiceError(
        'unconfigured',
        'Sponsorship needs a dedicated key and explicit bounded gas and fee limits.',
        503,
      );
    }
  }
  const agreementId = env.ROBINHOOD_AGREEMENT_ID?.trim() || null;
  if (agreementId && !uuid.test(agreementId))
    throw new RobinhoodServiceError('unconfigured', 'Invalid recorded agreement ID.', 503);
  return {
    manifest: { ...robinhoodMainnet, rpcUrl },
    escrow: getAddress(escrow),
    deploymentCodeHash: deploymentCodeHash as Hex,
    sendEnabled,
    sponsor,
    confirmations: 3n,
    agreementId,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RobinhoodServiceError('invalid_request', 'A JSON object is required.', 400);
  return value as Record<string, unknown>;
}
function exactKeys(item: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key)))
    throw new RobinhoodServiceError(
      'invalid_request',
      'Unexpected or missing request fields.',
      400,
    );
}
function amount(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (typeof value !== 'string' || value.length > 78)
    throw new RobinhoodServiceError('invalid_request', `Invalid ${key}.`, 400);
  try {
    atomic(value);
    return value;
  } catch {
    throw new RobinhoodServiceError(
      'invalid_request',
      `Use unsigned atomic units for ${key}.`,
      400,
    );
  }
}
export function decodeEscrowIntent(value: unknown): EscrowIntent {
  const item = object(value);
  switch (item.kind) {
    case 'acceptAgreement':
    case 'fund':
    case 'contestClaim':
      exactKeys(item, ['kind']);
      return { kind: item.kind };
    case 'supply':
      exactKeys(item, ['kind', 'assets', 'minShares']);
      return {
        kind: item.kind,
        assets: amount(item, 'assets'),
        minShares: amount(item, 'minShares'),
      };
    case 'releaseEarnings':
      exactKeys(item, ['kind', 'assets', 'maxSharesBurned']);
      return {
        kind: item.kind,
        assets: amount(item, 'assets'),
        maxSharesBurned: amount(item, 'maxSharesBurned'),
      };
    case 'proposeClaim': {
      exactKeys(item, ['kind', 'assets', 'evidenceHash']);
      if (typeof item.evidenceHash !== 'string' || !hashPattern.test(item.evidenceHash))
        throw new RobinhoodServiceError('invalid_request', 'Use a bytes32 evidence digest.', 400);
      return {
        kind: item.kind,
        assets: amount(item, 'assets'),
        evidenceHash: item.evidenceHash.toLowerCase() as Hex,
      };
    }
    case 'acceptClaim':
      exactKeys(item, ['kind', 'minimumAssets']);
      return { kind: item.kind, minimumAssets: amount(item, 'minimumAssets') };
    case 'resolveClaim':
      exactKeys(item, ['kind', 'landlordAssets', 'minimumAssets']);
      return {
        kind: item.kind,
        landlordAssets: amount(item, 'landlordAssets'),
        minimumAssets: amount(item, 'minimumAssets'),
      };
    case 'settle':
      exactKeys(item, ['kind', 'minRedeemedAssets']);
      return { kind: item.kind, minRedeemedAssets: amount(item, 'minRedeemedAssets') };
    default:
      throw new RobinhoodServiceError('invalid_request', 'Unsupported escrow action.', 400);
  }
}

type Prepared = ReturnType<typeof prepareSignedOperation>;
export type SerializedEscrowAction = Omit<
  Prepared['action'],
  'amount' | 'limit' | 'expectedNonce' | 'deadline'
> & { amount: string; limit: string; expectedNonce: string; deadline: string };
export interface RobinhoodOperation {
  id: string;
  revision: number;
  subject: string;
  walletId: string;
  walletAddress: Address;
  requestHash: string;
  intent: EscrowIntent;
  snapshot: EscrowSnapshot;
  nativePlan: EscrowCallPlan;
  action: SerializedEscrowAction;
  digest: Hex;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  state:
    | 'planned'
    | 'prepared'
    | 'submitted'
    | 'broadcast_unknown'
    | 'confirming'
    | 'completed'
    | 'reverted'
    | 'unverified';
  signature?: Hex;
  relayPlan?: EscrowCallPlan;
  rawTransaction?: Hex;
  transactionHash?: Hex;
  sponsorAddress?: Address;
  sponsorNonce?: number;
  broadcastAttempts: number;
  reconciliation?: EscrowReconciliation;
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new RobinhoodServiceError(
      'invalid_request',
      'Use a lowercase UUID v4 operation ID.',
      400,
    );
  return value;
}
const operationKey = (id: string) => `${operationPrefix}${operationId(id)}`;
const fingerprint = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const iso = (now: bigint) => new Date(Number(now) * 1000).toISOString();

function serializeAction(action: Prepared['action']): SerializedEscrowAction {
  return {
    ...action,
    amount: action.amount.toString(),
    limit: action.limit.toString(),
    expectedNonce: action.expectedNonce.toString(),
    deadline: action.deadline.toString(),
  };
}

/** The API deliberately omits raw signed transactions and signatures from responses. */
export function publicRobinhoodOperation(record: RobinhoodOperation) {
  return {
    id: record.id,
    walletId: record.walletId,
    state: record.state,
    network: 'robinhood' as const,
    chainId: record.nativePlan.chainId,
    escrowAddress: record.nativePlan.to,
    intent: record.intent,
    action: record.action,
    digest: record.digest,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    description: `Authorize ${record.intent.kind} for the configured rental escrow.`,
    transactionHash: record.transactionHash ?? null,
    reconciliation: record.reconciliation ?? null,
    evidence:
      record.state === 'completed' ? 'confirmed-native-receipt' : 'unconfirmed-native-operation',
  };
}

export async function observeConfiguredEscrow(
  client: PublicClient,
  config: RobinhoodServerConfig,
): Promise<EscrowSnapshot> {
  const snapshot = await readEscrow(client, config.manifest, config.escrow);
  const code = await client.getCode({
    address: config.escrow,
    blockNumber: atomic(snapshot.blockNumber),
  });
  assertRentalEscrowRuntime(code || '0x', config.deploymentCodeHash);
  return snapshot;
}

/** Suggestions use integer previews at the same observed block. Exact calls still require simulation. */
export async function readPlanningHints(
  client: PublicClient,
  config: RobinhoodServerConfig,
  snapshot: EscrowSnapshot,
) {
  const blockNumber = atomic(snapshot.blockNumber);
  const [supply, release, settle] = await Promise.allSettled([
    (async () => {
      const idle = await client.readContract({
        address: config.manifest.asset.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [config.escrow],
        blockNumber,
      });
      if (idle === 0n || snapshot.state !== 2) return null;
      const required = atomic(snapshot.securityRequirement);
      // Preview-rounding can leave the escrow below its security requirement.
      // Search down from idle in a bounded neighborhood for the largest safe amount.
      let assets = idle;
      let preview = 0n;
      let safe = false;
      for (let attempts = 0; attempts < 64 && assets > 0n; attempts++, assets--) {
        const shares = await client.readContract({
          address: config.manifest.vault,
          abi: morphoVaultAbi,
          functionName: 'previewDeposit',
          args: [assets],
          blockNumber,
        });
        const redeemed = await client.readContract({
          address: config.manifest.vault,
          abi: morphoVaultAbi,
          functionName: 'previewRedeem',
          args: [shares],
          blockNumber,
        });
        if (idle - assets + redeemed >= required) {
          preview = shares;
          safe = true;
          break;
        }
      }
      const minShares = (preview * 9998n) / 10000n;
      if (!safe || minShares === 0n) return null;
      return {
        kind: 'supply' as const,
        assets: assets.toString(),
        minShares: minShares.toString(),
      };
    })(),
    (async () => {
      const assets = atomic(snapshot.releasableEarnings);
      if (assets === 0n || snapshot.state !== 2 || !snapshot.earningsReleaseAllowed) return null;
      const preview = await client.readContract({
        address: config.manifest.vault,
        abi: morphoVaultAbi,
        functionName: 'previewWithdraw',
        args: [assets],
        blockNumber,
      });
      const padded = (preview * 10002n + 9999n) / 10000n;
      const tracked = atomic(snapshot.trackedShares);
      return {
        kind: 'releaseEarnings' as const,
        assets: assets.toString(),
        maxSharesBurned: (padded < tracked ? padded : tracked).toString(),
      };
    })(),
    (async () => {
      if (snapshot.state !== 5) return null;
      const tracked = atomic(snapshot.trackedShares);
      const preview =
        tracked === 0n
          ? 0n
          : await client.readContract({
              address: config.manifest.vault,
              abi: morphoVaultAbi,
              functionName: 'previewRedeem',
              args: [tracked],
              blockNumber,
            });
      // This bound applies only to vault redemption. The contract separately
      // checks total cash against the approved minimumSettlementAssets.
      return {
        kind: 'settle' as const,
        minRedeemedAssets: ((preview * 9998n) / 10000n).toString(),
      };
    })(),
  ]);
  return {
    observedAt: snapshot.observedAt,
    blockNumber: snapshot.blockNumber,
    slippageBps: 2,
    supply: supply.status === 'fulfilled' ? supply.value : null,
    releaseEarnings: release.status === 'fulfilled' ? release.value : null,
    settle: settle.status === 'fulfilled' ? settle.value : null,
    status:
      supply.status === 'rejected' || release.status === 'rejected' || settle.status === 'rejected'
        ? 'partially_unavailable'
        : 'available',
    evidence: 'accounting-previews-require-exact-simulation',
  };
}

async function requireBoundAgreement(
  store: Store,
  config: RobinhoodServerConfig,
  snapshot: EscrowSnapshot,
  identity: VerifiedIdentity,
  wallet: VerifiedWallet,
) {
  if (!config.agreementId)
    throw new RobinhoodServiceError(
      'agreement_binding_required',
      'Link this escrow to the recorded tenancy agreement before funding.',
    );
  const agreement = await store.get<Agreement>(`agreement:${config.agreementId}`);
  const digest = agreement && agreementDigest(agreement);
  if (
    !agreement ||
    agreement.network !== 'robinhood' ||
    !digest ||
    digest !== snapshot.agreementHash ||
    agreement.requiredSecurity !== snapshot.securityRequirement ||
    agreement.releaseAllowed !== snapshot.earningsReleaseAllowed ||
    !sameAddress(snapshot.personalWallet, snapshot.tenant) ||
    ['tenant', 'landlord', 'arbitrator'].some((role) => {
      const party = agreement.parties[role as 'tenant' | 'landlord' | 'arbitrator'];
      return (
        !party ||
        party.wallet.chainType !== 'ethereum' ||
        !sameAddress(party.wallet.address, snapshot[role as 'tenant' | 'landlord' | 'arbitrator'])
      );
    })
  )
    throw new RobinhoodServiceError(
      'agreement_mismatch',
      'The escrow must match the recorded asset, parties, personal wallet, security and release policy.',
    );
  if (
    agreement.parties.tenant!.subject !== identity.subject ||
    agreement.parties.tenant!.wallet.id !== wallet.id
  )
    throw new RobinhoodServiceError(
      'forbidden',
      'Funding must use the tenant identity and wallet recorded in the agreement.',
      403,
    );
  if (
    agreement.accepted.tenant?.digest !== digest ||
    agreement.accepted.landlord?.digest !== digest
  )
    throw new RobinhoodServiceError(
      'agreement_not_accepted',
      'The tenant and landlord must accept the same recorded agreement before funding.',
    );
}

interface Dependencies {
  store: Store;
  client: PublicClient;
  config: RobinhoodServerConfig;
  requireRecovery: (store: Store, identity: VerifiedIdentity, walletId: string) => Promise<unknown>;
  now?: () => bigint;
  // Deterministic tests replace only the RPC observation boundary, never the signing/durable-send path.
  observe?: (client: PublicClient, config: RobinhoodServerConfig) => Promise<EscrowSnapshot>;
}

function partyWallet(
  identity: VerifiedIdentity,
  snapshot: EscrowSnapshot,
  walletId?: string,
): VerifiedWallet {
  const wallets = identity.wallets.filter(
    (wallet) =>
      wallet.chainType === 'ethereum' &&
      (!walletId || wallet.id === walletId) &&
      [snapshot.tenant, snapshot.landlord, snapshot.arbitrator].some((party) =>
        sameAddress(wallet.address, party),
      ),
  );
  if (wallets.length !== 1)
    throw new RobinhoodServiceError(
      'forbidden',
      'Your verified wallet is not an assigned party to this escrow.',
      403,
    );
  return wallets[0];
}

async function assertSignature(digest: Hex, signature: unknown, signer: Address): Promise<Hex> {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new RobinhoodServiceError(
      'invalid_signature',
      'A canonical EOA signature is required.',
      400,
    );
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130, 132), 16);
  if (
    s === 0n ||
    s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
    (v !== 27 && v !== 28)
  )
    throw new RobinhoodServiceError(
      'invalid_signature',
      'A canonical EOA signature is required.',
      400,
    );
  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: digest, signature: signature as Hex });
  } catch {
    throw new RobinhoodServiceError(
      'invalid_signature',
      'The authorization signature could not be verified.',
      400,
    );
  }
  if (!sameAddress(recovered, signer))
    throw new RobinhoodServiceError(
      'invalid_signature',
      'The signature does not authorize this stored operation.',
      403,
    );
  return signature.toLowerCase() as Hex;
}

interface SponsoredEnvelope {
  rawTransaction: Hex;
  transactionHash: Hex;
  sponsorAddress: Address;
  sponsorNonce: number;
  signature: Hex;
  relayPlan: EscrowCallPlan;
  digest: Hex;
}
interface SponsorReservation {
  operationId: string | null;
  preparation?: { token: string; expiresAt: string };
  prepared?: SponsoredEnvelope;
}
function reservationKey(config: RobinhoodServerConfig, address: Address) {
  return `native:robinhood:sponsor:${config.manifest.chainId}:${address.toLowerCase()}`;
}
async function reserveSponsor(
  store: Store,
  config: RobinhoodServerConfig,
  address: Address,
  id: string,
  now: bigint,
) {
  const key = reservationKey(config, address);
  const reservation: SponsorReservation = {
    operationId: id,
    preparation: { token: randomUUID(), expiresAt: (now + 60n).toString() },
  };
  try {
    await store.create<SponsorReservation>(key, reservation);
    return reservation;
  } catch (error) {
    if (!(await store.get(key))) throw error;
    return store.update<SponsorReservation>(key, (record) => {
      if (record.prepared) {
        if (record.operationId === id) return record;
        throw new RobinhoodServiceError(
          'sponsor_busy',
          'Another native operation is awaiting reconciliation. Retry after it finishes.',
        );
      }
      if (record.preparation && atomic(record.preparation.expiresAt) > now)
        throw new RobinhoodServiceError(
          'operation_preparing',
          'A native operation is being prepared. Retry the same operation shortly.',
        );
      return reservation;
    });
  }
}

async function releaseSponsor(
  store: Store,
  config: RobinhoodServerConfig,
  address: Address,
  id: string,
) {
  await store.update<SponsorReservation>(reservationKey(config, address), (record) =>
    record.operationId === id ? { operationId: null } : record,
  );
}

/** Fail closed even if a future refactor accidentally signs a different envelope. */
export async function assertSponsoredTransaction(
  raw: Hex,
  plan: EscrowCallPlan,
  sponsor: Address,
  limits: SponsorConfig,
) {
  const tx = parseTransaction(raw);
  const sender = await recoverTransactionAddress({
    serializedTransaction: raw as TransactionSerialized,
  });
  if (
    tx.type !== 'eip1559' ||
    tx.chainId !== plan.chainId ||
    !tx.to ||
    !sameAddress(tx.to, plan.to) ||
    tx.data !== plan.data ||
    (tx.value ?? 0n) !== 0n ||
    !sameAddress(sender, sponsor) ||
    !Number.isSafeInteger(tx.nonce) ||
    (tx.nonce ?? -1) < 0 ||
    !tx.gas ||
    tx.gas > limits.maxGas ||
    !tx.maxFeePerGas ||
    tx.maxFeePerGas > limits.maxFeePerGas ||
    tx.gas * tx.maxFeePerGas > limits.maxTotalFee ||
    (tx.maxPriorityFeePerGas ?? 0n) > tx.maxFeePerGas ||
    (tx.accessList?.length ?? 0) !== 0
  ) {
    throw new RobinhoodServiceError(
      'unsafe_transaction',
      'The sponsor transaction failed its exact-call or fee checks.',
      503,
    );
  }
  return { transactionHash: keccak256(raw), sponsorNonce: tx.nonce! };
}

async function signSponsoredTransaction(
  client: PublicClient,
  config: RobinhoodServerConfig,
  plan: EscrowCallPlan,
) {
  const limits = config.sponsor!;
  const account = privateKeyToAccount(limits.privateKey);
  const [estimate, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: plan.to, data: plan.data, value: 0n }),
    client.estimateFeesPerGas({ chain: undefined, type: 'eip1559' }),
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    client.getBalance({ address: account.address }),
  ]);
  const gas = (estimate * 120n + 99n) / 100n;
  if (
    gas > limits.maxGas ||
    gas < 21000n ||
    !fees.maxFeePerGas ||
    fees.maxFeePerGas > limits.maxFeePerGas ||
    gas * fees.maxFeePerGas > limits.maxTotalFee ||
    balance < gas * fees.maxFeePerGas
  )
    throw new RobinhoodServiceError(
      'sponsor_limits',
      'Estimated sponsor gas exceeds configured limits or available balance.',
    );
  const rawTransaction = await account.signTransaction({
    type: 'eip1559',
    chainId: config.manifest.chainId,
    to: plan.to,
    data: plan.data,
    value: 0n,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return {
    rawTransaction,
    sponsorAddress: account.address,
    ...(await assertSponsoredTransaction(rawTransaction, plan, account.address, limits)),
  };
}

export function createRobinhoodService(dependencies: Dependencies) {
  const { store, client, config, requireRecovery } = dependencies;
  const now = dependencies.now ?? seconds;
  const observe = () => (dependencies.observe ?? observeConfiguredEscrow)(client, config);

  async function owned(identity: VerifiedIdentity, id: string) {
    const record = await store.get<RobinhoodOperation>(operationKey(id));
    if (
      !record ||
      record.subject !== identity.subject ||
      !identity.wallets.some(
        (wallet) =>
          wallet.id === record.walletId &&
          wallet.chainType === 'ethereum' &&
          sameAddress(wallet.address, record.walletAddress),
      )
    )
      throw new RobinhoodServiceError(
        'forbidden',
        'This operation belongs to another verified account or wallet.',
        403,
      );
    if (
      record.nativePlan.chainId !== config.manifest.chainId ||
      !sameAddress(record.nativePlan.to, config.escrow)
    )
      throw new RobinhoodServiceError(
        'configuration_changed',
        'This operation belongs to a different configured deployment.',
      );
    return record;
  }

  async function fundingGate(
    snapshot: EscrowSnapshot,
    wallet: VerifiedWallet,
    identity: VerifiedIdentity,
  ) {
    await requireBoundAgreement(store, config, snapshot, identity, wallet);
    const allowance = await client.readContract({
      address: config.manifest.asset.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [getAddress(wallet.address), config.escrow],
      blockNumber: atomic(snapshot.blockNumber),
    });
    const fundingAmount = (
      atomic(snapshot.securityRequirement) + atomic(snapshot.fundingReserve)
    ).toString();
    if (allowance < BigInt(fundingAmount))
      throw new RobinhoodServiceError(
        'funding_approval_required',
        'Funding requires approval for the security plus its tenant-owned rounding reserve.',
        409,
        {
          approval: planFundingApproval(config.manifest, config.escrow, fundingAmount),
          amount: fundingAmount,
          spender: config.escrow,
          execution: 'unconfigured',
        },
      );
  }

  async function observation(identity: VerifiedIdentity) {
    const snapshot = await observe();
    const wallet = partyWallet(identity, snapshot);
    return {
      status: 'available',
      agreementId: config.agreementId,
      snapshot,
      partyWallets: [
        {
          id: wallet.id,
          address: wallet.address,
          role: sameAddress(wallet.address, snapshot.tenant)
            ? 'tenant'
            : sameAddress(wallet.address, snapshot.landlord)
              ? 'landlord'
              : 'arbitrator',
        },
      ],
      planningHints: await readPlanningHints(client, config, snapshot),
      gates: {
        sponsoredSend: config.sendEnabled && !!config.sponsor ? 'enabled' : 'unconfigured',
        fundingApproval: 'separate-wallet-approval-required',
        agreementBinding: config.agreementId
          ? 'requires-matching-accepted-agreement'
          : 'unconfigured',
        recovery: 'verified-record-required',
        stockTrading: 'separate-provider-access-required',
      },
    };
  }

  async function plan(identity: VerifiedIdentity, input: unknown) {
    const item = object(input);
    exactKeys(item, ['operationId', 'walletId', 'intent']);
    const id = operationId(item.operationId);
    if (typeof item.walletId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.walletId))
      throw new RobinhoodServiceError('invalid_request', 'Select a verified wallet ID.', 400);
    const intent = decodeEscrowIntent(item.intent);
    const requestHash = fingerprint([
      identity.subject,
      item.walletId,
      config.manifest.chainId,
      config.escrow.toLowerCase(),
      intent,
    ]);
    const prior = await store.get<RobinhoodOperation>(operationKey(id));
    if (prior) {
      await owned(identity, id);
      if (prior.requestHash !== requestHash)
        throw new RobinhoodServiceError(
          'idempotency_conflict',
          'This operation ID is already bound to different terms.',
        );
      return publicRobinhoodOperation(prior);
    }
    const snapshot = await observe();
    const wallet = partyWallet(identity, snapshot, item.walletId);
    await requireRecovery(store, identity, wallet.id);
    if (intent.kind === 'fund') await fundingGate(snapshot, wallet, identity);
    const time = now();
    let prepared: Prepared;
    try {
      prepared = prepareSignedOperation(
        config.manifest,
        snapshot,
        intent,
        getAddress(wallet.address),
        (time + 300n).toString(),
        time,
      );
    } catch (error) {
      throw new RobinhoodServiceError(
        'invalid_intent',
        error instanceof Error ? error.message : 'Invalid escrow action.',
        400,
      );
    }
    await simulateEscrowCall(client, prepared.nativePlan);
    const record: RobinhoodOperation = {
      id,
      revision: 0,
      subject: identity.subject,
      walletId: wallet.id,
      walletAddress: getAddress(wallet.address),
      requestHash,
      intent,
      snapshot,
      nativePlan: prepared.nativePlan,
      action: serializeAction(prepared.action),
      digest: prepared.digest,
      expiresAt: iso(prepared.action.deadline),
      createdAt: iso(time),
      updatedAt: iso(time),
      state: 'planned',
      broadcastAttempts: 0,
    };
    try {
      await store.create(operationKey(id), record);
    } catch (error) {
      const winner = await store.get<RobinhoodOperation>(operationKey(id));
      if (!winner) throw error;
      if (winner.requestHash !== requestHash)
        throw new RobinhoodServiceError(
          'idempotency_conflict',
          'This operation ID is already bound to different terms.',
        );
      return publicRobinhoodOperation(winner);
    }
    return publicRobinhoodOperation(record);
  }

  async function authorize(identity: VerifiedIdentity, id: string, input: unknown) {
    const item = object(input);
    exactKeys(item, ['signature']);
    let record = await owned(identity, id);
    const signature = await assertSignature(record.digest, item.signature, record.walletAddress);
    await requireRecovery(store, identity, record.walletId);
    if (
      record.state === 'completed' ||
      record.state === 'reverted' ||
      record.state === 'unverified'
    )
      return publicRobinhoodOperation(record);
    if (!config.sendEnabled || !config.sponsor)
      throw new RobinhoodServiceError(
        'unconfigured',
        'Native relay sending is disabled. Your signature has not been broadcast.',
        503,
      );

    if (!record.rawTransaction) {
      const snapshot = await observe();
      const wallet = partyWallet(identity, snapshot, record.walletId);
      if (intentExpired(record, now()))
        throw new RobinhoodServiceError(
          'expired',
          'This authorization expired. Review a fresh operation.',
        );
      if (record.intent.kind === 'fund') await fundingGate(snapshot, wallet, identity);
      const prepared = prepareSignedOperation(
        config.manifest,
        snapshot,
        record.intent,
        record.walletAddress,
        record.action.deadline,
        now(),
      );
      if (
        prepared.digest !== record.digest ||
        prepared.nativePlan.data !== record.nativePlan.data ||
        fingerprint(serializeAction(prepared.action)) !== fingerprint(record.action)
      )
        throw new RobinhoodServiceError(
          'stale_operation',
          'The escrow changed. Review a fresh operation.',
        );
      const relayPlan = encodeSignedOperation(prepared, signature);
      await simulateEscrowCall(client, relayPlan);
      const sponsorAddress = privateKeyToAccount(config.sponsor.privateKey).address;
      if (
        [snapshot.tenant, snapshot.landlord, snapshot.arbitrator, snapshot.personalWallet].some(
          (party) => sameAddress(party, sponsorAddress),
        )
      )
        throw new RobinhoodServiceError(
          'unconfigured',
          'Use a dedicated gas sponsor account separate from every party and portfolio.',
          503,
        );
      const reservation = await reserveSponsor(store, config, sponsorAddress, id, now());
      let envelope = reservation.prepared;
      if (!envelope) {
        try {
          const signed = await signSponsoredTransaction(client, config, relayPlan);
          envelope = { ...signed, signature, relayPlan, digest: record.digest };
          const pending = envelope;
          // Fencing is required before any signature can be used. A timed-out preparer
          // cannot write or broadcast after another request has taken its reservation.
          await store.update<SponsorReservation>(
            reservationKey(config, sponsorAddress),
            (current) => {
              if (
                current.operationId !== id ||
                current.preparation?.token !== reservation.preparation!.token ||
                atomic(current.preparation.expiresAt) <= now()
              )
                throw new RobinhoodServiceError(
                  'preparation_expired',
                  'Transaction preparation expired. Retry the same operation.',
                );
              return { operationId: id, prepared: pending };
            },
          );
        } catch (error) {
          await store.update<SponsorReservation>(
            reservationKey(config, sponsorAddress),
            (current) =>
              current.operationId === id &&
              current.preparation?.token === reservation.preparation!.token
                ? { operationId: null }
                : current,
          );
          throw error;
        }
      }
      if (envelope.digest !== record.digest)
        throw new RobinhoodServiceError(
          'unsafe_transaction',
          'Stored sponsor reservation differs from the reviewed authorization.',
          503,
        );
      const durableEnvelope = envelope;
      record = await store.update<RobinhoodOperation>(operationKey(id), (current) => {
        if (current.rawTransaction) return current;
        if (current.state !== 'planned' || current.digest !== record.digest)
          throw new RobinhoodServiceError('operation_changed', 'The stored operation changed.');
        return {
          ...current,
          ...durableEnvelope,
          revision: current.revision + 1,
          state: 'prepared',
          updatedAt: iso(now()),
        };
      });
    }

    // From here onward, never sign a replacement, use a new nonce, or alter gas prices.
    await assertSponsoredTransaction(
      record.rawTransaction!,
      record.relayPlan!,
      record.sponsorAddress!,
      config.sponsor,
    );
    record = await reconcileRobinhoodRecord(store, client, config, record, now());
    if (
      record.state === 'completed' ||
      record.state === 'reverted' ||
      record.state === 'unverified' ||
      record.state === 'confirming'
    )
      return publicRobinhoodOperation(record);
    if (intentExpired(record, now())) return publicRobinhoodOperation(record);
    return publicRobinhoodOperation(await broadcastSaved(record));
  }

  async function broadcastSaved(record: RobinhoodOperation) {
    record = await store.update<RobinhoodOperation>(operationKey(record.id), (current) => {
      if (['completed', 'reverted', 'unverified', 'confirming'].includes(current.state))
        return current;
      if (
        current.transactionHash !== record.transactionHash ||
        current.rawTransaction !== record.rawTransaction
      )
        throw new RobinhoodServiceError('operation_changed', 'The stored transaction changed.');
      return {
        ...current,
        revision: current.revision + 1,
        broadcastAttempts: current.broadcastAttempts + 1,
        updatedAt: iso(now()),
      };
    });
    if (['completed', 'reverted', 'unverified', 'confirming'].includes(record.state)) return record;
    if (intentExpired(record, now()))
      throw new RobinhoodServiceError(
        'expired_saved_transaction',
        'The saved authorization expired before broadcast. Retain its operation ID and reconcile the existing hash.',
      );
    let state: 'submitted' | 'broadcast_unknown' = 'submitted';
    try {
      const reported = await client.sendRawTransaction({
        serializedTransaction: record.rawTransaction!,
      });
      if (reported.toLowerCase() !== record.transactionHash!.toLowerCase())
        state = 'broadcast_unknown';
    } catch {
      state = 'broadcast_unknown';
    }
    return store.update<RobinhoodOperation>(operationKey(record.id), (current) =>
      ['completed', 'reverted', 'unverified', 'confirming'].includes(current.state)
        ? current
        : { ...current, revision: current.revision + 1, state, updatedAt: iso(now()) },
    );
  }

  /** Only an already-persisted envelope can enter this path; never signs or selects a nonce. */
  async function retry(identity: VerifiedIdentity, id: string, input: unknown) {
    exactKeys(object(input), []);
    let record = await owned(identity, id);
    await requireRecovery(store, identity, record.walletId);
    if (!config.sendEnabled || !config.sponsor)
      throw new RobinhoodServiceError(
        'unconfigured',
        'Native relay sending is disabled. The saved transaction remains available for reconciliation.',
        503,
      );
    const snapshot = await observe();
    const wallet = partyWallet(identity, snapshot, record.walletId);
    const configuredSponsor = privateKeyToAccount(config.sponsor.privateKey).address;
    if (
      [snapshot.tenant, snapshot.landlord, snapshot.arbitrator, snapshot.personalWallet].some(
        (party) => sameAddress(party, configuredSponsor),
      )
    )
      throw new RobinhoodServiceError(
        'unconfigured',
        'Use a dedicated gas sponsor account separate from every party and portfolio.',
        503,
      );

    // Recover a previous interrupted operation write, using its durable envelope.
    // No replacement is created when the reservation contains no signed bytes.
    if (!record.rawTransaction) {
      const saved = await store.get<SponsorReservation>(reservationKey(config, configuredSponsor));
      const envelope = saved?.operationId === id ? saved.prepared : undefined;
      if (!envelope || envelope.digest !== record.digest)
        throw new RobinhoodServiceError(
          'no_saved_transaction',
          'This operation has no saved signed transaction to retry.',
        );
      record = await store.update<RobinhoodOperation>(operationKey(id), (current) => {
        if (current.rawTransaction) return current;
        if (current.state !== 'planned' || current.digest !== envelope.digest)
          throw new RobinhoodServiceError('operation_changed', 'The stored operation changed.');
        return {
          ...current,
          ...envelope,
          revision: current.revision + 1,
          state: 'prepared',
          updatedAt: iso(now()),
        };
      });
    }
    if (
      !record.relayPlan ||
      !record.transactionHash ||
      !record.signature ||
      !record.sponsorAddress ||
      !sameAddress(record.sponsorAddress, configuredSponsor) ||
      record.relayPlan.relayAuthorization?.digest !== record.digest ||
      !sameAddress(record.relayPlan.requiredSigner, record.walletAddress)
    )
      throw new RobinhoodServiceError(
        'saved_transaction_mismatch',
        'The saved transaction does not match this configured sponsor and authorization.',
        503,
      );
    await assertSignature(record.digest, record.signature, record.walletAddress);
    const checked = await assertSponsoredTransaction(
      record.rawTransaction!,
      record.relayPlan,
      configuredSponsor,
      config.sponsor,
    );
    if (
      checked.transactionHash !== record.transactionHash ||
      checked.sponsorNonce !== record.sponsorNonce
    )
      throw new RobinhoodServiceError(
        'saved_transaction_mismatch',
        'The saved transaction hash or nonce changed.',
        503,
      );

    record = await reconcileRobinhoodRecord(store, client, config, record, now());
    if (['completed', 'reverted', 'unverified', 'confirming'].includes(record.state))
      return publicRobinhoodOperation(record);
    if (intentExpired(record, now()))
      throw new RobinhoodServiceError(
        'expired_saved_transaction',
        'This saved authorization expired. Retain the operation and reconcile its existing hash; no new transaction was created.',
      );
    if (record.reconciliation?.status !== 'pending')
      throw new RobinhoodServiceError(
        'observation_unavailable',
        'A reliable pending receipt observation is required before retrying. The saved transaction remains unchanged.',
        503,
      );
    if (snapshot.nonce !== record.nativePlan.expectedNonce)
      throw new RobinhoodServiceError(
        'nonce_changed',
        'The escrow nonce changed. Reconcile the saved transaction; do not create a replacement payment.',
      );
    const reservation = await store.get<SponsorReservation>(
      reservationKey(config, configuredSponsor),
    );
    if (
      reservation?.operationId !== id ||
      reservation.prepared?.rawTransaction !== record.rawTransaction
    )
      throw new RobinhoodServiceError(
        'reservation_changed',
        'The sponsor reservation no longer matches this saved transaction. Retain the operation for reconciliation.',
      );
    if (record.intent.kind === 'fund') await fundingGate(snapshot, wallet, identity);
    await simulateEscrowCall(client, record.relayPlan!);
    return publicRobinhoodOperation(await broadcastSaved(record));
  }

  async function status(identity: VerifiedIdentity, id: string) {
    return publicRobinhoodOperation(await owned(identity, id));
  }
  async function reconcile(identity: VerifiedIdentity, id: string) {
    const record = await owned(identity, id);
    return publicRobinhoodOperation(
      await reconcileRobinhoodRecord(store, client, config, record, now()),
    );
  }
  return { observation, plan, authorize, retry, status, reconcile };
}

function intentExpired(record: RobinhoodOperation, now: bigint) {
  return atomic(record.action.deadline) <= now;
}

export async function reconcileRobinhoodRecord(
  store: Store,
  client: PublicClient,
  config: RobinhoodServerConfig,
  record: RobinhoodOperation,
  now = seconds(),
): Promise<RobinhoodOperation> {
  if (!record.transactionHash || !record.relayPlan || !record.rawTransaction) return record;
  if (
    record.relayPlan.chainId !== config.manifest.chainId ||
    !sameAddress(record.relayPlan.to, config.escrow) ||
    keccak256(record.rawTransaction) !== record.transactionHash
  )
    throw new RobinhoodServiceError(
      'configuration_changed',
      'Cannot reconcile an operation against a different deployment.',
      503,
    );
  const result = await reconcileReceipt(
    client,
    record.relayPlan,
    record.transactionHash,
    config.confirmations,
  );
  const state =
    result.status === 'completed' ||
    result.status === 'confirming' ||
    result.status === 'reverted' ||
    result.status === 'unverified'
      ? result.status
      : record.state === 'confirming'
        ? 'submitted'
        : record.state;
  const updated = await store.update<RobinhoodOperation>(operationKey(record.id), (current) =>
    current.revision !== record.revision
      ? current
      : {
          ...current,
          revision: current.revision + 1,
          state,
          reconciliation: result,
          updatedAt: iso(now),
        },
  );
  if ((updated.state === 'completed' || updated.state === 'reverted') && record.sponsorAddress)
    await releaseSponsor(store, config, record.sponsorAddress, record.id);
  return updated;
}

/** Read-only worker. Does not create, sign, broadcast, or book the demonstration ledger. */
export async function reconcileRobinhoodOperations(
  store: Store,
  client: PublicClient,
  config: RobinhoodServerConfig,
  after = '',
  limit = 50,
) {
  const rows = await store.scan<RobinhoodOperation>(operationPrefix, after, limit);
  const results: { id: string; state: RobinhoodOperation['state'] }[] = [];
  for (const { value } of rows) {
    if (!value.transactionHash || value.state === 'completed' || value.state === 'reverted')
      continue;
    const record = await reconcileRobinhoodRecord(store, client, config, value);
    results.push({ id: record.id, state: record.state });
  }
  return { results, nextCursor: rows.length === limit ? rows.at(-1)!.key : null };
}

export async function getRobinhoodService() {
  const [{ getStore }, { requireWalletRecovery }] = await Promise.all([
    import('./store.ts'),
    import('./recovery.ts'),
  ]);
  const config = loadRobinhoodConfig();
  return createRobinhoodService({
    store: await getStore(),
    client: createPublicClient({
      transport: http(config.manifest.rpcUrl, { timeout: 15_000, retryCount: 0 }),
    }),
    config,
    requireRecovery: requireWalletRecovery,
  });
}

export async function verifiedRobinhoodIdentity(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer [^\s]+$/.test(authorization))
    throw new RobinhoodServiceError('unauthenticated', 'Sign in to continue.', 401);
  const { verifyPrivyToken } = await import('./identity.ts');
  return verifyPrivyToken(authorization.slice(7));
}

export function robinhoodErrorResponse(error: unknown) {
  const candidate = error as {
    status?: number;
    code?: string;
    message?: string;
    details?: unknown;
  } | null;
  const known =
    error instanceof RobinhoodServiceError ||
    (error instanceof Error && error.name === 'RecoveryError');
  if (!known && !candidate?.code) return errorResponse(error);
  const status = known
    ? candidate!.status!
    : candidate?.code === 'unauthenticated'
      ? 401
      : candidate?.code === 'wallet_not_user_owned'
        ? 403
        : 503;
  return Response.json(
    {
      code: known || status !== 503 ? candidate?.code : 'unavailable',
      error:
        known || status !== 503
          ? candidate?.message
          : 'Native finance is not configured or temporarily unavailable.',
      ...(error instanceof RobinhoodServiceError && error.details
        ? { details: error.details }
        : {}),
    },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
