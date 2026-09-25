import { authenticated } from '@/server/authenticated';
import { createListing, listListings } from '@/server/listings';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  try {
    return Response.json({ listings: await listListings(await getStore(), await authenticated(request)) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    return Response.json({ listing: await createListing(await getStore(), identity, await readBody(request, 3_000_000)) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
