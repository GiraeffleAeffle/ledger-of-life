import {readFile,lstat,realpath,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {z} from 'zod';
import type {Pool} from 'pg';
import {cacheDir} from './common.ts';
import {digest,canonicalJson,HashSchema} from './district-adapter-contract.ts';
import {dataReleaseId,dataReleaseSchema} from './data-release.ts';
import {readCommittedReleaseFile,loadPriorPublicationRelease} from './district-publication-predecessor.ts';
import {RETAINED_PUBLICATION_ROOT,RetainedPublicationImportPlanSchema,retainedPublicationSources,readAuthenticatedRetainedPublicationMember} from './district-retained-import.ts';
import {assertCivicPolicyAuthority,assertManagedSourceBindings,readCivicPolicyInventory,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import {readPinnedJson,writeManagedSourceArtifact,type SourceArtifactBinding} from './district-private-io.ts';
import {authenticatePublicationProvenance,privatePublicationProvenanceSchema,type PrivatePublicationProvenance} from './district-publication-provenance.ts';
import {authenticateStep8Campaign,reserveStep8Generation} from './r1-step8-governance.ts';
import {STEP8_PRIOR_RELEASE} from './r1-step8-current-policy.ts';
import {requiredReplayStaging} from './replay-pipeline.ts';
import {NativeProvenancePinSchema,ProvenanceSupplementSelectionSchema,ReconstructionWorkersSchema,ReconstructionTimingSchema,createWitnessedProvenanceContext,authenticateCanonicalSealProvenance,canonicalOutputForProvenance,assertCanonicalEpochFinished,assertCanonicalContextInputs,type WitnessedProvenanceContext} from './r1-step8-provenance.ts';

const Pin=z.object({path:z.string().refine(isAbsolute,'Absolute input path required'),sha256:HashSchema}).strict();
const Policy=z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string().min(1),authoritySha256:HashSchema}).strict();
export const Step8StagingAssemblySchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-staging-assembly-v1'),
 retainedPlan:Pin,provenances:z.array(Pin).min(1),campaign:Pin,registry:Pin,
 nativeSealSelection:NativeProvenancePinSchema.optional(),nativeSealCatalogue:NativeProvenancePinSchema.optional(),nativeCasRoot:z.string().refine(isAbsolute).optional(),reconstructionWorkers:ReconstructionWorkersSchema,reconstructionTiming:ReconstructionTimingSchema,importDispositionDecision:NativeProvenancePinSchema.optional(),
 provenanceSupplements:z.array(z.object({nativeOutput:NativeProvenancePinSchema,nativeProvenance:NativeProvenancePinSchema,supplement:ProvenanceSupplementSelectionSchema}).strict()).optional(),
 identityAssessments:Pin.optional(),criticalAssessments:Pin.optional(),regionalPolicyReceipts:Pin.optional(),
 managedRoot:z.string().refine(isAbsolute),policy:Policy,
}).strict();
type InventoryPin=PrivatePublicationProvenance['inputs'][number];
const encoded=(value:unknown)=>Buffer.from(canonicalJson(value));
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const uniqueBindings=(bindings:SourceArtifactBinding[])=>[...new Map(bindings.map(binding=>[canonicalJson(binding),binding])).values()];

