import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { cancelLocalInvestment, prepareLocalInvestment, readLocalInvestments, reconcileLocalInvestment, submitLocalInvestment } from '@/server/local-investments';
import { WorkflowError } from '@/domain/errors';
import { loadSolanaHouseManifest } from '@/server/solana-house-config';
import { cancelSolanaHouseReview, prepareSolanaHouseAction, readSolanaLocalInvestments, reconcileSolanaHouseAction, submitSolanaHouseAction } from '@/server/building-solana';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
function privateError(error: unknown) {
  const response = errorResponse(error);
  response.headers.set('Cache-Control', noStore.headers['Cache-Control']);
  response.headers.set('Vary', noStore.headers.Vary);
  return response;
}

export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const solana = new URL(request.url).searchParams.get('network') !== 'robinhood' && loadSolanaHouseManifest();
    return Response.json({ market: solana ? await readSolanaLocalInvestments(identity) : await readLocalInvestments(store, identity) }, noStore);
  } catch (error) { return privateError(error); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    if (new URL(request.url).searchParams.get('network') !== 'robinhood' && body.network !== 'robinhood' && loadSolanaHouseManifest()) {
      if (body.action === 'prepare')
        return Response.json(await prepareSolanaHouseAction(store, identity, { houseId: body.projectId, operation: body.direction ?? 'buy', requestId: body.requestId, cashAtomic: body.cashAtomic, quantity: body.unitsRaw }), noStore);
      const id = body.planId ?? body.orderId;
      if (typeof id !== 'string') throw new WorkflowError('The reviewed Solana plan ID is required.');
      if (body.action === 'submit' && typeof body.signedTransaction === 'string')
        return Response.json(await submitSolanaHouseAction(store, identity, id, body.signedTransaction), noStore);
      if (body.action === 'reconcile')
        return Response.json(await reconcileSolanaHouseAction(store, identity, id), noStore);
      if (body.action === 'cancel')
        return Response.json(await cancelSolanaHouseReview(store, identity, id), noStore);
      throw new WorkflowError('Unknown Solana investment action.');
    }
    if (body.action === 'prepare')
      return Response.json({ order: await prepareLocalInvestment(store, identity, { requestId: body.requestId, projectId: body.projectId, direction: body.direction, cashAtomic: body.cashAtomic, unitsRaw: body.unitsRaw }) }, noStore);
    if (body.action === 'submit')
      return Response.json({ order: await submitLocalInvestment(store, identity, body.orderId, body.stepId, body.signedTransaction) }, noStore);
    if (body.action === 'reconcile')
      return Response.json({ order: await reconcileLocalInvestment(store, identity, body.orderId) }, noStore);
    if (body.action === 'cancel')
      return Response.json({ order: await cancelLocalInvestment(store, identity, body.orderId) }, noStore);
    throw new WorkflowError('Unknown investment action.');
  } catch (error) {
    return privateError(error);
  }
}
