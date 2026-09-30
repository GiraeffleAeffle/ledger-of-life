import { newVisitorToken, revokeVisitor, assertVisitorActive, visitorCookie, visitorToken } from '@/server/local-ai-session';
import { purgeVisitorText } from '@/server/local-ai';
import { getStore } from '@/server/store';
import { errorResponse, sameOrigin } from '@/server/http';
import { AccessError } from '@/server/errors';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const store = await getStore();
    const current = visitorToken(request);
    if (current) {
      try {
        await assertVisitorActive(store, current);
        return Response.json({ sessionReady: true }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
        // The old desk was revoked; issue a new owned session.
      }
    }
    const fresh = newVisitorToken();
    return Response.json({ sessionReady: true }, { headers: {
      'Set-Cookie': visitorCookie(fresh), 'Cache-Control': 'private, no-store', Vary: 'Cookie',
    } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const current = visitorToken(request);
    if (current) {
      const store = await getStore();
      await revokeVisitor(store, current);
      await purgeVisitorText(store, current);
    }
    return Response.json({ cleared: true }, { headers: {
      'Set-Cookie': visitorCookie('', true), 'Cache-Control': 'private, no-store',
    } });
  } catch (error) { return errorResponse(error); }
}
