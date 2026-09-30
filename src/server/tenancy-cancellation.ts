import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, agreementRole, publicAgreement, requireOpenAgreement, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import type { Listing } from './listings.ts';
import type { SolanaInitialization } from './solana-initialization.ts';
import { solanaServicesFor } from './solana-tenancies.ts';
import type { Store } from './store.ts';

export async function cancellationState(
  store: Store,
  identity: VerifiedIdentity,
  agreement: Agreement,
  resolveServices: typeof solanaServicesFor = solanaServicesFor,
) {
  // An escrow cannot be prepared until every party has joined. No PDA exists without a tenant.
  if (!agreement.parties.tenant) return { phase: null, refusal: null };
  const digest = agreementDigest(agreement);
  const services = await resolveServices(store, agreement.id);
  if (!services) {
    let recorded = Boolean(digest && agreement.accepted.tenant?.digest === digest && agreement.accepted.landlord?.digest === digest);
    let after = '';
    while (!recorded) {
      const records = await store.scan<SolanaInitialization>('solana-initialization:', after, 1000);
      recorded = records.some(({ value }) => value.agreementId === agreement.id);
      if (records.length < 1000) break;
      after = records.at(-1)!.key;
    }
    if (recorded) return { phase: undefined, refusal: 'The escrow state cannot be verified right now. Try again when the deposit service is available.' };
    return { phase: null, refusal: null };
  }
  const setup = await store.get<SolanaInitialization>(services.initialization.recordKey);
  const state = await services.service.cancellationState(identity);
  if (setup && ['signed', 'broadcast', 'unknown'].includes(setup.state))
    return { phase: state.phase, refusal: 'The escrow initialization is still confirming. Wait for its final result before cancelling.' };
  if (state.fundingPending)
    return { phase: state.phase, refusal: 'A deposit funding operation is in flight. Wait for its final result before cancelling.' };
  if (state.phase !== null && state.phase !== 'awaiting-funding')
    return { phase: state.phase, refusal: 'The deposit has been secured. This tenancy cannot be cancelled; use the move-out and settlement steps.' };
  return { phase: state.phase, refusal: null };
}

export async function cancelAgreement(
  store: Store,
  id: string,
  identity: VerifiedIdentity,
  resolveServices: typeof solanaServicesFor = solanaServicesFor,
) {
  const agreement = await store.get<Agreement>(`agreement:${id}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  const role = agreementRole(agreement, identity);
  if (role === 'arbitrator') throw new AccessError('Only the landlord or tenant can cancel this tenancy.');
  requireOpenAgreement(agreement);
  const state = await cancellationState(store, identity, agreement, resolveServices);
  if (state.refusal) throw new ConflictError(state.refusal);
  const at = new Date().toISOString();
  const next = await store.update<Agreement>(`agreement:${id}`, (value) => {
    requireOpenAgreement(value);
    if (value.revision !== agreement.revision)
      throw new ConflictError('The tenancy changed while cancellation was checked. Review it and try again.');
    return {
      ...value,
      revision: value.revision + 1,
      cancelled: { by: role, at },
      records: [...value.records, {
        id: randomUUID(), name: 'Tenancy cancelled',
        body: `Cancelled by the ${role} before the deposit was secured. Nothing was locked.`,
        by: identity.subject, at,
      }],
    };
  });
  let after = '';
  while (true) {
    const listings = await store.scan<Listing>('listing:', after, 1000);
    for (const { key, value } of listings) {
      if (value.agreementId !== id) continue;
      await store.update<Listing>(key, (current) => current.agreementId === id ? { ...current, status: 'closed' } : current);
    }
    if (listings.length < 1000) break;
    after = listings.at(-1)!.key;
  }
  return publicAgreement(next, identity);
}
