import { authenticated } from '@/server/authenticated';
import { homeAssistantPullAllowed, readAdapterConfig, saveAdapterConfig } from '@/server/adapters';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';

export const runtime = 'nodejs';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

function privateError(error: unknown) {
  const response = errorResponse(error);
  response.headers.set('Cache-Control', privateHeaders['Cache-Control']);
  response.headers.set('Vary', privateHeaders.Vary);
  return response;
}

/** Configuration only: no provider or chain reads take place here. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const adapters = await readAdapterConfig(await getStore(), identity);
    return Response.json({ adapters, homeAssistantPull: homeAssistantPullAllowed() }, { headers: privateHeaders });
  } catch (error) {
    return privateError(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const adapters = await saveAdapterConfig(await getStore(), identity, body);
    return Response.json({ adapters }, { headers: privateHeaders });
  } catch (error) {
    return privateError(error);
  }
}
