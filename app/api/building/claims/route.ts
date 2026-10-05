import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareBuildingAction, readBuildingPosition, submitBuildingAction } from '@/server/building-revenue-claims';
import { prepareBuildingReinvest, readBuildingReinvest, startBuildingReinvest, submitBuildingReinvest } from '@/server/building-revenue-reinvest';
import { loadSolanaHouseManifest } from '@/server/solana-house-config';
import { cancelSolanaHouseReview, prepareSolanaHouseAction, readSolanaBuildingPosition, reconcileSolanaHouseAction, solanaHouseId, submitSolanaHouseAction } from '@/server/building-solana';
import { SolanaServiceError } from '@/server/solana-service';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  let readingPosition = false;
  try {
    const identity = await authenticated(request);
    readingPosition = true;
    const query = new URL(request.url).searchParams;
    if (query.get('network') !== 'robinhood' && loadSolanaHouseManifest())
      return Response.json(await readSolanaBuildingPosition(await getStore(), identity, solanaHouseId(query.get('houseId'))), noStore);
    const wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    const store = await getStore();
    return Response.json({ ...await readBuildingPosition(store, wallet.address), reinvest: await readBuildingReinvest(store, identity) }, noStore);
  } catch (error) {
    if (error instanceof SolanaServiceError)
      return Response.json({ error: error.message, code: error.code }, { status: error.status, ...noStore });
    const response = errorResponse(error);
    if (response.status === 503 && readingPosition)
      return Response.json({ error: 'Verified building position or operation recovery is temporarily unavailable. Retry checking the same review; no success or zero balance is inferred.', code: 'building_position_unavailable' }, { status: 503, ...noStore });
    return response;
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request), store = await getStore();
    if (new URL(request.url).searchParams.get('network') !== 'robinhood' && body.network !== 'robinhood' && loadSolanaHouseManifest()) {
      if (body.action === 'prepare')
        return Response.json(await prepareSolanaHouseAction(store, identity, { houseId: body.houseId, operation: body.operation, quantity: body.quantity, cashAtomic: body.cashAtomic, requestId: body.requestId }), noStore);
      if (body.action === 'submit' && typeof body.planId === 'string' && typeof body.signedTransaction === 'string')
        return Response.json(await submitSolanaHouseAction(store, identity, body.planId, body.signedTransaction), noStore);
      if (body.action === 'cancel' && typeof body.planId === 'string')
        return Response.json(await cancelSolanaHouseReview(store, identity, body.planId), noStore);
      if (body.action === 'reconcile' && typeof body.planId === 'string')
        return Response.json(await reconcileSolanaHouseAction(store, identity, body.planId), noStore);
      throw new Error('Unknown Solana house action.');
    }
    const wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    if (body.action === 'reinvest_start') return Response.json({ reinvest: await startBuildingReinvest(store, identity) }, noStore);
    if (body.action === 'reinvest_prepare') return Response.json({ reinvest: await prepareBuildingReinvest(store, identity) }, noStore);
    if (body.action === 'reinvest_submit' && typeof body.stepId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json({ reinvest: await submitBuildingReinvest(store, identity, body.stepId, body.signedTransaction) }, noStore);
    if (body.action === 'prepare' && typeof body.operation === 'string') {
      if (body.quantity !== undefined && typeof body.quantity !== 'string') throw new Error('Quantity must be atomic tHOME text.');
      return Response.json(await prepareBuildingAction(store, wallet.address, wallet.id, body.operation, body.quantity as string | undefined), noStore);
    }
    if (body.action === 'submit' && typeof body.planId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json(await submitBuildingAction(store, wallet.address, body.planId, body.signedTransaction), noStore);
    throw new Error('Unknown building staking action.');
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Building action unavailable.', ...(error instanceof SolanaServiceError ? { code: error.code } : {}) }, { status: error instanceof SolanaServiceError ? error.status : 409, ...noStore }); }
}
