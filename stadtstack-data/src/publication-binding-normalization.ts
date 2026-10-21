import {canonicalJson,digest} from './district-adapter-contract.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';
import type {PrivatePublicationProvenance} from './district-publication-provenance.ts';

/** Matches unchanged Core's URL identity, not a new source identity rule. */
function endpointIdentity(value:string){
 const url=new URL(value);url.hostname=url.hostname.replace(/\.$/,'');url.hash='';return digest(url.href);
}
/** Representation reduction only. Callers still authenticate every resulting pin
 * through unchanged Core. A family with a different configuration or endpoint
 * set is NEVER interchangeable. All non-registry proofs remain present. */
export function normalizePublicationBindings(input:readonly SourceArtifactBinding[]):SourceArtifactBinding[]{
 const unique=new Map<string,SourceArtifactBinding>(),other:string[]=[],families=new Map<string,{configuration:string;endpoints:Set<string>;bindings:string[]}>();
 for(const binding of input)unique.set(canonicalJson(binding),binding);
 for(const [bindingKey,binding] of unique){
  if(binding.kind!=='operator_registry_config'){other.push(bindingKey);continue;}
  if(binding.independentAllowed!==false)throw Error('Registry family cannot grant independent custody');
  const key=canonicalJson([binding.configurationSha256,binding.schemaContractSha256,binding.code,binding.approval]);
  let family=families.get(key);if(!family){family={configuration:binding.configurationSha256,endpoints:new Set(),bindings:[]};families.set(key,family);}
  family.endpoints.add(endpointIdentity(binding.url));family.bindings.push(bindingKey);
 }
 const equivalent=new Map<string,{key:string;bindings:string[]}>();
 for(const [key,family] of families){
  const identity=canonicalJson([family.configuration,[...family.endpoints].sort()]),old=equivalent.get(identity);
  if(!old||key<old.key)equivalent.set(identity,{key,bindings:family.bindings});
 }
 return [...other,...[...equivalent.values()].flatMap(family=>family.bindings)].sort().map(key=>unique.get(key)!);
}
export function normalizePublicationPin<T extends PrivatePublicationProvenance['inputs'][number]>(pin:T):T{
 return {...pin,bindings:normalizePublicationBindings(pin.bindings)};
}
