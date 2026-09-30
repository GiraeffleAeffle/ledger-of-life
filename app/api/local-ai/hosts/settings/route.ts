import { WorkflowError } from '../../../../../src/domain/errors.ts';
import { authenticated } from '../../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../../src/server/http.ts';
import { parseConnectorBody, readConnectorBody, setConnectorFreePublicAnswers } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = parseConnectorBody(await readConnectorBody(request, 1024));
    if (typeof body.hostId !== 'string' || body.hostId.length > 64 || typeof body.freePublicAnswers !== 'boolean' ||
        Object.keys(body).some((key) => !['hostId', 'freePublicAnswers'].includes(key)))
      throw new WorkflowError('Choose a host and whether it offers free public answers.');
    return Response.json(await setConnectorFreePublicAnswers(await getStore(), identity, body.hostId, body.freePublicAnswers),
      { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
