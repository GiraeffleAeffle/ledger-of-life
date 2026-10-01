import { getStore } from '@/server/store';
import { readBuildingView } from '@/server/building-revenue';
export const runtime='nodejs';
export async function GET() {
  try{return Response.json({building:await readBuildingView(await getStore())},{headers:{'Cache-Control':'no-store'}});}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Building view unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
