import { authenticated } from '@/server/authenticated';
import { homeAssistantPullAllowed, readAdapterConfig, readSolar, readValidator, type AdapterConfig } from '@/server/adapters';
import { robinhoodHoldings } from '@/server/robinhood-demo';
import { ReferencePriceUnavailable } from '@/server/reference-price';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareTestDollars, submitTestDollars } from '@/server/test-dollars';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
const settle = <T,>(work: Promise<T>) => work.then((value) => ({ ok: true as const, value })).catch((e: unknown) => ({
  ok: false as const, error: e instanceof Error ? e.message : 'Unavailable',
  ...(e instanceof ReferencePriceUnavailable ? { code: 'price_unavailable' as const } : {}),
}));
async function settleRobinhood(owner: string) {
  const result = await settle(robinhoodHoldings(owner));
  if (result.ok && 'status' in result.value)
    return { ok: false as const, code: 'price_unavailable' as const, error: new ReferencePriceUnavailable().message, value: result.value };
  return result;
}

/** Holdings plus adapter readings. area=holdings skips the optional device reads (Home solar, Validator) so the subtotal never waits on them; area=devices reads only those. */
export async function GET(request: Request) {
  let identity;
  try {
    identity = await authenticated(request);
  } catch (error) {
    return errorResponse(error);
  }
  try {
    const area = new URL(request.url).searchParams.get('area');
    const devicesOnly = area === 'devices';
    const holdingsOnly = area === 'holdings';
    const store = await getStore();
    const evm = identity.wallets.find((w) => w.chainType === 'ethereum');
    const config = (await store.get<AdapterConfig>(`adapters:${identity.subject}`)) ?? {};
    const [robinhood, solar, validator] = await Promise.all([
      !devicesOnly && evm ? settleRobinhood(evm.address) : Promise.resolve(null),
      !holdingsOnly && config.homeAssistant ? settle(readSolar(config.homeAssistant)) : Promise.resolve(null),
      !holdingsOnly && config.validator ? settle(readValidator(config.validator)) : Promise.resolve(null),
    ]);
    return Response.json({ robinhood, solar, validator, adapters: await readAdapterConfig(store, identity), homeAssistantPull: homeAssistantPullAllowed() }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: 503, ...noStore });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    const evm = identity.wallets.find((w) => w.chainType === 'ethereum');
    if (!evm) throw new Error('Your account has no Robinhood Chain wallet yet.');
    if (body.action === 'test_dollars_prepare')
      return Response.json({ walletId: evm.id, ...await prepareTestDollars(store, evm.address) }, noStore);
    if (body.action === 'test_dollars_submit') {
      if (typeof body.signed !== 'string') throw new Error('Invalid signed test transaction.');
      return Response.json(await submitTestDollars(store, evm.address, body.signed), noStore);
    }
    throw new Error('Unknown action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