async function assertStagingRootsDisjoint(output:string,policy:CivicPolicyOptions){
 const inventory=await readCivicPolicyInventory(policy);
 const contains=(parent:string,child:string)=>{const path=relative(parent,child);return !path||path!=='..'&&!path.startsWith('../')&&!isAbsolute(path);};
 for(const candidate of [output,output+'.claim'])for(const root of inventory.roots)if(contains(root.path,candidate)||contains(candidate,root.path))throw Error('Staging control root or claim overlaps enrolled managed root');
}
/** No policy reader, inventory lock, DB, managed writes, or source acquisition. */
export async function buildStep8RetainedPlan(publicationRoot:string,managedRoot=RETAINED_PUBLICATION_ROOT){
 if(!isAbsolute(publicationRoot)||!isAbsolute(managedRoot))throw Error('Absolute retained roots required');
 const sourceRoot=await realpath(publicationRoot);
 if(sourceRoot!==resolve(publicationRoot)||(await lstat(publicationRoot)).isSymbolicLink())throw Error('Retained publication alias rejected');
 const manifestBytes=await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,'release-manifest.json',undefined,'release');
 if(digest(manifestBytes)!==STEP8_PRIOR_RELEASE.manifestSha256)throw Error('Authentic 0.3.2 manifest pin mismatch');
 const manifest=dataReleaseSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
 if(manifest.id!==STEP8_PRIOR_RELEASE.releaseId||dataReleaseId(manifest.files)!==manifest.id||new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length)throw Error('Authentic 0.3.2 release identity mismatch');
 if(!(await readFile(join(sourceRoot,'release-manifest.json'))).equals(manifestBytes))throw Error('Retained directory differs from authentic 0.3.2 Git manifest');
 const catalogue=await loadPriorPublicationRelease(STEP8_PRIOR_RELEASE,['catalogue.json'],'9999-12-31T23:59:59.999Z');
 const cities=z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/)}).passthrough()).parse(JSON.parse(catalogue.files.get('catalogue.json')!.toString('utf8')).cities).map(city=>city.id);
 if(new Set(cities).size!==cities.length)throw Error('Duplicate retained catalogue city');
 const paths=requiredReplayStaging(cities),prior=await loadPriorPublicationRelease(STEP8_PRIOR_RELEASE,paths,'9999-12-31T23:59:59.999Z');
 const imports=[];
 for(const memberPath of paths){
  const bytes=prior.files.get(memberPath)!;
  if(!(await readFile(join(sourceRoot,memberPath))).equals(bytes))throw Error('Retained directory member differs from authentic Git bytes: '+memberPath);
  const declaredSources=retainedPublicationSources(JSON.parse(bytes.toString('utf8')));
  if(!declaredSources.length)throw Error('Retained member lacks enrollable embedded attribution: '+memberPath);
  imports.push({publicationRoot:sourceRoot,manifestSha256:STEP8_PRIOR_RELEASE.manifestSha256,releaseId:STEP8_PRIOR_RELEASE.releaseId,memberPath,declaredSources,destinationPath:'step8-0.3.2/'+memberPath});
 }
 return RetainedPublicationImportPlanSchema.parse({schemaVersion:'stadtstack-retained-import-plan-v1',managedRoot:resolve(managedRoot),imports});
}

type StagingInputs={campaign:z.infer<typeof Pin>;registry:z.infer<typeof Pin>;privateProvenance:z.infer<typeof Pin>;staging:Array<z.infer<typeof Pin>&{destination:string}>;identityAssessments?:z.infer<typeof Pin>;criticalAssessments?:z.infer<typeof Pin>;regionalPolicyReceipts?:z.infer<typeof Pin>};
export interface PreparedStep8Staging {readonly inputs:StagingInputs;dispose():Promise<void>}
type PreparedState={input:z.infer<typeof Step8StagingAssemblySchema>;output:string;campaignBytes:Buffer;campaignBindings:SourceArtifactBinding[];bindings:SourceArtifactBinding[];selected:Map<string,InventoryPin>;controls:string;inputs:StagingInputs;context?:WitnessedProvenanceContext;ownsContext:boolean;contextFinished:boolean;committed:boolean;disposed:boolean};
const preparations=new WeakMap<PreparedStep8Staging,PreparedState>();
function preparation(value:PreparedStep8Staging){const state=preparations.get(value);if(!state||state.disposed)throw Error('Unknown or disposed staging preparation');return state;}

/** Read-only verification and private control metadata only. No enrolled root,
 * source inventory or candidate is changed. A borrowed context is never rebuilt. */
