import { connectionStatus } from '@/server/configuration';
import { getStore } from '@/server/store';
export const runtime = 'nodejs';
export async function GET() {
  let storeAvailable = false;
  try {
    await (await getStore()).get('healthcheck');
    storeAvailable = true;
  } catch {
    /* Configuration state is returned without secrets. */
  }
  // The public app id is compiled into the build (identity.ts reads it the same way); a hosted container does not
  // carry it in its runtime environment, so passing process.env alone would report sign-in as unconfigured.
  const environment = { ...process.env, NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID };
  return Response.json(
    { ...connectionStatus(environment), storeAvailable },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
