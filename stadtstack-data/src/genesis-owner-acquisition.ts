import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,basename,dirname} from 'node:path';
import {assertManagedSourceReadable,assertManagedSourceBindings,type CivicPolicyOptions} from './civic-opt-out.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding,type HttpObservationProof} from './district-http-observation.ts';
import {assertSubscriptionSourcePolicy} from './district-schema.ts';
import {hash} from './common.ts';
import type {FetchedDocument} from './polite-fetch.ts';
import {semanticHash} from './district-adapter-contract.ts';

/** Fixed sibling artifacts lane; never append new policy codecs to legacy fetch roots. */
export function genesisOwnerAccountRoot(rawRoot:string):string {return resolve(rawRoot)+'-genesis-owner-account';}
/** Exact successful source admission, not custody-only access to denial metadata. */
export async function readGenesisOwnerRepresentation(rawRoot:string,document:FetchedDocument,policy:CivicPolicyOptions={},maxBytes=64*1024*1024):Promise<{bytes:Buffer;httpObservation:HttpObservationProof}> {
 const root=genesisOwnerAccountRoot(rawRoot),bodyPath=join(root,'sha256',document.sha256.slice(0,2),document.sha256),observationPath=document.observationPath;
 if(document.policy?.access!=='authenticated_owner_account'||resolve(document.localPath)!==bodyPath||dirname(observationPath)!==join(root,'observations')||await realpath(root)!==root)throw Error('Owner account source lane mismatch');
 const marker=JSON.parse(await readFile(join(root,'.civic-acquisition-lane.json'),'utf8'));
 if(marker.kind!=='artifacts')throw Error('Owner account source lane role mismatch');
 for(const path of [bodyPath,observationPath]){
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(path===bodyPath?maxBytes:1024*1024))throw Error('Owner account artifact bounds rejected');
  await assertManagedSourceReadable(path,{...policy,sourceUrl:document.url});
 }
 const observationBytes=await readFile(observationPath),httpObservation=HttpObservationProofSchema.parse({observationId:basename(observationPath),receiptSha256:hash(observationBytes),bytes:observationBytes.toString('utf8')});
 const binding=authenticatedHttpBinding(httpObservation,{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,fetchedAt:document.checkedAt});
 await assertManagedSourceBindings(bodyPath,[{...binding,independentAllowed:true}],policy);
 await assertManagedSourceBindings(observationPath,[binding],policy);
 const observed=JSON.parse(httpObservation.bytes),sourcePolicy=assertSubscriptionSourcePolicy(observed.policy,document);
 if(sourcePolicy.access!=='authenticated_owner_account'||semanticHash(sourcePolicy)!==semanticHash(document.policy))throw Error('Owner account observed policy mismatch');
 const bytes=await readFile(bodyPath);
 if(bytes.length>maxBytes||bytes.length!==observed.bytes||hash(bytes)!==document.sha256)throw Error('Owner account source bytes mismatch');
 await assertManagedSourceReadable(bodyPath,{...policy,sourceUrl:document.url});
 return {bytes,httpObservation};
}
