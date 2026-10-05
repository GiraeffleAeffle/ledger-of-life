import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { solanaSharesConfiguration } from '@/server/solana-shares-config';
import { readSolanaSharesFaucet, prepareSolanaSharesFaucet, submitSolanaSharesFaucet, reconcileSolanaSharesFaucet, cancelSolanaSharesFaucet } from '@/server/shared-market-solana';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request), manifest = await solanaSharesConfiguration();
    if (!manifest) return Response.json({ configured: false, network: 'solana-devnet', activeOperation: null, receipts: [] }, noStore);
    return Response.json(await readSolanaSharesFaucet(await getStore(), identity, { manifest }), noStore);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request), body = await readBody(request), manifest = await solanaSharesConfiguration();
    if (!manifest) throw new Error('The Solana test TSLA faucet is not configured. No tokens were minted.');
    const store = await getStore(), options = { manifest };
    if (body.action === 'prepare') return Response.json(await prepareSolanaSharesFaucet(store, identity, body, options), noStore);
    if (typeof body.id !== 'string') throw new Error('Recover the exact reviewed faucet operation ID.');
    if (body.action === 'submit' && typeof body.signedTransactionBase64 === 'string') return Response.json(await submitSolanaSharesFaucet(store, identity, body.id, body.signedTransactionBase64, options), noStore);
    if (body.action === 'reconcile') return Response.json(await reconcileSolanaSharesFaucet(store, identity, body.id, options), noStore);
    if (body.action === 'cancel') return Response.json(await cancelSolanaSharesFaucet(store, identity, body.id, options), noStore);
    throw new Error('Unknown test TSLA faucet action.');
  } catch (error) { return errorResponse(error); }
}