export async function prepareStep8Staging(raw:unknown,pool?:Pool,borrowedContext?:WitnessedProvenanceContext):Promise<PreparedStep8Staging>{
 const input=Step8StagingAssemblySchema.parse(raw),policy:CivicPolicyOptions=input.policy,authority=await assertCivicPolicyAuthority(policy),output=resolve(input.managedRoot);
 const relativeOutput=relative(cacheDir,output);
 if(!relativeOutput||relativeOutput.startsWith('..')||isAbsolute(relativeOutput)||relativeOutput.split('/').some(part=>part==='out'||part==='release'))throw Error('Fresh staging control root beneath package cache required');
 try{await lstat(output);throw Error('Staging control root already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(await realpath(dirname(output))!==dirname(output))throw Error('Staging control parent alias rejected');
 await assertStagingRootsDisjoint(output,policy);
 const plan=RetainedPublicationImportPlanSchema.parse(await readPinnedJson(input.retainedPlan.path,input.retainedPlan.sha256));
 if(authority.mode!=='isolated-fixture'&&resolve(plan.managedRoot)!==RETAINED_PUBLICATION_ROOT)throw Error('Production staging requires the governed retained-publication root');
 const expected=await buildStep8RetainedPlan(plan.imports[0].publicationRoot,plan.managedRoot);
 if(!same(plan,expected))throw Error('Retained plan differs from the complete authentic 0.3.2 staging plan');
 const inventories=new Map<string,{pin:InventoryPin;read:()=>Promise<Buffer>}>();
 let context=borrowedContext,controls:string|undefined;
 const ownsContext=!borrowedContext;
 try{
  if(context)assertCanonicalContextInputs(context,policy,{selection:input.nativeSealSelection,catalogue:input.nativeSealCatalogue,casRoot:input.nativeCasRoot,importDispositionDecision:input.importDispositionDecision});
  if(input.nativeSealSelection||input.nativeSealCatalogue||input.nativeCasRoot||input.provenanceSupplements?.length||input.importDispositionDecision){
   if(!input.nativeSealSelection||!input.nativeSealCatalogue||!input.nativeCasRoot||!context&&!pool)throw Error('Native staging requires canonical DB, issued selection, catalogue and CAS root');
   context??=await createWitnessedProvenanceContext(input.nativeSealSelection,policy,{pool:pool!,casRoot:input.nativeCasRoot,catalogue:input.nativeSealCatalogue,mode:'step8',workers:input.reconstructionWorkers,timing:input.reconstructionTiming,importDispositionDecision:input.importDispositionDecision});
  }
  const supplements=new Map<string,NonNullable<typeof input.provenanceSupplements>[number]>();
  for(const selected of input.provenanceSupplements??[]){const key=canonicalJson([selected.nativeProvenance.path,selected.nativeProvenance.sha256]);if(supplements.has(key)||!input.provenances.some(pin=>pin.path===selected.nativeProvenance.path&&pin.sha256===selected.nativeProvenance.sha256))throw Error('Duplicate or unused source provenance supplement');supplements.set(key,selected);}
  for(const control of input.provenances){
   const selected=supplements.get(canonicalJson([control.path,control.sha256])),output=selected?.nativeOutput??(context?canonicalOutputForProvenance(context,control):undefined);
   const supplemental=output?await authenticateCanonicalSealProvenance(output,selected?.supplement,policy,context!):undefined;
   if(supplemental&&(supplemental.originalProvenance.path!==control.path||supplemental.originalProvenance.sha256!==control.sha256))throw Error('Supplement names another native provenance');
   const provenance=supplemental?.reader??await authenticatePublicationProvenance(control.path,control.sha256,policy),inventory=supplemental?.inventory??privatePublicationProvenanceSchema.parse(await readPinnedJson(control.path,control.sha256));
   for(const pin of inventory.inputs){
    const path=resolve(dirname(control.path),pin.path),old=inventories.get(path),normalized={...pin,path};
    if(old&&(old.pin.sha256!==pin.sha256||old.pin.bytes!==pin.bytes))throw Error('Conflicting authenticated input inventory');
    inventories.set(path,{pin:old?{...normalized,bindings:uniqueBindings([...old.pin.bindings,...pin.bindings])}:normalized,read:()=>provenance.read(path)});
   }
  }
  const selected=new Map<string,InventoryPin>(),managed=async(pin:{path:string;sha256?:string})=>{
   const path=resolve(pin.path),entry=inventories.get(path);if(!entry||pin.sha256!==undefined&&entry.pin.sha256!==pin.sha256)throw Error('Control lacks authenticated managed provenance: '+path);
   const bytes=await entry.read();selected.set(path,entry.pin);return bytes;
  };
  const campaignBytes=await readFile(input.campaign.path);if(digest(campaignBytes)!==input.campaign.sha256)throw Error('Campaign operator pin mismatch');
  const campaign=await authenticateStep8Campaign(JSON.parse(campaignBytes.toString('utf8')),path=>managed({path}),policy);
  for(const source of campaign.sources)await managed(source.corpus);
  const campaignBindings=uniqueBindings([...selected.values()].flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false}))));
  await managed(input.registry);for(const pin of [input.identityAssessments,input.criticalAssessments,input.regionalPolicyReceipts])if(pin)await managed(pin);
  const staging:StagingInputs['staging']=[];
  for(const member of plan.imports){
   const {destinationPath,...retained}=member,authenticated=await readAuthenticatedRetainedPublicationMember(retained,policy),path=join(plan.managedRoot,destinationPath);
   await assertManagedSourceBindings(path,authenticated.bindings,policy);const bytes=await readFile(path);
   if(!bytes.equals(authenticated.bytes))throw Error('Imported retained copy differs from authenticated member');
   await assertManagedSourceBindings(path,authenticated.bindings,policy);
   const pin={path,sha256:digest(bytes),bytes:bytes.length,bindings:authenticated.bindings};selected.set(path,pin);staging.push({path,sha256:pin.sha256,destination:member.memberPath});
  }
  await context?.checkpoint();
  const bindings=uniqueBindings([...selected.values()].flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false}))));
  controls=await mkdtemp(join(tmpdir(),'stadtstack-step8-staging-'));
  const bytes=encoded(privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[...selected.values()]})),path=join(controls,'verified-input-provenance.json');
  await writeFile(path,bytes,{mode:0o600,flag:'wx'});
  const inputs:StagingInputs={campaign:input.campaign,registry:input.registry,privateProvenance:{path,sha256:digest(bytes)},staging,...(input.identityAssessments?{identityAssessments:input.identityAssessments}:{}),...(input.criticalAssessments?{criticalAssessments:input.criticalAssessments}:{}),...(input.regionalPolicyReceipts?{regionalPolicyReceipts:input.regionalPolicyReceipts}:{})};
  const prepared:PreparedStep8Staging=Object.freeze({get inputs(){return structuredClone(preparation(prepared).inputs);},async dispose(){
   const live=preparations.get(prepared);if(!live||live.disposed)return;live.disposed=true;
   try{if(live.ownsContext&&live.context&&!live.contextFinished){live.contextFinished=true;await live.context.finish();}}finally{await rm(live.controls,{recursive:true,force:true});}
  }});
  preparations.set(prepared,{input,output,campaignBytes,campaignBindings,bindings,selected,controls,inputs,context,ownsContext,contextFinished:false,committed:false,disposed:false});return prepared;
 }catch(error){try{if(ownsContext)await context?.finish();}finally{if(controls)await rm(controls,{recursive:true,force:true});}throw error;}
}

