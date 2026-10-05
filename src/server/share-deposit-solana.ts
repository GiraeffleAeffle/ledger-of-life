import { createHash, randomUUID } from 'node:crypto';
import { address, createNoopSigner, getAddressDecoder, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { formatUnits } from 'viem';
import { buildShareEscrowInstruction, decodePrice, decodeShareEscrow, initializeShareEscrowInstruction, isPriceFresh, lowerClaimShares, quoteClaimShares, requiredCoverShares, SHARE_SCALE, type ShareEscrow, type ShareEscrowAction, type SharesPrice, shareEscrowAddresses } from '../finance/solana/shares.ts';
import { decodeClassicTokenAccount, type AccountObservation } from '../finance/solana/observations.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';
import type { SolanaShareDepositForm } from '../domain/deposit-form.ts';
import type { ShareDepositAction, ShareDepositView, SolanaShareDepositPlan } from '../domain/share-deposit.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, agreementRole, requireOpenAgreement, walletFor, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import { WorkflowError } from '../domain/errors.ts';
import { shareActions, requireShareActionRole } from './share-deposit.ts';
import { createBaseSolanaGateway, type BaseSolanaGateway } from './solana-rpc.ts';
import { configuredSolanaOperations, type SolanaOperations } from './solana-operations.ts';
import { solanaSharesConfiguration, type SolanaSharesManifest } from './solana-shares-config.ts';
import type { Store } from './store.ts';
import type { Listing } from './listings.ts';
import { readPriceJob, shapePriceJob } from './price-job-health.ts';
import { ensureSolanaSharesPrice } from './solana-price-mirror.ts';

export type ShareDepositReadGateway = Pick<BaseSolanaGateway, 'checkedGenesis' | 'multiple'>;
export type SolanaShareDepositDependencies = { manifest?: () => Promise<SolanaSharesManifest | null>; gateway?: ShareDepositReadGateway; operations?: SolanaOperations; sponsor?: string; environment?: Record<string, string | undefined> };
export type SolanaShareDepositSnapshot = { escrow: ShareEscrow | null; price: SharesPrice; walletShares: bigint; lockedShares: bigint; escrowAddress: string; vault: string; shareAccount: string; now: bigint };
type StoredPlan = SolanaShareDepositPlan & { subject: string; record?: Agreement['records'][number] };
const clockAddress = 'SysvarC1ock11111111111111111111111111111111';
const states = { 'awaiting-lock': 'AwaitingLock', active: 'Active', 'claim-pending': 'ClaimPending', 'claim-contested': 'ClaimContested', closed: 'Closed' } as const;
const hashBytes = (hash: string) => { if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new WorkflowError('An accepted agreement digest is required.'); return new Uint8Array(Buffer.from(hash.slice(2), 'hex')); };
const historyKey = (id: string) => `solana-share-deposit-history:${id}`;
const planKey = (id: string) => `solana-share-deposit-plan:${id}`;
async function recordSolanaShareReceipt(store: Store, plan: StoredPlan, signature: string, status: ShareDepositView['receipts'][number]['status']) {
  const key = historyKey(plan.rentalId);
  if (!await store.get(key)) { try { await store.create<ShareDepositView['receipts']>(key, []); } catch (error) { if (!await store.get(key)) throw error; } }
  await store.update<ShareDepositView['receipts']>(key, receipts => {
    const previous = receipts.find(receipt => receipt.planId === plan.id);
    requireCondition(!previous || previous.transactionHash === signature, 'Share receipt signature changed.');
    return [...receipts.filter(receipt => receipt.planId !== plan.id), { planId: plan.id, action: plan.action, walletId: plan.walletId, transactionHash: signature, status: previous && previous.status !== 'pending' ? previous.status : status }];
  });
  if (status === 'confirmed' && plan.record) await store.update<Agreement>(`agreement:${plan.rentalId}`, current => current.records.some(record => record.id === plan.record!.id) ? current : { ...current, records: [...current.records, plan.record!] });
}
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new ConflictError(message); }
function atomic(value: unknown, zero = false) { if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || (!zero && value === '0') || BigInt(value) > (1n << 64n) - 1n) throw new WorkflowError('Choose an exact six-decimal share or USD atomic amount.'); return BigInt(value); }
async function manifest(deps: SolanaShareDepositDependencies) { return (deps.manifest ?? (() => solanaSharesConfiguration(deps.environment)))(); }
function readGateway(config: SolanaSharesManifest, deps: SolanaShareDepositDependencies): ShareDepositReadGateway {
  if (deps.gateway) return deps.gateway;
  const environment = deps.environment ?? process.env;
  requireCondition(environment.SOLANA_RPC_URL, 'Solana shares RPC is not configured.');
  const url = new URL(environment.SOLANA_RPC_URL);
  requireCondition(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'RPC must use HTTPS or loopback.');
  return createBaseSolanaGateway({ rpcUrl: url.toString(), genesisHash: config.genesisHash, maximumSponsorLamports: '10000000' });
}
async function operationContext(store: Store, config: SolanaSharesManifest, deps: SolanaShareDepositDependencies) {
  if (deps.operations && deps.sponsor) return { operations: deps.operations, sponsor: { address: deps.sponsor } };
  return configuredSolanaOperations(store, { cluster: config.cluster, genesisHash: config.genesisHash, maximumSponsorLamports: 10_000_000n }, deps.environment);
}
async function rental(store: Store, identity: VerifiedIdentity, id: string) {
  const agreement = await store.get<Agreement>(`agreement:${id}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  const role = agreementRole(agreement, identity), form = agreement.depositForm;
  requireCondition(form?.kind === 'shares' && form.network === 'solana-devnet', 'This tenancy does not use Solana test shares.');
  const party = agreement.parties[role];
  requireCondition(party?.wallet.chainType === 'solana' && identity.wallets.some(wallet => wallet.chainType === 'solana' && wallet.id === party.wallet.id && wallet.address === party.wallet.address), 'Use the verified Solana wallet bound to this agreement.');
  return { agreement, role, form, wallet: party.wallet };
}
function tokenBalance(row: AccountObservation | null, mint: string, owner: string, missing = false) {
  if (!row && missing) return 0n;
  requireCondition(row, 'Share token account is missing.');
  const token = decodeClassicTokenAccount(row);
  requireCondition(token.mint === mint && token.authority === owner && token.initialized && !token.frozen, 'Share token account owner, mint or state differs from the review.');
  return BigInt(token.amountAtomic);
}
export function requireSolanaShareEscrowBinding(escrow: ShareEscrow, agreement: Agreement, form: SolanaShareDepositForm) {
  const hash = agreementDigest(agreement);
  requireCondition(hash && Buffer.from(escrow.agreementHash).equals(Buffer.from(hashBytes(hash))) && escrow.tenant === agreement.parties.tenant?.wallet.address && escrow.landlord === agreement.parties.landlord?.wallet.address && escrow.arbitrator === agreement.parties.arbitrator?.wallet.address && escrow.shareMint === form.mint && escrow.depositValue.toString() === form.securityUsd6 && escrow.responseWindow === BigInt(form.responseWindow) && escrow.returnWindow === BigInt(form.returnWindow) && escrow.arbitrationWindow === BigInt(form.arbitrationWindow), 'Share escrow differs from the accepted parties, security, digest or windows.');
}
export async function readSolanaShareDepositSnapshot(config: SolanaSharesManifest, gateway: ShareDepositReadGateway, owner: string, agreement?: Agreement): Promise<SolanaShareDepositSnapshot> {
  requireCondition(await gateway.checkedGenesis() === config.genesisHash, 'Shares RPC genesis differs from devnet.');
  const shareAccount = (await findAssociatedTokenPda({ owner: address(owner), mint: address(config.shareMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const hash = agreement ? agreementDigest(agreement) : null;
  const keys = hash ? await shareEscrowAddresses(agreement!.parties.landlord!.wallet.address, hashBytes(hash)) : null;
  const requestedKeys = [config.programId, config.shareMint, config.price, shareAccount, clockAddress, ...(keys ? [keys.escrow, keys.vault] : [])];
  const observed = await gateway.multiple(requestedKeys);
  requireCondition(observed.accounts.length === requestedKeys.length && observed.accounts.every((row, index) => !row || row.address === requestedKeys[index]), 'Shares snapshot accounts differ from the reviewed addresses.');
  const [program, mint, priceRow, walletRow, clock, escrowRow, vaultRow] = observed.accounts;
  requireCondition(program?.executable && mint && !mint.executable && mint.owner === TOKEN_PROGRAM_ADDRESS && mint.data.length === 82 && mint.data[44] === 6 && mint.data[45] === 1, 'Shares program or classic six-decimal mint is unavailable.');
  const mintView = new DataView(mint.data.buffer, mint.data.byteOffset, mint.data.byteLength);
  requireCondition(mintView.getUint32(0, true) === 1 && getAddressDecoder().decode(mint.data.subarray(4, 36)) === config.shareMint && mintView.getUint32(46, true) === 0, 'Test-share mint authority or freeze authority mismatch.');
  requireCondition(priceRow && !priceRow.executable && priceRow.owner === config.programId, 'Share price PDA is unavailable.');
  const price = decodePrice(priceRow.data);
  requireCondition(price.authority === config.priceAuthority && price.shareMint === config.shareMint && price.initialPriceUsdE6.toString() === config.initialPriceUsdE6 && price.initialPublishedAt.toString() === config.initialPricePublishedAt, 'Share price identity or initialization differs from the deployment.');
  requireCondition(clock && !clock.executable && clock.owner === 'Sysvar1111111111111111111111111111111111111' && clock.data.length === 40, 'Finalized shares clock is unavailable.');
  const clockView = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength), now = clockView.getBigInt64(32, true);
  requireCondition(now >= 0n && now <= BigInt(Number.MAX_SAFE_INTEGER) && clockView.getBigUint64(0, true).toString() === observed.slot, 'Shares clock does not match the finalized bank.');
  let escrow: ShareEscrow | null = null, lockedShares = 0n;
  if (escrowRow) {
    requireCondition(keys && agreement && escrowRow.owner === config.programId && !escrowRow.executable, 'Escrow program owner mismatch.');
    escrow = decodeShareEscrow(escrowRow.data);
    const form = agreement.depositForm;
    requireCondition(form?.kind === 'shares' && form.network === 'solana-devnet', 'Missing Solana share terms.');
    requireSolanaShareEscrowBinding(escrow, agreement, form);
    lockedShares = tokenBalance(vaultRow, config.shareMint, keys.escrow);
  } else requireCondition(!vaultRow, 'An escrow vault exists without its accepted escrow.');
  return { escrow, price, walletShares: tokenBalance(walletRow, config.shareMint, owner, true), lockedShares, escrowAddress: keys?.escrow ?? '', vault: keys?.vault ?? '', shareAccount, now };
}
function requireManifestForm(config: SolanaSharesManifest, form: SolanaShareDepositForm) { requireCondition(form.programId === config.programId && form.factory === config.programId && form.mint === config.shareMint && form.stock === config.shareMint && form.oracle === config.price && form.decimals === 6 && form.initialRatioBps === 15000 && form.topUpRatioBps === 12500, 'The configured program, mint or price differs from these accepted share terms.'); }
export async function readSolanaShareListingQuote(store: Store, identity: VerifiedIdentity, id: string, deps: SolanaShareDepositDependencies = {}) {
  const listing = await store.get<Listing>(`listing:${id}`), form = listing?.depositForm;
  requireCondition(form?.kind === 'shares' && form.network === 'solana-devnet', 'This Solana share listing is unavailable.');
  const config = await manifest(deps);
  if (!config) return { deployment: 'not_deployed' as const, network: 'solana-devnet', decimals: 6, quote: null, requiredShares: null, walletShares: null, priceJob: null };
  requireManifestForm(config, form);
  const wallet = walletFor(identity, 'solana'), snapshot = await readSolanaShareDepositSnapshot(config, readGateway(config, deps), wallet.address);
  const fresh = isPriceFresh(snapshot.price, snapshot.now);
  return { deployment: 'deployed' as const, network: 'solana-devnet', decimals: 6, quote: { priceUsd6: String(snapshot.price.priceUsdE6), sourceTime: Number(snapshot.price.publishedAt), copiedAt: Number(snapshot.price.copiedAt), fresh }, requiredShares: fresh ? String(requiredCoverShares(BigInt(form.securityUsd6), snapshot.price.priceUsdE6)) : null, walletShares: String(snapshot.walletShares), walletAddress: wallet.address, priceJob: shapePriceJob(await readPriceJob(store), Number(snapshot.now)) };
}
export async function readSolanaShareDeposit(store: Store, identity: VerifiedIdentity, id: string, deps: SolanaShareDepositDependencies = {}): Promise<ShareDepositView> {
  const { agreement, role, form, wallet } = await rental(store, identity, id), config = await manifest(deps), hash = agreementDigest(agreement);
  const priceJob = shapePriceJob(await readPriceJob(store), Math.floor(Date.now() / 1000));
  const view: ShareDepositView = { kind: 'shares', rentalId: id, network: 'solana-devnet', decimals: 6, chainId: 'solana-devnet', deployment: config ? 'deployed' : 'not_deployed', escrow: null, state: null, agreementHash: hash, form, role, quote: null, priceJob, walletShares: '0', lockedShares: '0', requiredShares: null, maximumWithdrawShares: null, coverBps: null, needsTopUp: false, claim: null, responseDeadline: 0, returnDeadline: 0, arbitrationDeadline: 0, landlordOwed: '0', custodyShortfall: false, paidOut: false, actions: [], receipts: await store.get<ShareDepositView['receipts']>(historyKey(id)) ?? [], warnings: ['Solana devnet · test tTSLA shares with no value. Settlement is in kind; no yield, sale or liquidation.'], explorerUrl: null };
  if (!config) return view;
  requireManifestForm(config, form);
  const planIds = await store.get<string[]>(`solana-share-deposit-plans:${id}`) ?? [];
  const unreconciled = planIds.filter(planId => !view.receipts.some(receipt => receipt.planId === planId && receipt.status !== 'pending'));
  if (unreconciled.length) {
    const { operations } = await operationContext(store, config, deps);
    for (const planId of unreconciled) {
      const plan = await store.get<StoredPlan>(planKey(planId));
      requireCondition(plan?.rentalId === id, 'Share receipt journal differs from this tenancy.');
      const result = await operations.reconcile({ id: planId });
      if (result.signature) await recordSolanaShareReceipt(store, plan, result.signature, result.state === 'confirmed' ? 'confirmed' : result.state === 'failed' || result.state === 'expired' ? 'failed' : 'pending');
    }
    view.receipts = await store.get<ShareDepositView['receipts']>(historyKey(id)) ?? [];
  }
  const snapshot = await readSolanaShareDepositSnapshot(config, readGateway(config, deps), wallet.address, agreement), escrow = snapshot.escrow, fresh = isPriceFresh(snapshot.price, snapshot.now);
  view.priceJob = shapePriceJob(await readPriceJob(store), Number(snapshot.now));
  view.quote = { priceUsd6: String(snapshot.price.priceUsdE6), sourceTime: Number(snapshot.price.publishedAt), copiedAt: Number(snapshot.price.copiedAt), fresh };
  view.walletShares = String(snapshot.walletShares); view.lockedShares = String(snapshot.lockedShares);
  if (escrow) {
    view.escrow = snapshot.escrowAddress; view.state = states[escrow.state];
    view.responseDeadline = Number(escrow.responseDeadline); view.returnDeadline = Number(escrow.returnDeadline); view.arbitrationDeadline = escrow.arbitrationAuthorized ? Number(escrow.arbitrationStartedAt + escrow.arbitrationWindow) : 0;
    view.landlordOwed = String(escrow.landlordOwed); view.custodyShortfall = snapshot.lockedShares < escrow.trackedBalance;
    view.claim = { usd6: String(escrow.claimUsd6), shares: String(escrow.claimShares), evidenceHash: `0x${Buffer.from(escrow.claimEvidenceHash).toString('hex')}`, price6: String(escrow.claimPrice6), sourceTime: Number(escrow.claimSourceTime) };
    view.explorerUrl = `https://explorer.solana.com/address/${snapshot.escrowAddress}?cluster=devnet`;
  }
  if (fresh) {
    view.requiredShares = String(requiredCoverShares(BigInt(form.securityUsd6), snapshot.price.priceUsdE6));
    view.coverBps = Number(snapshot.lockedShares * snapshot.price.priceUsdE6 * 10_000n / (BigInt(form.securityUsd6) * SHARE_SCALE));
    view.needsTopUp = view.state === 'Active' && snapshot.lockedShares * snapshot.price.priceUsdE6 * 10_000n < BigInt(form.securityUsd6) * SHARE_SCALE * 12_500n;
  } else view.warnings.push('The mirrored USD price is stale or unavailable. Price-free exits remain available.');
  if (view.state === 'AwaitingLock') view.maximumWithdrawShares = view.lockedShares;
  else if (view.state === 'Active' && view.requiredShares !== null) view.maximumWithdrawShares = String(snapshot.lockedShares > BigInt(view.requiredShares) ? snapshot.lockedShares - BigInt(view.requiredShares) : 0n);
  view.paidOut = view.state === 'Closed' && snapshot.lockedShares === 0n && escrow?.trackedBalance === 0n && escrow.landlordOwed === 0n && view.receipts.some(receipt => receipt.action === 'payout' && receipt.status === 'confirmed');
  const authorized = !agreement.cancelled && !!hash && agreement.accepted.tenant?.digest === hash && agreement.accepted.landlord?.digest === hash;
  view.actions = shareActions(view, authorized, Number(snapshot.now)).filter(action => action !== 'approve');
  if (view.custodyShortfall) { view.warnings.push('Share custody is below the recorded balance. Review the escrow before further funding.'); view.actions = view.actions.filter(action => !['create', 'pledge', 'activate'].includes(action)); }
  return view;
}
export function solanaShareActionQuote(operation: ShareDepositAction, input: Record<string, unknown>, view: ShareDepositView): { action: ShareEscrowAction | null; shares: bigint | null; usd6: bigint | null } {
  let shares: bigint | null = null, usd6: bigint | null = null, action: ShareEscrowAction | null = null;
  if (operation === 'create') return { action, shares, usd6 };
  if (operation === 'pledge' || operation === 'withdraw' || operation === 'resolveClaim') {
    shares = atomic(input.shares, operation === 'resolveClaim');
    if (operation === 'pledge') requireCondition(shares <= BigInt(view.walletShares), 'Get enough test tTSLA from the site faucet first.');
    if (operation === 'withdraw') requireCondition(shares <= BigInt(view.maximumWithdrawShares ?? '0'), 'Withdrawal would exceed custody or leave less than fresh 150% cover.');
    if (operation === 'resolveClaim') requireCondition(shares <= BigInt(view.claim?.shares ?? '0'), 'Arbitration award exceeds the current fixed claim.');
    action = operation === 'resolveClaim' ? { kind: 'resolve_claim', shares } : { kind: operation, amount: shares };
  } else if (operation === 'proposeClaim' || operation === 'lowerClaim') {
    usd6 = atomic(input.usd6, true);
    requireCondition(usd6 <= BigInt(view.form.securityUsd6), 'Claim exceeds the agreed USD security.');
    if (operation === 'proposeClaim') {
      requireCondition(usd6 === 0n || view.quote?.fresh, 'A positive claim requires a fresh price.');
      shares = usd6 === 0n ? 0n : quoteClaimShares(usd6, BigInt(view.quote!.priceUsd6), BigInt(view.lockedShares));
      action = { kind: 'propose_claim', usd6, evidenceHash: new Uint8Array(32) };
    } else {
      requireCondition(usd6 < BigInt(view.claim?.usd6 ?? '0'), 'A lowered claim must be strictly smaller.');
      shares = usd6 === 0n ? 0n : lowerClaimShares(usd6, BigInt(view.claim!.price6), BigInt(view.claim!.shares));
      action = { kind: 'lower_claim', usd6 };
    }
  } else if (operation === 'acceptClaim') {
    shares = atomic(input.maxShares, true);
    requireCondition(shares === BigInt(view.claim?.shares ?? '0'), 'Review the exact current fixed claim shares.');
    action = { kind: 'accept_claim', maxShares: shares };
  } else if (operation === 'payout') {
    requireCondition(input.side === 'tenant' || input.side === 'landlord', 'Choose a fixed payout side.');
    const locked = BigInt(view.lockedShares), owed = BigInt(view.landlordOwed), award = owed < locked ? owed : locked;
    shares = input.side === 'landlord' ? award : locked - award;
    action = { kind: 'payout', toLandlord: input.side === 'landlord' };
  } else {
    const names = { activate: 'activate', contestClaim: 'contest_claim', escalateClaim: 'escalate_claim', requestReturn: 'request_return', closeUnclaimed: 'close_unclaimed', closeUnresolved: 'close_unresolved' } as const;
    if (!(operation in names)) throw new WorkflowError('Unknown Solana share-deposit action.');
    action = { kind: names[operation as keyof typeof names] };
  }
  return { action, shares, usd6 };
}
export async function prepareSolanaShareDeposit(store: Store, identity: VerifiedIdentity, id: string, operation: ShareDepositAction, input: Record<string, unknown>, deps: SolanaShareDepositDependencies = {}): Promise<SolanaShareDepositPlan> {
  const { agreement, role, form, wallet } = await rental(store, identity, id);
  requireOpenAgreement(agreement); requireShareActionRole(operation, role);
  requireCondition(typeof input.requestId === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId), 'Provide a durable request ID for this exact action.');
  const requestKey = `solana-share-deposit-request:${createHash('sha256').update(JSON.stringify([identity.subject, id, operation, input.requestId])).digest('hex')}`;
  const fingerprint = createHash('sha256').update(JSON.stringify([agreementDigest(agreement), wallet.id, input.shares, input.usd6, input.maxShares, input.side, input.evidence])).digest('hex');
  type RequestRecord = { fingerprint: string; planId?: string; evidence?: Agreement['records'][number] };
  let request = await store.get<RequestRecord>(requestKey);
  if (request) {
    requireCondition(request.fingerprint === fingerprint, 'This request ID already reviews another share action or amount.');
    if (request.planId) {
      const previous = await store.get<StoredPlan>(planKey(request.planId));
      requireCondition(previous, 'The durable share review is unavailable.');
      const { subject, record, ...publicPlan } = previous;
      void subject; void record;
      return publicPlan;
    }
  }
  const config = await manifest(deps); requireCondition(config, 'Solana shares are not deployed.');
  requireManifestForm(config, form);
  const context = await operationContext(store, config, deps);
  if (operation === 'activate' || operation === 'proposeClaim' && input.usd6 !== '0' || operation === 'withdraw') await ensureSolanaSharesPrice(store, config, { operations: context.operations, gateway: readGateway(config, deps), environment: deps.environment });
  const view = await readSolanaShareDeposit(store, identity, id, deps);
  requireCondition(view.actions.includes(operation), 'This share action is unavailable in the current state or window.');
  const quote = solanaShareActionQuote(operation, input, view), hash = view.agreementHash!;
  const landlord = agreement.parties.landlord!.wallet.address, tenant = agreement.parties.tenant!.wallet.address, arbitrator = agreement.parties.arbitrator!.wallet.address;
  const keys = await shareEscrowAddresses(landlord, hashBytes(hash));
  const targetOwner = operation === 'payout' ? input.side === 'landlord' ? landlord : tenant : wallet.address;
  const shareAccount = (await findAssociatedTokenPda({ owner: address(targetOwner), mint: address(config.shareMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  let record: Agreement['records'][number] | undefined;
  if (['proposeClaim', 'contestClaim', 'resolveClaim'].includes(operation)) {
    requireCondition(typeof input.evidence === 'string' && input.evidence.trim().length >= 10 && input.evidence.length <= 8000, 'Provide a move-out reason between 10 and 8,000 characters.');
    record = request?.evidence ?? { id: randomUUID(), name: operation === 'proposeClaim' ? 'Move-out inspection' : operation === 'contestClaim' ? 'Dispute the deduction' : 'Arbitration decision', body: input.evidence.trim(), by: identity.subject, at: new Date().toISOString() };
    if (quote.action?.kind === 'propose_claim') quote.action.evidenceHash = new Uint8Array(createHash('sha256').update(JSON.stringify({ domain: 'rental-move-out-evidence-v1', rentalId: id, record })).digest());
  }
  if (!request) {
    try { await store.create<RequestRecord>(requestKey, { fingerprint, ...(record ? { evidence: record } : {}) }); } catch (error) {
      const concurrent = await store.get<RequestRecord>(requestKey); if (!concurrent) throw error;
      requireCondition(concurrent.fingerprint === fingerprint, 'A concurrent request reviews a different share action.');
    }
    request = await store.get<RequestRecord>(requestKey);
    if (request?.evidence) {
      record = request.evidence;
      if (quote.action?.kind === 'propose_claim') quote.action.evidenceHash = new Uint8Array(createHash('sha256').update(JSON.stringify({ domain: 'rental-move-out-evidence-v1', rentalId: id, record })).digest());
    }
  }
  const instructions: Instruction[] = [], expectedDeltas: ExpectedTokenDelta[] = [];
  if (operation !== 'create') instructions.push(getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(context.sponsor.address)), owner: address(targetOwner), mint: address(config.shareMint), ata: shareAccount, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  instructions.push(operation === 'create' ? await initializeShareEscrowInstruction({ payer: context.sponsor.address, landlord, tenant, arbitrator, agreementHash: hashBytes(hash), depositValue: form.securityUsd6, responseWindow: String(form.responseWindow), returnWindow: String(form.returnWindow), arbitrationWindow: String(form.arbitrationWindow) }) : await buildShareEscrowInstruction({ authority: wallet.address, landlord, agreementHash: hashBytes(hash), shareAccount, action: quote.action! }));
  if (operation === 'pledge' || operation === 'withdraw' || operation === 'payout') {
    const amount = quote.shares!, inflow = operation === 'pledge';
    expectedDeltas.push({ account: shareAccount, mint: config.shareMint, owner: targetOwner, direction: inflow ? 'debit' : 'credit', minimumAtomic: amount.toString(), maximumAtomic: amount.toString(), ...(!inflow ? { allowCreated: true } : {}) }, { account: keys.vault, mint: config.shareMint, owner: keys.escrow, direction: inflow ? 'credit' : 'debit', minimumAtomic: amount.toString(), maximumAtomic: amount.toString() });
  }
  const lines = [`Rental: ${agreement.property}`, `Network: Solana devnet · test shares with no value`, `Agreement digest: ${hash}`, `Program: ${config.programId}`, `Mint: ${config.shareMint} · 6 decimals`, `Escrow: ${keys.escrow}`, `Actor: ${wallet.address} · ${role}`, `Tenant: ${tenant}`, `Landlord: ${landlord}`, `Arbitrator: ${arbitrator}`, `USD security: $${formatUnits(BigInt(form.securityUsd6), 6)} · activation cover 150% · top-up warning below 125%`, `Windows: response ${form.responseWindow}s · return ${form.returnWindow}s · arbitration ${form.arbitrationWindow}s`, `Action: ${operation} · sponsor pays fees and account rent; native user debit 0 SOL`];
  if (quote.shares !== null) lines.push(`${operation === 'proposeClaim' ? 'Estimated proposal shares' : 'Exact reviewed shares'}: ${formatUnits(quote.shares, 6)} tTSLA (${quote.shares} atomic)`);
  if (quote.usd6 !== null) lines.push(`USD claim: $${formatUnits(quote.usd6, 6)} (${quote.usd6} atomic USD)`);
  if (operation === 'proposeClaim') lines.push(`Evidence hash: 0x${Buffer.from((quote.action as Extract<ShareEscrowAction, { kind: 'propose_claim' }>).evidenceHash).toString('hex')}`, 'The program fixes the claim shares at the fresh price when this transaction executes, rounded up and capped at custody. A newer price may change the displayed estimate.');
  if (operation === 'lowerClaim') lines.push('Lowered claim uses the original proposal price, rounds down, and cannot increase the fixed claim shares.');
  if (operation === 'acceptClaim') lines.push('Acceptance is capped at these exact reviewed shares; a concurrent lowered claim can only reduce the award.');
  if (operation === 'payout' || operation === 'withdraw') lines.push(`Fixed recipient: ${targetOwner} · share token account ${shareAccount}. Settlement is in kind; no sale.`);
  if (view.quote) lines.push(`Price: $${formatUnits(BigInt(view.quote.priceUsd6), 6)} per tTSLA · source ${new Date(view.quote.sourceTime * 1000).toISOString()} · ${view.quote.fresh ? 'fresh' : 'stale; price-free action'}`);
  lines.push('Silence never awards the landlord. Unclaimed return and arbitration timeouts return the shares to the tenant.');
  const review: SolanaShareDepositPlan['review'] = { title: `${operation} · Solana test-share deposit`, lines, programId: config.programId, mint: config.shareMint, escrow: keys.escrow, agreementHash: hash, securityUsd6: form.securityUsd6, responseWindow: form.responseWindow, returnWindow: form.returnWindow, arbitrationWindow: form.arbitrationWindow, actor: wallet.address, tenant, landlord, arbitrator, shares: quote.shares === null ? null : String(quote.shares), usd6: quote.usd6 === null ? null : String(quote.usd6), priceUsd6: view.quote?.priceUsd6 ?? null };
  const prepared = await context.operations.prepare({ identity, kind: `share-deposit:${id}:${operation}`, requestId: input.requestId, actor: address(wallet.address), walletId: wallet.id, instructions, review, expectedDeltas });
  const plan: SolanaShareDepositPlan = { ...prepared, rentalId: id, action: operation, network: 'solana-devnet', review };
  const existing = await store.get<StoredPlan>(planKey(plan.id));
  if (!existing) await store.create<StoredPlan>(planKey(plan.id), { ...plan, subject: identity.subject, ...(record ? { record } : {}) });
  const journalKey = `solana-share-deposit-plans:${id}`;
  if (!await store.get(journalKey)) { try { await store.create<string[]>(journalKey, []); } catch (error) { if (!await store.get(journalKey)) throw error; } }
  await store.update<string[]>(journalKey, ids => ids.includes(plan.id) ? ids : [...ids, plan.id]);
  await store.update<RequestRecord>(requestKey, current => ({ ...current, planId: plan.id }));
  return plan;
}
export async function submitSolanaShareDeposit(store: Store, identity: VerifiedIdentity, planId: string, signedTransactionBase64?: string, deps: SolanaShareDepositDependencies = {}) {
  const plan = await store.get<StoredPlan>(planKey(planId)); if (!plan) throw new AccessError('Solana share-deposit review is unavailable.');
  const { agreement, wallet, form } = await rental(store, identity, plan.rentalId);
  requireCondition(plan.subject === identity.subject && wallet.id === plan.walletId && plan.review.agreementHash === agreementDigest(agreement), 'This share review belongs to different accepted terms or wallet.');
  if (signedTransactionBase64) requireOpenAgreement(agreement);
  const config = await manifest(deps); requireCondition(config, 'Solana shares are not configured.');
  requireManifestForm(config, form);
  const context = await operationContext(store, config, deps);
  const result = signedTransactionBase64 ? await context.operations.submit({ identity, id: planId, signedTransactionBase64 }) : await context.operations.reconcile({ identity, id: planId });
  const status = result.state === 'confirmed' ? 'confirmed' as const : result.state === 'failed' || result.state === 'expired' ? 'failed' as const : 'pending' as const;
  if (result.signature) await recordSolanaShareReceipt(store, plan, result.signature, status);
  return { transactionHash: result.signature, status, state: result.state, explorerUrl: result.signature ? `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` : null, view: await readSolanaShareDeposit(store, identity, plan.rentalId, deps) };
}
export async function cancelSolanaShareDeposit(store: Store, identity: VerifiedIdentity, planId: string, deps: SolanaShareDepositDependencies = {}) {
  const plan = await store.get<StoredPlan>(planKey(planId)); if (!plan || plan.subject !== identity.subject) throw new AccessError('This share review is unavailable.');
  await rental(store, identity, plan.rentalId);
  const config = await manifest(deps); requireCondition(config, 'Solana shares are not configured.');
  return (await operationContext(store, config, deps)).operations.cancel({ identity, id: planId });
}
