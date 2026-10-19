import {lstat,realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {canonicalJson,digest} from './district-adapter-contract.ts';
import {loadFrozenCorpusBytes,type CrawlDocument} from './district-corpus.ts';
import {CrawlCorpusImportSchema,importedRegisteredPolicy,registeredImportScope} from './district-crawl-import.ts';
import {readOperatorRegistryInputPin,readCrawlOperatorRegistryInputPin} from './district-registry-config.ts';
import {ResidualInputSchema,residualMimeSupported} from './district-residual-jobs.ts';
import {SourceObservationSchema,sourceObservationMatches,readBoundSourceObservation,type BoundSourceObservation} from './source-observation.ts';
import {CrawlRequestEvidenceSchema} from './district-crawl-request.ts';
import {authenticatedHttpBinding} from './district-http-observation.ts';
import {assertManagedRawSourceBinding,assertManagedSourceBindings,assertManagedObservationReadable,type CivicPolicyOptions} from './civic-opt-out.ts';
import {admittedRegisteredRobotsScopes} from './registered-source-policy.ts';
import {registeredSourcePolicyApplies,sourcePolicyExpiresAt,MAX_POLICY_METADATA_EVIDENCE} from './source-policy.ts';

import {ImportDispositionPinSchema as Pin,ImportDispositionDecisionSchema,type ImportDispositionDecision,type ImportRejectionDisposition} from './r1-step8-import-disposition-contract.ts';
type Read=(pin:z.infer<typeof Pin>)=>Promise<Uint8Array>;
const equal=(a:unknown,b:unknown,message:string)=>{if(canonicalJson(a)!==canonicalJson(b))throw Error(message);};
export function assertImportDispositionDecisionCurrent(decision:ImportDispositionDecision){
 const now=Date.now();if(Date.parse(decision.issuedAt)>now||Date.parse(decision.expiresAt)<=now||Date.parse(decision.issuedAt)>=Date.parse(decision.expiresAt))throw Error('Import disposition decision is future-issued or expired');
}
export function recomputePermanentImportRejection(registry:Parameters<typeof registeredImportScope>[0],document:CrawlDocument,scope:Parameters<typeof registeredImportScope>[2]){
 const selected=registeredImportScope(registry,document,scope);
 return { ...selected,reasonCode:!selected.withinOrigins?'scope_mismatch' as const:!residualMimeSupported(document.mimeType)?'unsupported_mime' as const:undefined};
}
/** Every control is issued/pinned, every source byte is read through the live managed
 * audit fence. No importer, receipt creation, job enqueue or CAS write is invoked. */
export async function authenticateImportDispositions(options:{decision?:z.infer<typeof Pin>;nativeSealSelection:z.infer<typeof Pin>;catalogue:z.infer<typeof Pin>;seals:readonly {sealResult:z.infer<typeof Pin>}[];policy:CivicPolicyOptions;control:Read;managed:Read}):Promise<ImportRejectionDisposition[]>{
 if(!options.decision)return [];
 const pinned=async(pin:z.infer<typeof Pin>,read:Read)=>{const bytes=Buffer.from(await read(pin));if(digest(bytes)!==pin.sha256)throw Error('Import disposition evidence pin mismatch');return bytes;};
 const json=async(pin:z.infer<typeof Pin>,read:Read)=>JSON.parse((await pinned(pin,read)).toString('utf8'));
 const decision=ImportDispositionDecisionSchema.parse(await json(options.decision,options.control));assertImportDispositionDecisionCurrent(decision);
 const issuance=z.object({selection:Pin}).passthrough().parse(await json(options.nativeSealSelection,options.control));
 equal(decision.nativeSealSelection,issuance.selection,'Import decision selects another native seal selection');equal(decision.catalogue,options.catalogue,'Import decision selects another catalogue');
 const selection=z.object({catalogue:Pin,seals:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),corpus:Pin,output:Pin}).passthrough()).min(1)}).passthrough().parse(await json(decision.nativeSealSelection,options.control));
 equal(selection.catalogue,decision.catalogue,'Import decision changes governed catalogue');
 const seen=new Set<string>(),sources=new Set<string>(),dispositions:ImportRejectionDisposition[]=[];
 for(const evidence of decision.sources){
  const identity=canonicalJson([evidence.municipalityId,evidence.sourceId]);if(sources.has(identity))throw Error('Duplicate import disposition source');sources.add(identity);
  if(!options.seals.some(seal=>canonicalJson(seal.sealResult)===canonicalJson(evidence.sealResult)))throw Error('Import evidence belongs to an unselected seal');
  const governed=selection.seals.filter(seal=>seal.municipalityId===evidence.municipalityId&&seal.sourceId===evidence.sourceId);
  if(governed.length!==1)throw Error('Import evidence lacks exact governed source');
  equal(governed[0].output,evidence.sealResult,'Import evidence changes governed seal');equal(governed[0].corpus,evidence.corpus,'Import evidence changes governed corpus');
  const manifest=CrawlCorpusImportSchema.parse(await json(evidence.manifest,options.control));equal(manifest.index,evidence.corpus,'Import manifest changes frozen corpus');
  const result=z.object({jobs:z.array(ResidualInputSchema),holds:z.array(z.object({documentId:z.string(),reasonCode:z.string()}).strict()),coverage:z.object({basis:z.literal('authenticated_imported_observations'),selected:z.number().int(),imported:z.number().int(),held:z.number().int(),acquisitionStepReceipts:z.literal(0)}).strict()}).strict().parse(await json(evidence.importResult,options.control));
  if(result.coverage.selected!==manifest.documents.length||result.coverage.imported!==result.jobs.length||result.coverage.held!==result.holds.length||result.jobs.length+result.holds.length!==manifest.documents.length)throw Error('Import result coverage mismatch');
  const members=[...result.jobs.map(row=>row.documentId),...result.holds.map(row=>row.documentId)];equal([...members].sort(),manifest.documents.map(row=>row.documentId).sort(),'Import result membership mismatch');if(new Set(members).size!==members.length)throw Error('Duplicate import result document');
  const corpus=loadFrozenCorpusBytes(await pinned(evidence.corpus,options.managed),evidence.corpus.sha256);
  const migration=manifest.crawlRegistry?await readCrawlOperatorRegistryInputPin(manifest.crawlRegistry,manifest.registry,options.policy):undefined,admitted=migration?.processing??await readOperatorRegistryInputPin(manifest.registry,options.policy);
  const seal=z.object({artifacts:z.object({registry:Pin}).passthrough()}).passthrough().parse(await json(evidence.sealResult,options.control));
  if(seal.artifacts.registry.sha256!==digest(admitted.bytes))throw Error('Import manifest registry differs from selected native seal');
  await pinned(seal.artifacts.registry,options.managed);
  const observations=new Map<string,{bytes:Buffer;binding:BoundSourceObservation['binding'];observation:BoundSourceObservation['observation']}>();
  if(await realpath(manifest.rawRoot)!==manifest.rawRoot)throw Error('Import raw root alias rejected');
  for(const pin of manifest.observations){
   const stat=await lstat(pin.path);
   if(dirname(pin.path)!==join(manifest.rawRoot,'observations')||!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||await realpath(pin.path)!==pin.path)throw Error('Import observation location/bound rejected');
   await assertManagedObservationReadable(pin.path,options.policy);
   const bytes=await pinned(pin,options.control),observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8'))),name=basename(pin.path);
   if(observations.has(name))throw Error('Duplicate import observation');
   observations.set(name,{bytes,observation,binding:{kind:'http_observation',url:observation.url,sourceSha256:observation.sha256,observationId:name,receiptSha256:pin.sha256}});
  }
  for(const document of [...corpus.documents,...corpus.excludedDocuments??[]]){
   const original=document.observationPath?observations.get(basename(document.observationPath)):undefined;
   if(!original||document.observationPath!==join(manifest.rawRoot,'observations',original.binding.observationId)||!document.checkedAt||document.status===undefined||!sourceObservationMatches(original.observation,{...document,checkedAt:document.checkedAt,status:document.status,sizeBytes:'sizeBytes' in document?document.sizeBytes:original.observation.bytes,bodyState:'exclusion' in document?'excluded':'retained'}))throw Error('Import corpus original ancestry mismatch');
  }
  await assertManagedSourceBindings(evidence.corpus.path,[...(migration?.crawl.bindings??admitted.bindings),...[...observations.values()].map(row=>row.binding)],options.policy);
  const derive=importedRegisteredPolicy(corpus.documents,manifest.rawRoot,options.policy,observations),eligibility=admittedRegisteredRobotsScopes(admitted.registry,digest(admitted.bytes));
  for(const claim of evidence.documents){
   const key=canonicalJson([identity,claim.documentId]);if(seen.has(key))throw Error('Duplicate import disposition document');seen.add(key);
   if(!decision.policy.enabledReasons.some(reason=>reason===claim.reasonCode))throw Error('Import rejection reason lacks explicit owner decision');
   const documents=corpus.documents.filter(row=>row.id===claim.documentId),selections=manifest.documents.filter(row=>row.documentId===claim.documentId),holds=result.holds.filter(row=>row.documentId===claim.documentId);
   if(documents.length!==1||selections.length!==1||holds.length!==1)throw Error('Import disposition lacks exact original/manifest/held membership');
   const document=documents[0],selected=selections[0];
   if(document.sha256!==claim.sourceSha256||document.municipalityId!==evidence.municipalityId||document.sourceId!==evidence.sourceId||selected.scope.municipalityId!==evidence.municipalityId||selected.scope.sourceId!==evidence.sourceId)throw Error('Import disposition original identity mismatch');
   const original=observations.get(basename(document.observationPath!))!,rawPath=join(manifest.rawRoot,'sha256',document.sha256);
   if(resolve(dirname(manifest.index.path),document.localPath)!==rawPath)throw Error('Import original changes managed raw body');
   const raw=await pinned({path:rawPath,sha256:document.sha256},options.managed);if(raw.length!==original.observation.bytes)throw Error('Import original byte length mismatch');await assertManagedRawSourceBinding(rawPath,original.binding,options.policy);
   const {source,city,origins,reasonCode:permanent}=recomputePermanentImportRejection(admitted.registry,document,selected.scope);
   let reasonCode:ImportRejectionDisposition['reasonCode']|undefined=permanent;
   if(!permanent){
    if(selected.policyRefreshJobKey)throw Error('Refreshed import cannot be dispositioned as ordinary expired policy');
    const acquired=await readBoundSourceObservation({rawRoot:manifest.rawRoot,document,policy:options.policy,registeredSource:source});equal(acquired.binding,original.binding,'Import original observation binding changed');
    authenticatedHttpBinding({observationId:acquired.binding.observationId,receiptSha256:acquired.binding.receiptSha256,bytes:original.bytes.toString('utf8')},{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,fetchedAt:document.checkedAt});
    if(!selected.requestEvidence||selected.requestEvidence.path!==join(manifest.rawRoot+'-request-evidence','requests',acquired.binding.observationId))throw Error('Import original request evidence unavailable');
    const requestEvidence=CrawlRequestEvidenceSchema.parse(await json(selected.requestEvidence,options.managed));equal(requestEvidence.httpObservation,acquired.binding,'Import request binding changed');
    const {request,redirectChain}=requestEvidence;
    await assertManagedSourceBindings(selected.requestEvidence.path,[acquired.binding],options.policy);
    if(!request||!redirectChain||redirectChain[0]!==request.url||redirectChain.at(-1)!==document.url||redirectChain.some(url=>!origins.has(new URL(url).origin))||request.method==='POST'&&(request.publicSelector===null||request.bodySha256!==digest(request.publicSelector)))throw Error('Import request/redirect evidence unavailable');
    const clocks=[acquired.observation.checkedAt,acquired.policy.robots.checkedAt,...acquired.policy.tdm.evidence.map(row=>row.checkedAt)];if(!acquired.policy.tdm.evidence.length||clocks.some(clock=>!clock||!Number.isFinite(Date.parse(clock))||Date.parse(clock)>Date.now()))throw Error('Import original policy clock invalid');
    if(acquired.policy.tdm.evidence.length>=MAX_POLICY_METADATA_EVIDENCE)throw Error('Policy metadata bound is not unauthenticable registered discovery');
    const base=eligibility.find(row=>row.municipalityId===city.id&&row.sourceId===source.id&&row.ags===city.ags&&row.root===source.url),sourcePolicy=await derive(document,acquired,source,base);
    if(base&&!registeredSourcePolicyApplies(sourcePolicy,document,selected.scope,base)&&Date.parse(sourcePolicyExpiresAt(sourcePolicy,acquired.observation.checkedAt,document,selected.scope,base))<=Date.now())reasonCode='source_policy_stale';
   }
   if(!reasonCode||claim.reasonCode!==reasonCode||holds[0].reasonCode!==reasonCode)throw Error('Import rejection reason differs from authenticated inputs');
   dispositions.push({kind:'import_rejection',municipalityId:evidence.municipalityId,sourceId:evidence.sourceId,corpusSha256:evidence.corpus.sha256,documentId:document.id,sourceSha256:document.sha256,reasonCode,rule:'crawl_import_rejection_v1',decision:options.decision,sealResult:evidence.sealResult,manifest:evidence.manifest,importResult:evidence.importResult,registry:manifest.registry,processed:false,admittedRecordIds:[]});
  }
 }
 assertImportDispositionDecisionCurrent(decision);return dispositions;
}
