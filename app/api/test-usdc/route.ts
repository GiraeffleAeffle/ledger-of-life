import { authenticated } from '@/server/authenticated';
import { walletFor } from '@/server/agreements';
import { errorResponse, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { mintTestUsdc } from '@/server/test-usdc';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const wallet = walletFor(identity, 'solana');
    const result = await mintTestUsdc(await getStore(), identity.subject, wallet.address);
    if (result.status === 'unconfigured')
      return Response.json({ ...result, error: 'This site’s test USDC faucet is not configured. No tokens were minted.' }, { ...noStore, status: 503 });
    return Response.json(result, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
