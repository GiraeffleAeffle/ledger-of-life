import { getStore } from '@/server/store';
import { requireJobSecret, errorResponse } from '@/server/http';
import { WorkflowError } from '@/domain/errors';
import { createPublicClient, http } from 'viem';
import { loadRobinhoodConfig, reconcileRobinhoodOperations } from '@/server/robinhood-service';
import { reconcileSolanaOperations } from '@/server/solana-service';
import { sweepAiText } from '@/server/local-ai';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    requireJobSecret(request);
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const after = url.searchParams.get('after') || '';
    if (after.length > 160) throw new Error('Invalid cursor.');
    if (!scope || !['robinhood', 'solana', 'local-ai'].includes(scope))
      throw new WorkflowError('Unknown reconciliation scope.');
    if (scope === 'local-ai') {
      const { scrubbed, next } = await sweepAiText(await getStore(), after);
      return Response.json({ scope, status: 'checked', scrubbed, nextCursor: next }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (scope === 'robinhood') {
      if (
        !process.env.ROBINHOOD_RPC_URL ||
        !process.env.ROBINHOOD_ESCROW_ADDRESS ||
        !process.env.ROBINHOOD_ESCROW_CODE_HASH
      )
        return Response.json({ scope, status: 'unconfigured', nextCursor: null });
      const config = loadRobinhoodConfig();
      const result = await reconcileRobinhoodOperations(
        await getStore(),
        createPublicClient({
          transport: http(config.manifest.rpcUrl, { timeout: 15000, retryCount: 0 }),
        }),
        config,
        after,
      );
      return Response.json(
        { scope, status: 'checked', ...result },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const result = await reconcileSolanaOperations(await getStore(), after);
    return Response.json(
      {
        scope,
        status: result.available ? 'checked' : 'unconfigured',
        ...result,
        nextCursor: result.next,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
