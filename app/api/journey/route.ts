import { authenticated } from '@/server/authenticated';
import { myTenancies, tenancyJourney } from '@/server/journey';
import { ensurePayoutAccounts, solanaServicesFor } from '@/server/solana-tenancies';
import { SolanaServiceError } from '@/server/solana-service';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import type { Agreement } from '@/server/agreements';
import { RecoveryError } from '@/server/recovery';
function failure(error: unknown) {
  if (error instanceof SolanaServiceError || error instanceof RecoveryError)
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  return errorResponse(error);
}
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const tenancies = [];
    for (const agreement of await myTenancies(store, identity)) {
      try {
        tenancies.push(await tenancyJourney(store, identity, agreement));
      } catch (error) {
        tenancies.push({
          agreementId: agreement.id,
          property: agreement.property,
          // Usually a busy public RPC; the page keeps retrying.
          unavailable:
            error instanceof Error && error.message === 'RPC unavailable'
              ? 'The test network is busy. Retrying automatically…'
              : error instanceof Error ? error.message : 'This tenancy could not be read.',
        });
      }
    }
    return Response.json({ tenancies }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
/** `advance` performs sponsor-side work that needs no wallet: payout accounts before setup, payouts after settlement. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    if (body.action !== 'advance' || typeof body.agreementId !== 'string')
      throw new SolanaServiceError(400, 'invalid_action', 'Choose a tenancy to advance.');
    const store = await getStore();
    const agreement = await store.get<Agreement>(`agreement:${body.agreementId}`);
    if (!agreement) throw new SolanaServiceError(404, 'agreement_unavailable', 'This tenancy is unavailable.');
    const before = await tenancyJourney(store, identity, agreement);
    let payout = null;
    if (before.next.kind === 'create_space') await ensurePayoutAccounts(store, agreement.id);
    if (before.next.kind === 'paying_out') {
      const services = await solanaServicesFor(store, agreement.id);
      if (!services) throw new SolanaServiceError(503, 'solana_unavailable', 'The deposit service is not configured.');
      payout = await services.service.payout(identity);
    }
    return Response.json({ payout, journey: await tenancyJourney(store, identity, agreement) }, noStore);
  } catch (error) {
    return failure(error);
  }
}
