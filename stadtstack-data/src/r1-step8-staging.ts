import {readFile,lstat,realpath} from 'node:fs/promises';
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
import {NativeProvenancePinSchema,ProvenanceSupplementSelectionSchema,createWitnessedProvenanceContext,authenticateSealProvenance,type WitnessedProvenanceContext} from './r1-step8-provenance.ts';

const Pin=z.object({path:z.string().refine(isAbsolute,'Absolute input path required'),sha256:HashSchema}).strict();
const Policy=z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string().min(1),authoritySha256:HashSchema}).strict();
export const Step8StagingAssemblySchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-staging-assembly-v1'),
 retainedPlan:Pin,provenances:z.array(Pin).min(1),campaign:Pin,registry:Pin,
 nativeSealSelection:NativeProvenancePinSchema.optional(),nativeSealCatalogue:NativeProvenancePinSchema.optional(),nativeCasRoot:z.string().refine(isAbsolute).optional(),
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

/** Consumes already imported retained copies and genuine managed dependencies.
 * Only campaign/provenance/component derivatives are created; no source rights
 * are inferred from an operator path, a registry descriptor, or Git membership. */
export async function assembleStep8Staging(raw:unknown,pool?:Pool){
 const input=Step8StagingAssemblySchema.parse(raw),policy:CivicPolicyOptions=input.policy,authority=await assertCivicPolicyAuthority(policy),output=resolve(input.managedRoot);
 const relativeOutput=relative(cacheDir,output);
 if(!relativeOutput||relativeOutput.startsWith('..')||isAbsolute(relativeOutput)||relativeOutput.split('/').some(part=>part==='out'||part==='release'))throw Error('Fresh staging control root beneath package cache required');
 try{await lstat(output);throw Error('Staging control root already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(await realpath(dirname(output))!==dirname(output))throw Error('Staging control parent alias rejected');
 await assertStagingRootsDisjoint(output,policy);
 const plan=RetainedPublicationImportPlanSchema.parse(await readPinnedJson(input.retainedPlan.path,input.retainedPlan.sha256));
 if(authority.mode!=='isolated-fixture'&&resolve(plan.managedRoot)!==RETAINED_PUBLICATION_ROOT)throw Error('Production staging requires the governed retained-publication root');
 // Rebuild the exact approved plan, rejecting changed sets, declarations, roots,
 // destinations or predecessor identities before writing any control artifact.
 const expected=await buildStep8RetainedPlan(plan.imports[0].publicationRoot,plan.managedRoot);
 if(!same(plan,expected))throw Error('Retained plan differs from the complete authentic 0.3.2 staging plan');
 const inventories=new Map<string,{pin:InventoryPin;read:()=>Promise<Buffer>}>();
 let provenanceContext:WitnessedProvenanceContext|undefined;
 try{
 if(input.provenanceSupplements?.length){
  if(!pool||!input.nativeSealSelection||!input.nativeSealCatalogue||!input.nativeCasRoot)throw Error('Supplements require canonical DB, governed selection, catalogue and CAS root');
  provenanceContext=await createWitnessedProvenanceContext(input.nativeSealSelection,policy,{pool,casRoot:input.nativeCasRoot,catalogue:input.nativeSealCatalogue,mode:'step8'});
 }else if(input.nativeSealSelection||input.nativeSealCatalogue||input.nativeCasRoot)throw Error('Unused native selection context');
 const supplements=new Map<string,NonNullable<typeof input.provenanceSupplements>[number]>();
 for(const selected of input.provenanceSupplements??[]){const key=canonicalJson([selected.nativeProvenance.path,selected.nativeProvenance.sha256]);if(supplements.has(key)||!input.provenances.some(pin=>pin.path===selected.nativeProvenance.path&&pin.sha256===selected.nativeProvenance.sha256))throw Error('Duplicate or unused source provenance supplement');supplements.set(key,selected);}
 for(const control of input.provenances){
  const selected=supplements.get(canonicalJson([control.path,control.sha256]));
  const supplemental=selected?await authenticateSealProvenance(selected.nativeOutput,selected.supplement,policy,provenanceContext!):undefined;
  if(supplemental&&(supplemental.originalProvenance.path!==control.path||supplemental.originalProvenance.sha256!==control.sha256))throw Error('Supplement names another native provenance');
  const provenance=supplemental?.reader??await authenticatePublicationProvenance(control.path,control.sha256,policy);
  const inventory=supplemental?.inventory??privatePublicationProvenanceSchema.parse(await readPinnedJson(control.path,control.sha256));
  for(const pin of inventory.inputs){
   const path=resolve(dirname(control.path),pin.path),old=inventories.get(path),normalized={...pin,path};
   if(old&&(old.pin.sha256!==pin.sha256||old.pin.bytes!==pin.bytes))throw Error('Conflicting authenticated input inventory');
   inventories.set(path,{pin:old?{...normalized,bindings:uniqueBindings([...old.pin.bindings,...pin.bindings])}:normalized,read:()=>provenance.read(path)});
  }
 }
 const selected=new Map<string,InventoryPin>();
 const managed=async(pin:{path:string;sha256?:string})=>{
  const path=resolve(pin.path),entry=inventories.get(path);
  if(!entry||pin.sha256!==undefined&&entry.pin.sha256!==pin.sha256)throw Error('Control lacks authenticated managed provenance: '+path);
  const bytes=await entry.read();selected.set(path,entry.pin);return bytes;
 };
 const campaignBytes=await readFile(input.campaign.path);
 if(digest(campaignBytes)!==input.campaign.sha256)throw Error('Campaign operator pin mismatch');
 const campaign=await authenticateStep8Campaign(JSON.parse(campaignBytes.toString('utf8')),path=>managed({path}),policy);
 for(const source of campaign.sources)await managed(source.corpus);
 const campaignBindings=uniqueBindings([...selected.values()].flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false}))));
 await managed(input.registry);
 for(const pin of [input.identityAssessments,input.criticalAssessments,input.regionalPolicyReceipts])if(pin)await managed(pin);
 const staging=[];
 for(const member of plan.imports){
  const {destinationPath,...retained}=member,authenticated=await readAuthenticatedRetainedPublicationMember(retained,policy),path=join(plan.managedRoot,destinationPath);
  await assertManagedSourceBindings(path,authenticated.bindings,policy);
  const bytes=await readFile(path);
  if(!bytes.equals(authenticated.bytes))throw Error('Imported retained copy differs from authenticated member');
  await assertManagedSourceBindings(path,authenticated.bindings,policy);
  const pin={path,sha256:digest(bytes),bytes:bytes.length,bindings:authenticated.bindings};selected.set(path,pin);
  staging.push({path,sha256:pin.sha256,destination:member.memberPath});
 }
 const completedContext=provenanceContext;provenanceContext=undefined;await completedContext?.finish();
 // Do not upgrade derivative custody into independent original-source rights.
 const bindings=uniqueBindings([...selected.values()].flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false}))));
 await assertStagingRootsDisjoint(output,policy);
 const claim=await reserveStep8Generation(output);
 const write=async(name:string,bytes:Buffer,contributors=bindings)=>{
  await claim.assertOwned();
  const path=join(output,name),sha256=await writeManagedSourceArtifact(output,path,bytes,contributors,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  await claim.assertOwned();
  return {path,sha256};
 };
 // The exact campaign bytes are preserved, not normalized into a new identity.
 const campaignPin=await write('campaign.json',campaignBytes,campaignBindings);
 selected.set(campaignPin.path,{...campaignPin,bytes:campaignBytes.length,bindings:campaignBindings});
 const provenance=privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[...selected.values()]});
 const privateProvenance=await write('private-publication-provenance.json',encoded(provenance));
 // Authenticate all dependencies again after assembly; current opt-outs and
 // changed managed files remain hard failures, never stale-view fallbacks.
 const authenticated=await authenticatePublicationProvenance(privateProvenance.path,privateProvenance.sha256,policy);
 for(const pin of provenance.inputs)await authenticated.read(pin.path);
 const component={campaign:campaignPin,registry:input.registry,privateProvenance,staging,...(input.identityAssessments?{identityAssessments:input.identityAssessments}:{}),...(input.criticalAssessments?{criticalAssessments:input.criticalAssessments}:{}),...(input.regionalPolicyReceipts?{regionalPolicyReceipts:input.regionalPolicyReceipts}:{})};
 const componentPin=await write('staging-component.json',encoded(component));
 return {schemaVersion:'stadtstack-r1-step8-staging-result-v2',component:componentPin,inputs:component,retainedPlan:input.retainedPlan,importedMembers:staging.length,publicationExecuted:false,valueAccepted:false,hostedReleaseAuthorized:false};
 }finally{await provenanceContext?.finish();}
}
