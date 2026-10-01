import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareShareDeposit, readShareDeposit, readShareListingQuote, submitShareDeposit } from '@/server/share-deposit';
import type { ShareDepositAction } from '@/domain/share-deposit';
import { WorkflowError } from '@/domain/errors';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control':'private, no-store', Vary:'Authorization' } };
export async function GET(request:Request) {
  try {
    const identity=await authenticated(request);const query=new URL(request.url).searchParams;const id=query.get('rentalId');
    if (query.get('listingId')) return Response.json(await readShareListingQuote(await getStore(),identity,query.get('listingId')!),noStore);
    if(!id)throw new WorkflowError('Provide a rentalId.');
    return Response.json({view:await readShareDeposit(await getStore(),identity,id)},noStore);
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request) {
  try {
    sameOrigin(request);const identity=await authenticated(request);const body=await readBody(request);const store=await getStore();
    if(body.action==='prepare'&&typeof body.rentalId==='string'&&typeof body.operation==='string')
      return Response.json({plan:await prepareShareDeposit(store,identity,body.rentalId,body.operation as ShareDepositAction,body)},noStore);
    if(body.action==='submit'&&typeof body.planId==='string')
      return Response.json(await submitShareDeposit(store,identity,body.planId,{signed:typeof body.signed==='string'?body.signed:undefined,transactionHash:typeof body.transactionHash==='string'?body.transactionHash:undefined}),noStore);
    throw new WorkflowError('Unknown share-deposit request.');
  }catch(error){return errorResponse(error);}
}
