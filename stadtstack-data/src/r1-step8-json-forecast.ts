import {STEP8_JSON_LIMIT_BYTES,step8JsonBytes} from './r1-step8-json-budget.ts';
import type {precheckStep8Exports} from './r1-step8-export-precheck.ts';
import {canonicalJson} from './district-adapter-contract.ts';
import type {PrivatePublicationProvenance} from './district-publication-provenance.ts';
type ExportSizes=NonNullable<Awaited<ReturnType<typeof precheckStep8Exports>>['jsonArtifacts']>;
export interface Step8JsonBudget {schemaVersion:'stadtstack-r1-step8-json-budgets-v1';maximumExclusiveBytes:number;artifacts:Array<{path:string;upperBoundBytes:number;basis:string}>}

/** Producer-domain bounds, not a source-count extrapolation. Original immutable
 * assessment bytes are copied once; retained members are copied byte-exactly.
 * Generated publication views reserve sixteen copies of their complete native
 * record inputs for feature/statement/date/quote projections and old/new change
 * sides. Each artifact has its own bound, enforced again before serialization
 * or persistence. An unlisted new writer fails closed until its budget exists. */
export function forecastStep8JsonOutputs(input:{exports:ExportSizes;metadata:unknown;structuredBytes:number;structuredCoverageBytes:number;registryBytes:number;allowanceBytes:number;auditAuxiliaryBytes:number;retainedMaximumBytes:number;priorMaximumBytes:number;primaryProvenanceBytes:number;stagingProvenanceBytes:number;nativeInventories?:Array<{path:string;bytes:number}>;staging?:{campaignBytes:number;primaryBytes:number;retainedBytes:number}}){
 const s=input.exports,MiB=1024*1024,metadata=MiB+16*step8JsonBytes(input.metadata)+2*input.structuredCoverageBytes,native=16*(s.publicationRecordsBytes+input.structuredBytes),quarantine=4*s.publicationQuarantineBytes+16*input.structuredBytes;
 const artifacts:Step8JsonBudget['artifacts']=[],add=(path:string,upperBoundBytes:number,basis:string)=>{if(!Number.isSafeInteger(upperBoundBytes)||upperBoundBytes<0||upperBoundBytes>=STEP8_JSON_LIMIT_BYTES)throw Error(`Step8 JSON pre-pass budget refused: ${path}: ${upperBoundBytes} bytes`);artifacts.push({path,upperBoundBytes,basis});};
 if(input.staging){add('staging/campaign.json',input.staging.campaignBytes,'exact frozen campaign bytes');add('staging/private-publication-provenance.json',input.staging.primaryBytes,'exact committed staging primary inventory with unchanged Core guard');add('staging/staging-publication-provenance.json',input.staging.retainedBytes,'exact retained staging inventory with unchanged Core guard');add('staging/staging-component.json',metadata,'staging input pins and destinations only');}
 add('source-dispositions.json',2*s.sourceDispositionArrayBytes+metadata,'exact shared disposition array; at most double for embedding indentation plus complete control envelope');
 add('audit/current-generation.json',s.sourceAuditPayloadBytes+3*s.assessmentPayloadBytes+input.allowanceBytes+input.auditAuxiliaryBytes+metadata,'exact embedding-depth source audit fields and current allowance accounting; complete selected assessment bytes, purge acknowledgments and bounded pin metadata');
 add('audit/publication-preflight.json',4*metadata,'complete static receipt and budget metadata; no native queue payloads');
 for(const inventory of input.nativeInventories??[])add(inventory.path,inventory.bytes,'exact native inventory after the complete witnessed HTTP-binding union; unchanged 16 MiB guard minus 1 MiB');
 add('audit/native-provenance/*-attestation.json',4*metadata,'selection, witness identities, target hashes and inventory pins only');
 let maximumAssessmentBytes=0;for(const pin of s.assessmentArtifactSizes)maximumAssessmentBytes=Math.max(maximumAssessmentBytes,pin.bytes);
 for(const role of ['item','A','B','C'])add(`audit/*-${role}.json`,maximumAssessmentBytes,'maximum exact immutable assessment artifact bytes');
 add('audit/assessments.json',metadata,'assessment identities and four artifact paths only');
 add('inputs/provenance.json',input.primaryProvenanceBytes,'independent complete producer-binding provenance upper bound');
 add('inputs/staging-provenance.json',input.stagingProvenanceBytes,'exact retained producer-binding inventory bytes');
 add('inputs/text-composition.json',2*s.textCompositionBytes+metadata,'exact selected original composition pins/admissions plus embedding overhead');
 add('inputs/registry.json',2*input.registryBytes+metadata,'original registered configuration plus bounded committed coverage evidence');
 add('inputs/structured-run.json',2*input.structuredBytes+metadata,'complete deduplicated publication records and committed structured coverage; no raw discovery observations');
 for(const name of ['records','identity','policy','critical','publication-inputs'])add(`inputs/${name}.json`,native+metadata,'complete native publication record domains and exact source-control metadata');
 add('inputs/quarantine.json',2*s.publicationQuarantineBytes+metadata,'exact text quarantine with publication timestamp and envelope');
 add('exception-inventory.json',quarantine+metadata,'single pinned source-disposition table; full preparation/native holds and assessment path metadata');
 add('release/release-manifest.json',metadata,'manifest paths, hashes, sizes and release identity only');
 add('release/*',Math.max(input.retainedMaximumBytes,native+2*input.priorMaximumBytes,quarantine)+metadata,'exact retained bytes or new publication views plus both historical revision sides; changes.ts projects hashes/metric claims, never historical geometry or full signal payloads');
 for(const name of ['replay-receipt.json','replay-proof.json','step9-handoff.json'])add(name,4*metadata,'hash/path/size metadata, never predecessor/staging bytes or queue payloads');
 add('release-gate.json',2*s.sourceAuditPayloadBytes+4*metadata,'one source export terminal inventory per source plus pins and finite stage metadata');
 return {schemaVersion:'stadtstack-r1-step8-json-budgets-v1' as const,maximumExclusiveBytes:STEP8_JSON_LIMIT_BYTES,artifacts};
}
export function assertStep8JsonBudget(budget:Step8JsonBudget,name:string,bytes:number){
 if(!/\.(?:json|geojson)$/.test(name))return;
 const matches=(pattern:string)=>{const index=pattern.indexOf('*');return index<0?pattern===name:name.startsWith(pattern.slice(0,index))&&name.endsWith(pattern.slice(index+1));};
 const entry=budget.artifacts.find(row=>row.path===name)??budget.artifacts.find(row=>matches(row.path));
 if(!entry||bytes>entry.upperBoundBytes||bytes>=budget.maximumExclusiveBytes)throw Error(`Step8 JSON artifact outside static pre-pass budget: ${name}: ${bytes} bytes`);
}

