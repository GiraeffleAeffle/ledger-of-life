import { mapAssetResponse } from '../../../../src/server/map-assets';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (new URL(request.url).search) return new Response('Not found', { status: 404 });
  const { path } = await context.params;
  const url = new URL(request.url);
  // APP_ORIGIN is the public reverse-proxy origin; local smoke servers retain their own port.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return mapAssetResponse('/' + path.join('/'), local ? url.origin : process.env.APP_ORIGIN || url.origin);
}
