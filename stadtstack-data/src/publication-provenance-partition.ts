import {readFile,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {canonicalJson,digest} from './district-adapter-contract.ts';
import {authenticatePublicationProvenance,privatePublicationProvenanceSchema,type PrivatePublicationProvenance,type AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import {normalizePublicationBindings,normalizePublicationPin} from './publication-binding-normalization.ts';

export type PublicationPin={path:string;sha256:string};
export type PublicationInputPin=PrivatePublicationProvenance['inputs'][number];
export const PROVENANCE_LIMIT_BYTES=16*1024*1024;
export const PROVENANCE_SAFETY_MARGIN_BYTES=1024*1024;
export function provenanceBytes(inputs:readonly PublicationInputPin[]){return Buffer.from(canonicalJson(privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs})));}
export function publicationPartitionSha256(primary:PublicationPin,staging:PublicationPin){return digest(canonicalJson({primary:{path:resolve(primary.path),sha256:primary.sha256},staging:{path:resolve(staging.path),sha256:staging.sha256}}));}
/** Refuse duplicates, omissions, conflicting bytes and unrequested inputs. */
export function assertPublicationPartition(primary:readonly PublicationInputPin[],staging:readonly PublicationInputPin[],required:readonly PublicationPin[]){
 const actual=new Map<string,PublicationInputPin>();
 for(const pin of [...primary,...staging]){const path=resolve(pin.path);if(actual.has(path))throw Error('Publication input occurs in both inventories or twice: '+path);actual.set(path,pin);}
 const expected=new Map<string,string>();
 for(const pin of required){const path=resolve(pin.path),old=expected.get(path);if(old&&old!==pin.sha256)throw Error('Conflicting required publication input');expected.set(path,pin.sha256);}
 for(const [path,sha256] of expected)if(actual.get(path)?.sha256!==sha256)throw Error('Publication input missing from both inventories or hash differs: '+path);
 for(const path of actual.keys())if(!expected.has(path))throw Error('Unrequested publication input in provenance partition: '+path);
}
export function partitionPublicationInputs(inputs:readonly PublicationInputPin[],stagingPaths:readonly string[]){
 const stage=new Set(stagingPaths.map(path=>resolve(path))),primary:PublicationInputPin[]=[],staging:PublicationInputPin[]=[];
 for(const raw of inputs){const pin=normalizePublicationPin({...raw,path:resolve(raw.path)});(stage.has(pin.path)?staging:primary).push(pin);}
 assertPublicationPartition(primary,staging,inputs);
 for(const path of stage)if(!staging.some(pin=>pin.path===path))throw Error('Staging input absent from publication partition: '+path);
 return {primary,staging};
}
export interface AuthenticatedPublicationPartition {
 readonly primary:AuthenticatedPublicationProvenance;
 readonly staging:AuthenticatedPublicationProvenance;
 readonly primaryInputs:PublicationInputPin[];
 readonly stagingInputs:PublicationInputPin[];
 readonly inputs:PublicationInputPin[];
 readonly bindings:AuthenticatedPublicationProvenance['bindings'];
 read(path:string):Promise<Buffer>;
 assertCoverage(required:readonly PublicationPin[]):void;
}
/** Each opaque capability comes from the UNCHANGED Core reader. This routing
 * object is not passed off as a Core capability or used to bypass its guard. */
export async function authenticatePublicationPartition(primaryPin:PublicationPin,stagingPin:PublicationPin,policy:CivicPolicyOptions={}):Promise<AuthenticatedPublicationPartition>{
 const primary=await authenticatePublicationProvenance(primaryPin.path,primaryPin.sha256,policy),staging=await authenticatePublicationProvenance(stagingPin.path,stagingPin.sha256,policy);
 const decode=async(pin:PublicationPin)=>{
  const bytes=await readFile(pin.path);if(digest(bytes)!==pin.sha256)throw Error('Publication inventory pin changed');
  const inventory=privatePublicationProvenanceSchema.parse(JSON.parse(bytes.toString('utf8'))),result:PublicationInputPin[]=[];
  for(const input of inventory.inputs){const path=resolve(dirname(resolve(pin.path)),input.path);if(await realpath(path)!==path)throw Error('Publication input alias rejected');result.push({...input,path});}
  return result;
 };
 const primaryInputs=await decode(primaryPin),stagingInputs=await decode(stagingPin),inputs=[...primaryInputs,...stagingInputs];
 assertPublicationPartition(primaryInputs,stagingInputs,inputs);
 const byPath=new Map(inputs.map(pin=>[pin.path,pin])),primaryPaths=new Set(primaryInputs.map(pin=>pin.path));
 return Object.freeze({primary,staging,primaryInputs,stagingInputs,inputs,bindings:normalizePublicationBindings([...primary.bindings,...staging.bindings]),
  async read(input:string){const path=resolve(input),pin=byPath.get(path);if(!pin)throw Error('Publication input missing from both inventories: '+path);const bytes=await(primaryPaths.has(path)?primary:staging).read(path);if(digest(bytes)!==pin.sha256||bytes.length!==pin.bytes)throw Error('Publication partition input changed');return bytes;},
  assertCoverage(required:readonly PublicationPin[]){assertPublicationPartition(primaryInputs,stagingInputs,required);},
 });
}
