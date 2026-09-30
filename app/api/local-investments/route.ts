import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { cancelLocalInvestment, prepareLocalInvestment, readLocalInvestments, reconcileLocalInvestment, submitLocalInvestment } from '@/server/local-investments';
import { WorkflowError } from '@/domain/errors';

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
    return Response.json({ market: await readLocalInvestments(store, identity) }, noStore);
  } catch (error) { return privateError(error); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    if (body.action === 'prepare')
      return Response.json({ order: await prepareLocalInvestment(store, identity, { requestId: body.requestId, projectId: body.projectId, cashAtomic: body.cashAtomic }) }, noStore);
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
