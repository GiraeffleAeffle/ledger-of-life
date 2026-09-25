import { authenticated } from '@/server/authenticated';
import { actForTestParties, addTestApplicant, postTestHome, testHelpersEnabled } from '@/server/test-helpers';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store' } };
/** Local test helpers: off unless SOLANA_TEST_SIGNER_MODE=1, local store, devnet and a loopback request. */
export async function GET(request: Request) {
  return Response.json({ enabled: testHelpersEnabled(request) }, noStore);
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (!testHelpersEnabled(request)) return Response.json({ error: 'Test helpers are disabled.' }, { status: 404 });
    const user = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    if (body.action === 'post_home') return Response.json({ listing: await postTestHome(store) }, noStore);
    if (body.action === 'apply' && typeof body.listingId === 'string')
      return Response.json({ listing: await addTestApplicant(store, user, body.listingId) }, noStore);
    if (body.action === 'act')
      return Response.json({
        done: await actForTestParties(store, user, {
          listingId: typeof body.listingId === 'string' ? body.listingId : undefined,
          agreementId: typeof body.agreementId === 'string' ? body.agreementId : undefined,
        }),
      }, noStore);
    return Response.json({ error: 'Unknown helper.' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Helper failed.' }, { status: 409 });
  }
}