/** Read-only prediction of the unchanged Core supplement's inventory wire.
 * This grants no authority: canonical reconstruction and native union proof
 * authentication are still mandatory before any resulting bytes are used. */
export function forecastStep8NativeInventories(sources:Array<{seal:{sha256:string};inventory:PrivatePublicationProvenance}>){
 const shared=new Map<string,PrivatePublicationProvenance['inputs']>();
 for(const source of sources)for(const pin of source.inventory.inputs){const values=shared.get(pin.sha256)??[];values.push(pin);shared.set(pin.sha256,values);}
 const outputs:Array<{path:string;bytes:number}>=[];
 for(const source of sources){let changed=false;
  const inputs=source.inventory.inputs.map(pin=>{
   const bindings=new Map(pin.bindings.map(binding=>[canonicalJson(binding),binding]));
   for(const other of shared.get(pin.sha256)??[]){if(other.path!==pin.path||other.bytes!==pin.bytes)throw Error('Native JSON forecast shared target identity mismatch');for(const binding of other.bindings){const key=canonicalJson(binding);if(bindings.has(key))continue;if(binding.kind!=='http_observation'||binding.independentAllowed!==true)throw Error('Native JSON forecast cannot supplement non-independent HTTP custody');bindings.set(key,binding);}}
   if(bindings.size===pin.bindings.length)return pin;changed=true;return {...pin,bindings:[...bindings].sort(([a],[b])=>a.localeCompare(b)).map(([,binding])=>binding)};
  });
  if(changed){const path=`audit/native-provenance/${source.seal.sha256}-inventory.json`,bytes=step8JsonBytes({...source.inventory,inputs},path,15*1024*1024);outputs.push({path,bytes});}
 }
 return outputs;
}
