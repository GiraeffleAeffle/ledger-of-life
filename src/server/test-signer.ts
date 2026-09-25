import {
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type KeyPairSigner,
} from '@solana/kit';
import { SOLANA_MAINNET_MANIFEST } from '../finance/solana/index.ts';
import type { TenancyAccount } from '../finance/solana/program.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { SolanaConfiguration } from './solana-rpc.ts';

/**
 * Test-signer mode: operator-held devnet keys stand in for the three people so a full
 * tenancy cycle runs without passkey prompts. It drives the real agreement, initialization
 * and operation services; only the wallet signature is produced locally. Runs recorded this
 * way are fixtures, never Privy or wallet evidence.
 */
export const TEST_SUBJECT_PREFIX = 'test-signer:';
export type TestRole = 'tenant' | 'landlord' | 'arbitrator';

export function assertTestSignerAllowed(
  environment: Record<string, string | undefined>,
  config: Pick<SolanaConfiguration, 'cluster' | 'genesisHash'>,
) {
  if (environment.SOLANA_TEST_SIGNER_MODE !== '1')
    throw new Error('Test-signer mode is off. Set SOLANA_TEST_SIGNER_MODE=1 explicitly.');
  if (environment.DATABASE_URL)
    throw new Error('Test-signer mode only runs against the local test database.');
  if (!['devnet', 'localnet'].includes(config.cluster) || config.genesisHash === SOLANA_MAINNET_MANIFEST.genesisHash)
    throw new Error('Test-signer mode is limited to devnet or localnet.');
}

/** Only agreements whose three parties are all test-signer fixtures may be driven. */
export function assertTestAgreement(agreement: {
  parties: Partial<Record<TestRole, { subject: string }>>;
}) {
  for (const role of ['tenant', 'landlord', 'arbitrator'] as const) {
    if (!agreement.parties[role]?.subject.startsWith(TEST_SUBJECT_PREFIX))
      throw new Error('Test signers only operate on test-signer agreements.');
  }
}

export function testIdentity(role: TestRole, address: string, now = Date.now()): VerifiedIdentity {
  return {
    subject: `${TEST_SUBJECT_PREFIX}${role}`,
    sessionId: `${TEST_SUBJECT_PREFIX}session`,
    expiresAt: Math.floor(now / 1000) + 3600,
    wallets: [{ id: `${TEST_SUBJECT_PREFIX}wallet-${role}`, address, chainType: 'solana' }],
    // Fixture flags: satisfy the agreement readiness rule; no real passkey or backup exists.
    passkeyCount: 1,
    backupLoginLinked: true,
  };
}

/** Sign exactly the server-prepared bytes with a role key; the message is never rebuilt. */
export async function signPrepared(signer: KeyPairSigner, transactionBase64: string) {
  const transaction = getTransactionDecoder().decode(Buffer.from(transactionBase64, 'base64'));
  const signed = await partiallySignTransaction([signer.keyPair], transaction);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

export type NextStep =
  | { role: TestRole; kind: 'initialize'; label: string }
  | { role: TestRole; kind: 'action'; action: Record<string, unknown>; label: string }
  | { role: null; kind: 'done'; label: string };

/** Next action of a happy-path cycle; `claimAtomic` and `dispute` shape the move-out branch. */
export function nextTestStep(input: {
  initialized: boolean;
  tenancy?: Pick<
    TenancyAccount,
    | 'phase'
    | 'accountedIdleAtomic'
    | 'accountedReceiptsAtomic'
    | 'claimAtomic'
    | 'tenantOwedAtomic'
    | 'landlordOwedAtomic'
  >;
  receiptValueAtomic?: string;
  supplied: boolean;
  claimAtomic: string;
  dispute: boolean;
}): NextStep {
  const t = input.tenancy;
  if (!input.initialized || !t) return { role: 'landlord', kind: 'initialize', label: 'Landlord creates the empty deposit space' };
  const redeem = (role: TestRole): NextStep => ({
    role,
    kind: 'action',
    action: {
      kind: 'redeem',
      receiptAtomic: t.accountedReceiptsAtomic,
      minimumReceivedAtomic: input.receiptValueAtomic ?? '1',
    },
    label: `${role} redeems the lending position`,
  });
  switch (t.phase) {
    case 'awaiting-funding':
      return { role: 'tenant', kind: 'action', action: { kind: 'fund' }, label: 'Tenant funds the deposit' };
    case 'active':
      if (BigInt(t.accountedReceiptsAtomic) > 0n) return redeem('tenant');
      if (!input.supplied && BigInt(t.accountedIdleAtomic) > 0n)
        return {
          role: 'tenant',
          kind: 'action',
          action: { kind: 'supply', amountAtomic: t.accountedIdleAtomic },
          label: 'Tenant supplies the deposit to lending',
        };
      return {
        role: 'landlord',
        kind: 'action',
        action: { kind: 'propose_claim', amountAtomic: input.claimAtomic },
        label: 'Landlord proposes the move-out claim',
      };
    case 'claim-proposed':
      return {
        role: 'tenant',
        kind: 'action',
        action: { kind: 'respond_to_claim', accept: !input.dispute },
        label: input.dispute ? 'Tenant disputes the claim' : 'Tenant accepts the claim',
      };
    case 'disputed':
      return {
        role: 'arbitrator',
        kind: 'action',
        action: { kind: 'resolve_claim', amountAtomic: t.claimAtomic },
        label: 'Arbitrator decides the claim',
      };
    case 'settling':
      if (BigInt(t.accountedReceiptsAtomic) > 0n) return redeem('tenant');
      return { role: 'tenant', kind: 'action', action: { kind: 'settle' }, label: 'Tenant completes settlement' };
    case 'closed':
      if (BigInt(t.tenantOwedAtomic) > 0n)
        return { role: 'tenant', kind: 'action', action: { kind: 'payout', landlord: false }, label: 'Pay out the tenant' };
      if (BigInt(t.landlordOwedAtomic) > 0n)
        return { role: 'tenant', kind: 'action', action: { kind: 'payout', landlord: true }, label: 'Pay out the landlord' };
      return { role: null, kind: 'done', label: 'Tenancy closed and paid out' };
    default:
      throw new Error(`Unknown tenancy phase ${String(t.phase)}`);
  }
}
