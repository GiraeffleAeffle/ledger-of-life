import { authenticated } from '@/server/authenticated';
import { readCityCoverage } from '@/server/city-signals';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    await authenticated(request);
    return Response.json(await readCityCoverage(), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) {
    return errorResponse(error);
  }
}
