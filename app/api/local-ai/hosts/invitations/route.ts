import { authenticated } from '../../../../../src/server/authenticated.ts';
import { WorkflowError } from '../../../../../src/domain/errors.ts';
import { errorResponse, sameOrigin } from '../../../../../src/server/http.ts';
import { createHostInvitation, parseConnectorBody, readConnectorBody } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const raw = await readConnectorBody(request, 2048);
    const body = parseConnectorBody(raw);
    if (!['own', 'building'].includes(body.payoutTarget as string) || Object.keys(body).some(key => key !== 'payoutTarget'))
      throw new WorkflowError('Choose your wallet or the building for GPU income.');
    const invitation = await createHostInvitation(await getStore(), identity, body);
    return Response.json(invitation, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
