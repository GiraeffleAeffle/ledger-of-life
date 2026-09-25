import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { VerifiedIdentity, VerifiedWallet } from '../wallets/identity-policy.ts';
import type { Network, Role } from '../domain/assets.ts';
import { atomic } from '../domain/assets.ts';
import { WorkflowError } from '../domain/workflow.ts';
import { AccessError, ConflictError } from './workspaces.ts';
import type { Store } from './store.ts';
import { recoveryCheckRequired } from './recovery.ts';

export interface Agreement {
  id: string;
  network: Network;
  property: string;
  requiredSecurity: string;
  releaseAllowed: boolean;
  createdAt: string;
  revision: number;
  parties: Partial<Record<Role, { subject: string; wallet: VerifiedWallet }>>;
  invitations: Partial<Record<'tenant' | 'arbitrator', { digest: string; expiresAt: number }>>;
  accepted: Partial<Record<'tenant' | 'landlord', { digest: string; at: string }>>;
  records: { id: string; name: string; body: string; by: string; at: string }[];
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function walletFor(identity: VerifiedIdentity, network: Network) {
  const candidates = identity.wallets.filter(
    (wallet) => wallet.chainType === (network === 'solana' ? 'solana' : 'ethereum'),
  );
  if (candidates.length !== 1)
    throw new AccessError('One verified personal wallet is required for this network.');
  return candidates[0];
}
export function requireReady(identity: VerifiedIdentity) {
  if (identity.passkeyCount < 1 || (!identity.backupLoginLinked && recoveryCheckRequired()))
    throw new AccessError('Add a passkey and backup access before recording a tenancy.');
}
export function agreementRole(value: Agreement, identity: VerifiedIdentity): Role {
  for (const role of ['tenant', 'landlord', 'arbitrator'] as const) {
    const party = value.parties[role];
    if (
      party?.subject === identity.subject &&
      identity.wallets.some(
        (wallet) =>
          wallet.id === party.wallet.id &&
          wallet.address === party.wallet.address &&
          wallet.chainType === party.wallet.chainType,
      )
    )
      return role;
  }
  throw new AccessError('You are not a verified party to this tenancy.');
}
export function agreementDigest(value: Agreement): string | null {
  if (!value.parties.tenant || !value.parties.landlord || !value.parties.arbitrator) return null;
  // Domain separation and canonical field order make exactly what is accepted reproducible.
  return `0x${digest(JSON.stringify({ domain: 'rental-agreement-v1', id: value.id, network: value.network, property: value.property, asset: value.network === 'solana' ? 'USDC' : 'USDG', requiredSecurity: value.requiredSecurity, releaseAllowed: value.releaseAllowed, tenant: value.parties.tenant.wallet.address, landlord: value.parties.landlord.wallet.address, arbitrator: value.parties.arbitrator.wallet.address }))}`;
}
export function publicAgreement(value: Agreement, identity: VerifiedIdentity) {
  const role = agreementRole(value, identity);
  const { invitations: _, ...visible } = value;
  void _;
  return { ...visible, role, digest: agreementDigest(value) };
}
export async function createAgreement(
  store: Store,
  identity: VerifiedIdentity,
  input: { network: Network; property: string; requiredSecurity: string; releaseAllowed: boolean },
) {
  requireReady(identity);
  if (
    !['solana', 'robinhood'].includes(input.network) ||
    typeof input.releaseAllowed !== 'boolean' ||
    typeof input.property !== 'string' ||
    input.property.trim().length < 3 ||
    input.property.length > 120
  )
    throw new WorkflowError('Provide a network, property label and explicit release policy.');
  const amount = atomic(input.requiredSecurity);
  if (amount <= 0n || amount > 10000000000n)
    throw new WorkflowError('The test security amount must be between zero and 10,000 units.');
  const value: Agreement = {
    id: randomUUID(),
    network: input.network,
    property: input.property.trim(),
    requiredSecurity: amount.toString(),
    releaseAllowed: input.releaseAllowed,
    createdAt: new Date().toISOString(),
    revision: 0,
    parties: {
      landlord: { subject: identity.subject, wallet: walletFor(identity, input.network) },
    },
    invitations: {},
    accepted: {},
    records: [],
  };
  await store.create(`agreement:${value.id}`, value);
  return publicAgreement(value, identity);
}
export async function getAgreement(store: Store, id: string, identity: VerifiedIdentity) {
  const value = await store.get<Agreement>(`agreement:${id}`);
  if (!value) throw new AccessError('This tenancy is unavailable.');
  return publicAgreement(value, identity);
}
export async function inviteToAgreement(
  store: Store,
  id: string,
  identity: VerifiedIdentity,
  role: 'tenant' | 'arbitrator',
) {
  if (role !== 'tenant' && role !== 'arbitrator')
    throw new WorkflowError('Invite a tenant or an arbitrator.');
  const token = randomBytes(32).toString('hex');
  await store.update<Agreement>(`agreement:${id}`, (value) => {
    if (agreementRole(value, identity) !== 'landlord')
      throw new AccessError('Only the recorded landlord can create an invitation.');
    if (value.parties[role]) throw new ConflictError('This role is already assigned.');
    return {
      ...value,
      revision: value.revision + 1,
      invitations: {
        ...value.invitations,
        [role]: { digest: digest(token), expiresAt: Date.now() + 86400000 },
      },
    };
  });
  return { id, role, token, expiresInSeconds: 86400 };
}
export async function joinAgreement(
  store: Store,
  id: string,
  identity: VerifiedIdentity,
  role: 'tenant' | 'arbitrator',
  token: string,
) {
  requireReady(identity);
  if (
    (role !== 'tenant' && role !== 'arbitrator') ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new AccessError('The invitation is invalid.');
  const next = await store.update<Agreement>(`agreement:${id}`, (value) => {
    const invite = value.invitations[role];
    if (!invite || invite.expiresAt < Date.now() || invite.digest !== digest(token))
      throw new AccessError('The invitation is invalid, expired or already used.');
    const wallet = walletFor(identity, value.network);
    if (
      value.parties[role] ||
      Object.values(value.parties).some(
        (party) =>
          party.subject === identity.subject ||
          party.wallet.id === wallet.id ||
          party.wallet.address === wallet.address,
      )
    )
      throw new AccessError('Each role needs its own verified person and wallet.');
    const invitations = { ...value.invitations };
    delete invitations[role];
    return {
      ...value,
      revision: value.revision + 1,
      parties: { ...value.parties, [role]: { subject: identity.subject, wallet } },
      invitations,
    };
  });
  return publicAgreement(next, identity);
}
export async function acceptAgreement(
  store: Store,
  id: string,
  identity: VerifiedIdentity,
  expectedDigest: string,
) {
  const next = await store.update<Agreement>(`agreement:${id}`, (value) => {
    const role = agreementRole(value, identity);
    if (role === 'arbitrator') throw new AccessError('The tenant and landlord accept the tenancy.');
    const actual = agreementDigest(value);
    if (!actual || actual !== expectedDigest)
      throw new ConflictError(
        'All parties must join and review the same agreement before acceptance.',
      );
    if (value.accepted[role]?.digest === actual) return value;
    return {
      ...value,
      revision: value.revision + 1,
      accepted: { ...value.accepted, [role]: { digest: actual, at: new Date().toISOString() } },
    };
  });
  return publicAgreement(next, identity);
}

export async function addAgreementRecord(
  store: Store,
  id: string,
  identity: VerifiedIdentity,
  name: string,
  body: string,
) {
  if (
    typeof name !== 'string' ||
    name.trim().length < 3 ||
    name.length > 120 ||
    typeof body !== 'string' ||
    body.trim().length < 12 ||
    body.length > 12000
  )
    throw new WorkflowError('Provide a title and evidence between 12 and 12,000 characters.');
  const next = await store.update<Agreement>(`agreement:${id}`, (value) => {
    agreementRole(value, identity);
    if (value.records.length >= 100)
      throw new WorkflowError('This test tenancy has reached its evidence limit.');
    return {
      ...value,
      revision: value.revision + 1,
      records: [
        ...value.records,
        {
          id: randomUUID(),
          name: name.trim(),
          body: body.trim(),
          by: identity.subject,
          at: new Date().toISOString(),
        },
      ],
    };
  });
  return publicAgreement(next, identity);
}
