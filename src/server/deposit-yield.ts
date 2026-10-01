import { randomUUID } from 'node:crypto';
import { SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import type { TenancyAccount } from '../finance/solana/program.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementRole, requireReady, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import { RpcSolanaGateway } from './solana-rpc.ts';
import type { SolanaOperation } from './solana-service.ts';
import { solanaServicesFor } from './solana-tenancies.ts';
import type { Store } from './store.ts';
import { executeTestUsdcPayout, testUsdcPayoutContext, type MintJournal, type TestUsdcClient } from './test-usdc-payout.ts';

export const DEPOSIT_YIELD_YEAR_MS = 365 * 86_400_000;
export interface DepositYieldView {
  accruedAtomic: string; claimedAtomic: string; claimableAtomic: string; rateBps: number;
  since: string | null; until: string | null; observedAt: string; claimAllowed: boolean; pendingRequestId: string | null;
}
type Claim = MintJournal & { requestId: string; wallet: string; lease: string; busyUntil: number; status: 'pending' | 'confirmed' | 'failed' | 'expired' };
type YieldLedger = { claimedAtomic: string; claims: Claim[] };
type Operation = Pick<SolanaOperation, 'state' | 'action' | 'receipt'>;
type YieldOptions = { environment?: Record<string, string | undefined>; now?: () => number; client?: TestUsdcClient; resolveServices?: typeof solanaServicesFor };

export function depositYieldRate(environment: Record<string, string | undefined> = process.env) {
  const raw = environment.DEPOSIT_TEST_YIELD_BPS ?? '500';
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('DEPOSIT_TEST_YIELD_BPS must be a non-negative integer.');
  return Number(raw);
}

/** Simple interest, rounded down once to six-decimal atomic units. No client time enters payouts. */
export function accruedDepositYield(input: { requiredAtomic: string; mint: string; cancelled?: boolean; since: number | null; until?: number | null; now: number; rateBps: number }) {
  if (input.mint !== SOLANA_TEST_USDC_MINT || input.cancelled || input.since === null) return '0';
  const elapsed = Math.max(0, Math.min(input.now, input.until ?? input.now) - input.since);
  return (BigInt(input.requiredAtomic) * BigInt(input.rateBps) * BigInt(Math.floor(elapsed)) / (10_000n * BigInt(DEPOSIT_YIELD_YEAR_MS))).toString();
}

export async function readDepositYield(
  store: Store, agreement: Agreement, tenancy: Pick<TenancyAccount, 'phase' | 'depositMint' | 'requiredSecurityAtomic'>,
  operations: readonly Operation[], rpc: (method: string, params: unknown[]) => Promise<unknown>, options: YieldOptions = {},
): Promise<DepositYieldView> {
  const now = (options.now ?? Date.now)();
  const environment = options.environment ?? process.env;
  let rateBps = depositYieldRate(environment);
  const ledger = await store.get<YieldLedger>(`deposit-yield:${agreement.id}`);
  const claimedAtomic = ledger?.claimedAtomic ?? '0';
  let since: number | null = null;
  let until: number | null = null;
  if (tenancy.depositMint === SOLANA_TEST_USDC_MINT && !agreement.cancelled && tenancy.phase !== 'awaiting-funding') {
    for (const [kind, matches] of [
      ['fund', ['fund', 'fund_and_supply']],
      ['settle', ['settle', 'accept_and_settle', 'resolve_and_settle', 'redeem_and_settle']],
    ] as const) {
      const operation = operations.find((op) => op.state === 'finalized' && (matches as readonly string[]).includes(op.action.kind));
      const receipt = operation?.receipt as { status?: string; slot?: string } | null;
      if (receipt?.status !== 'finalized' || !receipt.slot || !/^[0-9]+$/.test(receipt.slot) || !Number.isSafeInteger(Number(receipt.slot))) continue;
      const key = `deposit-yield-time:${agreement.id}:${kind}:${receipt.slot}`;
      let saved = await store.get<{ at: number; rateBps: number }>(key);
      if (!saved) {
        const seconds = await rpc('getBlockTime', [Number(receipt.slot)]);
        if (!Number.isSafeInteger(seconds) || Number(seconds) <= 0) continue;
        try { await store.create(key, { at: Number(seconds) * 1000, rateBps }); }
        catch (error) { if (!await store.get(key)) throw error; }
        saved = await store.get(key);
      }
      if (kind === 'fund') { since = saved!.at; rateBps = saved!.rateBps; }
      else until = saved!.at;
    }
  }
  // A closed escrow with missing settlement evidence must not keep ticking or mint an estimate.
  const evidenced = tenancy.phase !== 'closed' || until !== null;
  const accruedAtomic = evidenced ? accruedDepositYield({ requiredAtomic: tenancy.requiredSecurityAtomic, mint: tenancy.depositMint, cancelled: Boolean(agreement.cancelled), since, until, now, rateBps }) : '0';
  const pending = ledger?.claims.find((claim) => claim.status === 'pending');
  const claimAllowed = evidenced && since !== null && !agreement.cancelled && (agreement.releaseAllowed || tenancy.phase === 'closed');
  const due = BigInt(accruedAtomic) - BigInt(claimedAtomic);
  return { accruedAtomic, claimedAtomic, claimableAtomic: claimAllowed && due > 0n ? due.toString() : '0', rateBps,
    since: since === null || !evidenced ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString(),
    observedAt: new Date(now).toISOString(), claimAllowed, pendingRequestId: pending?.requestId ?? null };
}

export async function claimDepositYield(store: Store, identity: VerifiedIdentity, agreementId: string, requestId: string, options: YieldOptions = {}) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) throw new ConflictError('A stable claim request id is required.');
  const agreement = await store.get<Agreement>(`agreement:${agreementId}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  requireReady(identity);
  if (agreementRole(agreement, identity) !== 'tenant' || agreement.network !== 'solana' || agreement.parties.tenant?.wallet.chainType !== 'solana')
    throw new AccessError('Only the verified Solana tenant can claim deposit yield.');
  const environment = options.environment ?? process.env;
  const wallet = agreement.parties.tenant.wallet.address;
  const key = `deposit-yield:${agreement.id}`;
  const previous = await store.get<YieldLedger>(key);
  const replay = previous?.claims.find((claim) => claim.requestId === requestId && claim.status !== 'pending');
  if (replay) return { status: replay.status, signature: replay.signature, amountAtomic: replay.amountAtomic };
  const services = await (options.resolveServices ?? solanaServicesFor)(store, agreementId, environment);
  if (!services) throw new ConflictError('The deposit service is not configured.');
  const snapshot = await services.service.snapshot(identity);
  const context = await testUsdcPayoutContext(wallet, environment, options.client);
  if (!context) throw new ConflictError('This site’s simulated-yield payout is not configured.');
  const gateway = options.client ?? new RpcSolanaGateway(services.config);
  const view = await readDepositYield(store, agreement, snapshot.tenancy, snapshot.operations, gateway.rpc.bind(gateway), options);
  if (!view.claimAllowed) throw new ConflictError('Yield is claimable only after funding and, unless the agreement permits release, after settlement.');
  const at = (options.now ?? Date.now)();
  const lease = randomUUID();
  try { await store.create<YieldLedger>(key, { claimedAtomic: '0', claims: [] }); }
  catch (error) { if (!await store.get(key)) throw error; }
  const reserved = await store.update<YieldLedger>(key, (value) => {
    const existing = value.claims.find((claim) => claim.requestId === requestId);
    if (existing && existing.status !== 'pending') return value;
    const pending = value.claims.find((claim) => claim.status === 'pending');
    if (pending) {
      if (pending.requestId !== requestId || pending.wallet !== wallet || pending.busyUntil > at)
        throw new ConflictError('A yield claim is already in flight. Recover the pending claim first.');
      pending.lease = lease; pending.busyUntil = at + 60_000;
      return value;
    }
    const due = BigInt(view.accruedAtomic) - BigInt(value.claimedAtomic);
    if (due <= 0n) throw new ConflictError('No unclaimed simulated yield is available yet.');
    value.claims.push({ requestId, wallet, lease, busyUntil: at + 60_000, status: 'pending', amountAtomic: due.toString(), authority: context.authority.address, sponsor: context.sponsor.address, ata: context.ata });
    return value;
  });
  const claim = reserved.claims.find((item) => item.requestId === requestId)!;
  if (claim.status !== 'pending') return { status: claim.status, signature: claim.signature, amountAtomic: claim.amountAtomic };
  try {
    const result = await executeTestUsdcPayout(context, claim, async (journal) => {
      await store.update<YieldLedger>(key, (value) => {
        const current = value.claims.find((item) => item.requestId === requestId)!;
        if (current.lease !== lease) throw new ConflictError('Yield claim reservation changed. Retry to recover it.');
        Object.assign(current, journal);
        return value;
      });
    });
    await store.update<YieldLedger>(key, (value) => {
      const current = value.claims.find((item) => item.requestId === requestId)!;
      if (current.lease !== lease) throw new ConflictError('Yield claim reservation changed. Retry to recover it.');
      if (result.status === 'confirmed' && current.status === 'pending') value.claimedAtomic = (BigInt(value.claimedAtomic) + BigInt(current.amountAtomic)).toString();
      current.status = result.status;
      return value;
    });
    return result;
  } finally {
    await store.update<YieldLedger>(key, (value) => {
      const current = value.claims.find((item) => item.requestId === requestId);
      if (current?.lease === lease) {
        if (!current.signed) value.claims = value.claims.filter((item) => item !== current);
        else current.busyUntil = 0;
      }
      return value;
    });
  }
}
