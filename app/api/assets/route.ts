import { authenticated } from '@/server/authenticated';
import { readAdapterConfig, readSolar, readValidator, saveAdapterConfig, type AdapterConfig } from '@/server/adapters';
import { earnOnRobinhood, prepareRobinhoodBuy, robinhoodEnabled, robinhoodHoldings, submitRobinhoodTransaction } from '@/server/robinhood-demo';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
const settle = <T,>(work: Promise<T>) => work.then((value) => ({ ok: true as const, value })).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Unavailable' }));

/** Everything the person owns beyond the rental escrow: Robinhood testnet holdings and adapters. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const evm = identity.wallets.find((w) => w.chainType === 'ethereum');
    const config = (await store.get<AdapterConfig>(`adapters:${identity.subject}`)) ?? {};
    const [robinhood, solar, validator] = await Promise.all([
      evm && (await robinhoodEnabled()) ? settle(robinhoodHoldings(evm.address)) : Promise.resolve(null),
      config.homeAssistant ? settle(readSolar(config.homeAssistant)) : Promise.resolve(null),
      config.validator ? settle(readValidator(config.validator)) : Promise.resolve(null),
    ]);
    return Response.json({ robinhood, solar, validator, adapters: await readAdapterConfig(store, identity) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    const evm = identity.wallets.find((w) => w.chainType === 'ethereum');
    if (body.action === 'save_adapter') return Response.json({ adapters: await saveAdapterConfig(store, identity, body) }, noStore);
    if (!evm) throw new Error('Your account has no Robinhood Chain wallet yet.');
    if (body.action === 'robinhood_earn') {
      if (!(await robinhoodEnabled()) || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname))
        throw new Error('The Robinhood testnet demo runs locally only.');
      return Response.json({ result: await earnOnRobinhood(evm.address) }, noStore);
    }
    if (body.action === 'robinhood_prepare_buy') return Response.json({ walletId: evm.id, steps: await prepareRobinhoodBuy(evm.address) }, noStore);
    if (body.action === 'robinhood_submit' && typeof body.signed === 'string') return Response.json(await submitRobinhoodTransaction(body.signed), noStore);
    throw new Error('Unknown action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
