import { getStore } from '@/server/store';
import { readBuildingView } from '@/server/building-revenue';
import { loadSolanaHouseManifest } from '@/server/solana-house-config';
import { readSolanaBuilding, solanaHouseId } from '@/server/building-solana';
export const runtime='nodejs';
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const building = query.get('network') !== 'robinhood' && loadSolanaHouseManifest()
      ? await readSolanaBuilding(solanaHouseId(query.get('houseId')))
      : await readBuildingView(await getStore());
    return Response.json({ building }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Building view unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