/** A private operator campaign is declarative, not a source-rights proof.
 * Only a verified opaque preparation may defer its derivative's managed-copy
 * check until commit; every corpus has already passed genuine Core rights. */
export async function readPreparedStep8Campaign(prepared:PreparedStep8Staging,pin:z.infer<typeof Pin>){
 const live=preparation(prepared);if(!same(pin,live.inputs.campaign))throw Error('Prepared campaign pin differs');
 const bytes=await readFile(pin.path);if(!bytes.equals(live.campaignBytes)||digest(bytes)!==pin.sha256)throw Error('Prepared campaign changed');return bytes;
}

export async function readPreparedStep8Provenance(prepared:PreparedStep8Staging,pin:z.infer<typeof Pin>){
 const live=preparation(prepared);if(!same(pin,live.inputs.privateProvenance))throw Error('Prepared provenance control pin differs');
 const expected=encoded(privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[...live.selected.values()]})),bytes=await readFile(pin.path);
 if(!bytes.equals(expected)||digest(bytes)!==pin.sha256)throw Error('Prepared provenance control changed');return bytes;
}

export async function commitStep8Staging(prepared:PreparedStep8Staging){
 const live=preparation(prepared);if(live.committed)throw Error('Staging preparation already committed');
 const {input,output,campaignBytes,campaignBindings,bindings}=live,policy=input.policy;
 if(live.context)assertCanonicalEpochFinished(live.context);
 await readPreparedStep8Campaign(prepared,input.campaign);
 // Re-authenticate exact current rights and bytes after closing the source epoch,
 // before the first managed write. No historical audit/cache grants permission.
 const source=await authenticatePublicationProvenance(live.inputs.privateProvenance.path,live.inputs.privateProvenance.sha256,policy);
 for(const pin of live.selected.values())await source.read(pin.path);
 await assertStagingRootsDisjoint(output,policy);const claim=await reserveStep8Generation(output);live.committed=true;
 const write=async(name:string,bytes:Buffer,contributors=bindings)=>{
  await claim.assertOwned();const path=join(output,name),sha256=await writeManagedSourceArtifact(output,path,bytes,contributors,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});await claim.assertOwned();return {path,sha256};
 };
 const campaignPin=await write('campaign.json',campaignBytes,campaignBindings),selected=new Map(live.selected);
 selected.set(campaignPin.path,{...campaignPin,bytes:campaignBytes.length,bindings:campaignBindings});
 const provenance=privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[...selected.values()]}),privateProvenance=await write('private-publication-provenance.json',encoded(provenance));
 const authenticated=await authenticatePublicationProvenance(privateProvenance.path,privateProvenance.sha256,policy);for(const pin of provenance.inputs)await authenticated.read(pin.path);
 const component={...live.inputs,campaign:campaignPin,privateProvenance},componentPin=await write('staging-component.json',encoded(component));
 return {schemaVersion:'stadtstack-r1-step8-staging-result-v2',component:componentPin,inputs:component,retainedPlan:input.retainedPlan,importedMembers:component.staging.length,publicationExecuted:false,valueAccepted:false,hostedReleaseAuthorized:false};
}

/** Standalone assembly remains available; execute borrows prepare/commit instead
 * of invoking a second canonical reconstruction. */
export async function assembleStep8Staging(raw:unknown,pool?:Pool){
 const prepared=await prepareStep8Staging(raw,pool);
 try{const live=preparation(prepared);if(live.context){live.contextFinished=true;await live.context.finish();}return await commitStep8Staging(prepared);}
 finally{await prepared.dispose();}
}
