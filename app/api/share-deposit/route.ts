import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareShareDeposit, readShareDeposit, readShareListingQuote, submitShareDeposit } from '@/server/share-deposit';
import type { ShareDepositAction } from '@/domain/share-deposit';
import { WorkflowError } from '@/domain/errors';
import { cancelSolanaShareDeposit, prepareSolanaShareDeposit, readSolanaShareDeposit, readSolanaShareListingQuote, submitSolanaShareDeposit } from '@/server/share-deposit-solana';
import { solanaSharesConfiguration } from '@/server/solana-shares-config';
import type { Agreement } from '@/server/agreements';
import type { Listing } from '@/server/listings';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control':'private, no-store', Vary:'Authorization' } };
export async function GET(request:Request) {
  try {
    const identity=await authenticated(request);const query=new URL(request.url).searchParams;const id=query.get('rentalId');const store=await getStore();
    if (query.get('configuration') === '1') {
      const config=await solanaSharesConfiguration();
      return Response.json({solana:config?{network:'solana-devnet',programId:config.programId,mint:config.shareMint,price:config.price}:null},noStore);
    }
    const listingId=query.get('listingId');
    if (listingId) {
      const listing=await store.get<Listing>(`listing:${listingId}`);
      return Response.json(await (listing?.depositForm?.kind==='shares'&&listing.depositForm.network==='solana-devnet'?readSolanaShareListingQuote:readShareListingQuote)(store,identity,listingId),noStore);
    }
    if(!id)throw new WorkflowError('Provide a rentalId.');
    const agreement=await store.get<Agreement>(`agreement:${id}`);
    return Response.json({view:await (agreement?.depositForm?.kind==='shares'&&agreement.depositForm.network==='solana-devnet'?readSolanaShareDeposit:readShareDeposit)(store,identity,id)},noStore);
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request) {
  try {
    sameOrigin(request);const identity=await authenticated(request);const body=await readBody(request);const store=await getStore();
    if(body.action==='prepare'&&typeof body.rentalId==='string'&&typeof body.operation==='string') {
      const agreement=await store.get<Agreement>(`agreement:${body.rentalId}`);
      const prepare=agreement?.depositForm?.kind==='shares'&&agreement.depositForm.network==='solana-devnet'?prepareSolanaShareDeposit:prepareShareDeposit;
      return Response.json({plan:await prepare(store,identity,body.rentalId,body.operation as ShareDepositAction,body)},noStore);
    }
    if(body.action==='submit'&&typeof body.planId==='string') {
      if(body.network==='solana-devnet') return Response.json(await submitSolanaShareDeposit(store,identity,body.planId,typeof body.signedTransactionBase64==='string'?body.signedTransactionBase64:undefined),noStore);
      return Response.json(await submitShareDeposit(store,identity,body.planId,{signed:typeof body.signed==='string'?body.signed:undefined,transactionHash:typeof body.transactionHash==='string'?body.transactionHash:undefined}),noStore);
    }
    if(body.action==='cancel'&&body.network==='solana-devnet'&&typeof body.planId==='string')
      return Response.json(await cancelSolanaShareDeposit(store,identity,body.planId),noStore);
    throw new WorkflowError('Unknown share-deposit request.');
  }catch(error){return errorResponse(error);}
}
