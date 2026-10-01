import { connectionStatus } from '@/server/configuration';
import { readPriceJob, shapePriceJob } from '@/server/price-job-health';
import { getStore } from '@/server/store';
export const runtime = 'nodejs';
export async function GET() {
  let storeAvailable = false;
  let priceJob = null;
  try {
    const store = await getStore();
    await store.get('healthcheck');
    storeAvailable = true;
    priceJob = shapePriceJob(await readPriceJob(store), Math.floor(Date.now() / 1000));
  } catch {
    /* Configuration state is returned without secrets. */
  }
  // The public app id is compiled into the build (identity.ts reads it the same way); a hosted container does not
  // carry it in its runtime environment, so passing process.env alone would report sign-in as unconfigured.
  const environment = { ...process.env, NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID };
  // `market.priceJob` is null only when the store cannot be read; a job that never ran reports health "attention".
  return Response.json(
    { ...connectionStatus(environment), storeAvailable, market: { priceJob } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
