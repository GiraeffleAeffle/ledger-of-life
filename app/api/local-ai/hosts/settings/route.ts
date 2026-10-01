import { WorkflowError } from '../../../../../src/domain/errors.ts';
import { authenticated } from '../../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../../src/server/http.ts';
import { parseConnectorBody, readConnectorBody, setConnectorFreePublicAnswers, setConnectorPayoutWallet } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = parseConnectorBody(await readConnectorBody(request, 1024));
    if (typeof body.hostId !== 'string' || !body.hostId || body.hostId.length > 64)
      throw new WorkflowError('Choose a host.');
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
    if (typeof body.payoutWallet === 'string' && Object.keys(body).every(key => ['hostId', 'payoutWallet'].includes(key)))
      return Response.json(await setConnectorPayoutWallet(await getStore(), identity, body.hostId, body.payoutWallet), { headers });
    if (typeof body.freePublicAnswers === 'boolean' && Object.keys(body).every(key => ['hostId', 'freePublicAnswers'].includes(key)))
      return Response.json(await setConnectorFreePublicAnswers(await getStore(), identity, body.hostId, body.freePublicAnswers), { headers });
    throw new WorkflowError('Choose either a payout wallet or the free public answer setting.');
  } catch (error) { return errorResponse(error); }
}
