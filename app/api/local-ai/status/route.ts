import { authenticated } from '@/server/authenticated';
import { errorResponse } from '@/server/http';
import { getStore } from '@/server/store';
import { libraryOwner, paidOwner, type AiOwner } from '@/server/local-ai';
import { localAiStatus } from '@/server/local-ai-operations';
import { assertVisitorActive, visitorToken } from '@/server/local-ai-session';
import { AccessError } from '@/server/errors';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const store = await getStore();
    let owner: AiOwner | undefined = request.headers.has('authorization') ? paidOwner(await authenticated(request)) : undefined;
    const visitor = visitorToken(request);
    if (!owner && visitor) {
      try { await assertVisitorActive(store, visitor); owner = libraryOwner(visitor); }
      catch (error) { if (!(error instanceof AccessError)) throw error; }
    }
    return Response.json({ service: await localAiStatus(store, owner) },
      { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' } });
  } catch (error) { return errorResponse(error); }
}
