import {join,resolve} from 'node:path';
import type {SourceArtifactBinding} from './district-private-io.ts';
import {normalizePublicationBindings} from './publication-binding-normalization.ts';
import {partitionPublicationInputs,provenanceBytes,PROVENANCE_LIMIT_BYTES,PROVENANCE_SAFETY_MARGIN_BYTES,type PublicationInputPin} from './publication-provenance-partition.ts';

const MAX_ARTIFACT_BYTES=512*1024*1024;
export function assertStep8ProvenanceSizes(phase:string,primaryBytes:number,stagingBytes:number){
 const maximum=PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES;
 for(const [inventory,bytes] of Object.entries({primary:primaryBytes,staging:stagingBytes}))if(!Number.isSafeInteger(bytes)||bytes<0||bytes>=maximum)throw Error(`${phase} ${inventory} provenance ${bytes} bytes reaches unchanged Core limit minus required ${PROVENANCE_SAFETY_MARGIN_BYTES}-byte safety margin (${maximum})`);
 return {primaryBytes,stagingBytes,coreLimitBytes:PROVENANCE_LIMIT_BYTES,safetyMarginBytes:PROVENANCE_SAFETY_MARGIN_BYTES};
}
/** Exact fixed-input wire lengths plus a conservative bound for all nine generated
 * rows. Hashes always occupy 64 ASCII characters; the existing private input
 * codec bounds artifact lengths at 512 MiB. Producer sets and output paths are
 * known before reconstruction. These sizing rows are never issued or persisted
 * as input pins and confer no Core authorization. */
export function step8PublicationProvenanceBounds(input:{fixedInputs:readonly PublicationInputPin[];stagingPaths:readonly string[];outputRoot:string;textBindings:readonly SourceArtifactBinding[];nativeBindings:readonly SourceArtifactBinding[];registryBindings:readonly SourceArtifactBinding[];identityBindings?:readonly SourceArtifactBinding[];criticalBindings?:readonly SourceArtifactBinding[]}){
 const derived=(...groups:readonly (readonly SourceArtifactBinding[])[])=>normalizePublicationBindings(groups.flatMap(group=>group.map(binding=>({...binding,independentAllowed:false}))));
 const text=derived(input.textBindings),native=derived(input.nativeBindings),knowledge=derived(text,native,input.identityBindings??[],input.criticalBindings??[]);
 const producers=new Map([
  ['registry.json',derived(native,input.registryBindings)],['structured-run.json',native],
  ['text-composition.json',text],['records.json',text],['quarantine.json',text],['identity.json',text],
  ['policy.json',knowledge],['critical.json',derived(text,input.criticalBindings??[])],['publication-inputs.json',knowledge],
 ]);
 const generated=[...producers].map(([name,bindings])=>({path:join(resolve(input.outputRoot),'inputs',name),sha256:'f'.repeat(64),bytes:MAX_ARTIFACT_BYTES,bindings}));
 const partition=partitionPublicationInputs([...input.fixedInputs,...generated],input.stagingPaths),primaryUpperBoundBytes=provenanceBytes(partition.primary).length,stagingExactBytes=provenanceBytes(partition.staging).length;
 return {schemaVersion:'stadtstack-r1-step8-publication-size-bound-v1',primaryUpperBoundBytes,stagingExactBytes,coreLimitBytes:PROVENANCE_LIMIT_BYTES,safetyMarginBytes:PROVENANCE_SAFETY_MARGIN_BYTES,maximumExclusiveBytes:PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES,pass:primaryUpperBoundBytes<PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES&&stagingExactBytes<PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES,fixedInputs:input.fixedInputs.length,generatedInputs:generated.map(pin=>({path:pin.path,maximumArtifactBytes:pin.bytes,producerBindings:pin.bindings.length,upperBoundWireBytes:Buffer.byteLength(JSON.stringify(pin))})),basis:'exact current fixed metadata and producer identities; generated SHA256 wire width and existing 512 MiB artifact cap; no source-count scaling, no authority or publication capability'};
}
