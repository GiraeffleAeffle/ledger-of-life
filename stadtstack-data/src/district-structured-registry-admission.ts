import {join} from 'node:path';
import {HashSchema,digest,type AdapterScope} from './district-adapter-contract.ts';
import type {DistrictCas} from './district-cas.ts';
import {assertManagedSourceBindings,type CivicPolicyOptions} from './civic-opt-out.ts';
import {readOperatorRegistryInputPin,type OperatorRegistryInputPin} from './district-registry-config.ts';

export interface StructuredRegistryInput {registry:OperatorRegistryInputPin;registrySha256:string;scope:AdapterScope;districtId:string;supportingSourceIds:readonly string[]}
/** Reauthenticate the original control descriptor and its exact managed configuration, never a bare registry path. */
export async function authenticateStructuredRegistry(cas:DistrictCas,input:StructuredRegistryInput,policy:CivicPolicyOptions={}){
 HashSchema.parse(input.registrySha256);
 const admitted=await readOperatorRegistryInputPin(input.registry,policy);
 if(digest(admitted.bytes)!==input.registrySha256)throw Error('Structured registry bytes differ from admitted configuration');
 const city=admitted.registry.municipalities.find(value=>value.id===input.scope.municipalityId);
 if(!city||city.ags!==input.scope.ags||city.districtId!==input.districtId)throw Error('Structured scope differs from admitted registry');
 for(const id of [input.scope.sourceId,...input.supportingSourceIds])if(!city.sources.some(source=>source.id===id&&source.url!==null))throw Error('Structured source absent from admitted registry');
 const path=join(cas.root,'sha256',input.registrySha256.slice(0,2),input.registrySha256);
 await assertManagedSourceBindings(path,admitted.bindings,policy);
 await cas.verify(input.registrySha256);
 await assertManagedSourceBindings(path,admitted.bindings,policy);
 return admitted;
}
