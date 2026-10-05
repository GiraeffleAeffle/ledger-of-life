import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareRent, readRent, submitRent } from '@/server/rent-payments';
import { AccessError } from '@/server/errors';
import { WorkflowError } from '@/domain/errors';
import { SolanaServiceError } from '@/server/solana-service';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Origin' } };
function failure(error: unknown) {
  const response = error instanceof SolanaServiceError ? Response.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Authorization, Origin');
  return response;
}
export async function GET(request: Request) {
  try {
    if (request.headers.has('origin')) sameOrigin(request);
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new AccessError('Read rent from the application only.');
    const identity = await authenticated(request);
    const id = new URL(request.url).searchParams.get('agreement');
    if (!id) throw new WorkflowError('Choose the tenancy.');
    return Response.json({ rent: await readRent(await getStore(), identity, id) }, noStore);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request), body = await readBody(request), store = await getStore();
    if (typeof body.agreementId !== 'string') throw new WorkflowError('Choose the tenancy.');
    if (body.action === 'prepare') return Response.json({ rent: await prepareRent(store, identity, body.agreementId) }, noStore);
    if (body.action === 'reconcile') return Response.json({ rent: await readRent(store, identity, body.agreementId) }, noStore);
    if (body.action === 'submit' && typeof body.stepId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json({ rent: await submitRent(store, identity, body.agreementId, body.stepId, body.signedTransaction) }, noStore);
    throw new WorkflowError('Choose a valid rent action.');
  } catch (error) { return failure(error); }
}
