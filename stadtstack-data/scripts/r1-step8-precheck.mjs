#!/usr/bin/env node
// Early refusal only. No Core capability, inventory lock, source write or reconstruction.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {precheckStructuredSelection,loadStructuredPrecheckCore} from './r1-step8-structured-precheck.mjs';
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const contains=(root,path)=>{const child=relative(root,path);return !!child&&child!=='..'&&!child.startsWith('../')&&!isAbsolute(child);};
const load=file=>import(pathToFileURL(join(packageRoot,'src',file)).href);

export async function precheckStep8Publication(raw,{pool,proposeControls=false,inputPin}={}){
 const [operator,staging,provenance,audit,civic,corpus,governance,retained,adapter,normalization,partition,bounds,witness,policyReceipt,current]=await Promise.all(['r1-step8.ts','r1-step8-staging.ts','district-publication-provenance.ts','r1-step8-managed-read-view.ts','civic-opt-out.ts','district-corpus.ts','r1-step8-governance.ts','district-retained-import.ts','district-adapter-contract.ts','publication-binding-normalization.ts','publication-provenance-partition.ts','r1-step8-publication-bounds.ts','r1-step8-provenance.ts','district-policy-receipt.ts','r1-step8-current-policy.ts'].map(load));
 const input=operator.Step8OperatorInputSchema.parse(raw),controlsRead=new Map(),blockers=[],requiredThrough=witness.reconstructionPolicyHorizon(input.reconstructionTiming);
 const pinned=async pin=>{const path=resolve(pin.path),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o022)!==0||stat.size>128*1024*1024||await realpath(path)!==path)throw Error('Unsafe precheck control: '+path);const bytes=await readFile(path);if(digest(bytes)!==pin.sha256)throw Error('Precheck control pin mismatch: '+path);const prior=controlsRead.get(path);if(prior&&prior.sha256!==pin.sha256)throw Error('Conflicting precheck control pin');controlsRead.set(path,{path,sha256:pin.sha256});return bytes;};
 const assembled='stagingAssembly' in input,assembly=assembled?staging.Step8StagingAssemblySchema.parse(JSON.parse((await pinned(input.stagingAssembly)).toString('utf8'))):input;
 if(adapter.canonicalJson(assembly.policy)!==adapter.canonicalJson(input.policy))throw Error('Assembly policy differs');
 const campaign=governance.Step8CampaignSchema.parse(JSON.parse((await pinned(assembly.campaign)).toString('utf8'))),action=JSON.parse((await pinned(input.nativeSealSelection)).toString('utf8')),frame=witness.NativeSealSelectionSchema.parse(JSON.parse((await pinned(action.selection)).toString('utf8'))),fence=await audit.createReadOnlyManagedSourceAudit(input.policy);
 const nativeMap=new Map(),externalMap=new Map(),nativeInventories=[],nativeOutputs=[],urlMap=new Map();
 let report,controlInventory;
 const addUrl=value=>{try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return;url.hostname=url.hostname.replace(/\.$/,'');url.hash='';urlMap.set(digest(url.href),url.href);}catch{}};
 const visit=value=>{if(typeof value==='string')addUrl(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
 const merge=(map,inventory,base)=>{for(const pin of inventory.inputs){const path=resolve(base,pin.path),old=map.get(path);if(old&&(old.sha256!==pin.sha256||old.bytes!==pin.bytes))throw Error('Conflicting inventory declaration: '+path);map.set(path,normalization.normalizePublicationPin({...pin,path,bindings:[...old?.bindings??[],...pin.bindings]}));for(const binding of pin.bindings)addUrl(binding.url);}};
 const managedReads=new Map(),managedRead=async(path,expectedSha256)=>{const bytes=await fence.read(path,expectedSha256),sha256=expectedSha256??digest(bytes);managedReads.set(resolve(path),{path:resolve(path),sha256,bytes:bytes.length});return bytes;};
 const readCas=hash=>{adapter.HashSchema.parse(hash);return managedRead(join(input.casRoot,'sha256',hash.slice(0,2),hash),hash);};
 try{
  if(inputPin)await pinned(inputPin);
  const catalogue=JSON.parse((await pinned(input.currentGeneration.catalogue)).toString('utf8')),processingReview=JSON.parse((await pinned(input.currentGeneration.processingReview)).toString('utf8'));
  current.assertStep8ProcessingPin(input.currentGeneration,catalogue,processingReview);
  if(frame.catalogue.path!==input.currentGeneration.catalogue.path||frame.catalogue.sha256!==input.currentGeneration.catalogue.sha256)throw Error('Native selection catalogue differs from processing pin');
  if(fence.authority.mode!=='isolated-fixture'){
   witness.assertProductionNativeSealCohort(frame,catalogue);
   if(input.expectedSources!==27||input.expectedDocuments!==208||adapter.canonicalJson(input.priorRelease)!==adapter.canonicalJson(current.STEP8_PRIOR_RELEASE))throw Error('Production requires the frozen27-source208-document cohort and authentic0.3.2 predecessor');
  }
  if(campaign.sources.length!==input.expectedSources||campaign.sources.reduce((sum,source)=>sum+source.documents.length,0)!==input.expectedDocuments)throw Error('Campaign totals differ from explicit input');
  const campaignIdentities=new Set();for(const source of campaign.sources){const key=adapter.canonicalJson([source.municipalityId,source.sourceId]);if(campaignIdentities.has(key)||!frame.seals.some(seal=>seal.municipalityId===source.municipalityId&&seal.sourceId===source.sourceId&&seal.corpus.sha256===source.corpus.sha256))throw Error('Campaign source differs from exact native frame');campaignIdentities.add(key);}
  if(Date.parse(action.expiresAt)<=requiredThrough)blockers.push({code:'NATIVE_SELECTION_HORIZON',expiresAt:action.expiresAt});
  if(input.importDispositionDecision){const decision=JSON.parse((await pinned(input.importDispositionDecision)).toString('utf8'));if(!Number.isFinite(Date.parse(decision.expiresAt))||Date.parse(decision.expiresAt)<=requiredThrough)blockers.push({code:'IMPORT_DISPOSITION_HORIZON',decision:input.importDispositionDecision,expiresAt:decision.expiresAt});}
  const expected=new Set(frame.seals.map(seal=>adapter.canonicalJson({path:seal.output.path,sha256:seal.output.sha256})));
  for(const selected of input.seals)if(!expected.delete(adapter.canonicalJson(selected.sealResult)))throw Error('Seal selection pin mismatch');
  if(expected.size)throw Error('Incomplete seal selection');
  for(const selected of frame.seals){
   const output=JSON.parse((await pinned(selected.output)).toString('utf8')),bytes=await managedRead(output.privateProvenance.path,output.privateProvenance.sha256),inventory=provenance.privatePublicationProvenanceSchema.parse(JSON.parse(bytes.toString('utf8')));
   merge(nativeMap,inventory,dirname(output.privateProvenance.path));nativeOutputs.push(output);nativeInventories.push({sourceId:selected.sourceId,provenance:output.privateProvenance,inputCount:inventory.inputs.length});
  }
  for(const pin of assembled?assembly.provenances:[input.privateProvenance,input.stagingProvenance]){
   const bytes=await pinned(pin);if(bytes.length>=partition.PROVENANCE_LIMIT_BYTES-partition.PROVENANCE_SAFETY_MARGIN_BYTES)blockers.push({code:'INPUT_PROVENANCE_SIZE_GUARD',path:pin.path,bytes:bytes.length});
   merge(externalMap,provenance.privatePublicationProvenanceSchema.parse(JSON.parse(bytes.toString('utf8'))),dirname(pin.path));
  }
  const declarations=new Map(nativeMap);for(const pin of externalMap.values())merge(declarations,{inputs:[pin]},process.cwd());
  for(const pin of declarations.values()){const bytes=await managedRead(pin.path,pin.sha256);if(bytes.length!==pin.bytes)throw Error('Input length mismatch: '+pin.path);}
  const controlRefs=campaign.sources.map(source=>({role:'corpus',sourceId:source.sourceId,...source.corpus}));controlRefs.push({role:'registry',...assembly.registry});
  for(const role of ['identityAssessments','criticalAssessments','regionalPolicyReceipts'])if(assembly[role])controlRefs.push({role,...assembly[role]});
  const corpusBytes=new Map();
  for(const source of campaign.sources){const bytes=await managedRead(source.corpus.path,source.corpus.sha256),frozen=corpus.loadFrozenCorpusBytes(bytes,source.corpus.sha256);if(frozen.documents.length!==source.documents.length||frozen.documents.some(document=>document.sourceId!==source.sourceId||document.municipalityId!==source.municipalityId||!source.documents.some(selected=>selected.documentId===document.id&&selected.sha256===document.sha256)))throw Error('Campaign corpus membership mismatch: '+source.sourceId);corpusBytes.set(source.corpus.path,bytes);visit(JSON.parse(bytes.toString('utf8')));}
  const stagePins=[];let retainedPlan;
  if(assembled){
   retainedPlan=JSON.parse((await pinned(assembly.retainedPlan)).toString('utf8'));
   const manifestBytes=await readFile(join(retainedPlan.imports[0].publicationRoot,'release-manifest.json'));if(digest(manifestBytes)!==input.priorRelease.manifestSha256)throw Error('Retained predecessor manifest mismatch');const manifest=JSON.parse(manifestBytes.toString('utf8'));
   for(const member of retainedPlan.imports){const pin=manifest.files.find(file=>file.path===member.memberPath);if(!pin)throw Error('Retained member absent');const path=join(retainedPlan.managedRoot,member.destinationPath),bytes=await managedRead(path,pin.sha256);if(bytes.length!==pin.bytes)throw Error('Retained member length mismatch');if(adapter.canonicalJson(retained.retainedPublicationSources(JSON.parse(bytes.toString('utf8'))))!==adapter.canonicalJson(member.declaredSources))throw Error('Retained source declaration differs');const publication={manifestSha256:member.manifestSha256,releaseId:member.releaseId,memberPath:pin.path,memberSha256:pin.sha256,memberBytes:pin.bytes};stagePins.push({path,sha256:pin.sha256,bytes:pin.bytes,bindings:member.declaredSources.map(source=>({kind:'retained_publication',...source,publication,independentAllowed:false}))});}
  }else for(const stage of input.staging){const pin=externalMap.get(resolve(stage.path));if(!pin||pin.sha256!==stage.sha256)throw Error('Staging input lacks declared provenance');stagePins.push(pin);}
  // The existing reader above validates the complete wire and segment/authority
  // epoch. This subset inspection never grants authority or writes that state.
  const state=input.policy.stateDir,manifestBytes=await readFile(join(state,'inventory.json'));if(digest(manifestBytes)!==fence.inventorySha256)throw Error('Inventory epoch changed');
  const hot=JSON.parse(manifestBytes.toString('utf8')),roots=new Map(hot.roots.map(root=>[root.id,root])),wantedPaths=new Set([...declarations.keys(),...controlRefs.map(pin=>resolve(pin.path)),...stagePins.map(pin=>pin.path)]),entries=new Map(),ordinals=new Map((hot.storage?.segments??[]).map((pin,index)=>[pin.sha256,index]));
  const take=(entry,ordinal)=>{if(!wantedPaths.has(join(roots.get(entry.rootId).path,entry.relativePath)))return;const retired=hot.storage?.retiredRoots?.[entry.rootId];if(ordinal!==undefined&&retired!==undefined&&ordinals.get(retired)>=ordinal)return;entries.set(entry.id,{...entry,state:hot.storage?.entryStates?.[entry.id]??entry.state});};
  for(const [ordinal,pin] of (hot.storage?.segments??[]).entries()){const bytes=await readFile(join(state,'inventory-segments',pin.sha256+'.json'));if(bytes.length!==pin.bytes||digest(bytes)!==pin.sha256)throw Error('Segment pin mismatch');for(const entry of JSON.parse(bytes.toString('utf8')).entries)take(entry,ordinal);}for(const entry of hot.entries)take(entry);
  const rowsFor=pin=>[...entries.values()].filter(entry=>join(roots.get(entry.rootId).path,entry.relativePath)===resolve(pin.path)&&entry.contentSha256===pin.sha256);
  const descriptor=value=>adapter.canonicalJson([value.configurationSha256,value.schemaContractSha256,value.code,value.approval]);
  const identity=value=>adapter.canonicalJson([value.kind,value.urlSha256,value.sourceSha256??null,...['observationId','receiptSha256','publication','snapshot','purpose','configurationSha256','schemaContractSha256','code','approval'].map(key=>value[key]??null)]);
  const validateBindings=pin=>{
   const rows=rowsFor(pin),expected=new Map();if(!rows.length||rows.some(entry=>entry.state!=='active'))throw Error('Missing/inactive live content binding');
   for(const entry of rows){const key=identity(entry);if(!expected.has(key))expected.set(key,[]);expected.get(key).push(entry);}
   const declared=new Set();for(const binding of pin.bindings){const url=new URL(binding.url);url.hostname=url.hostname.replace(/\.$/,'');url.hash='';const key=identity({...binding,urlSha256:digest(url.href)}),actual=expected.get(key);if(!actual)throw Error('Extra or changed declared binding');if(actual.some(entry=>entry.independentAllowed!==binding.independentAllowed))throw Error('Independent-custody flag differs');declared.add(key);}
   const registryArtifact=pin.bindings.length>0&&pin.bindings.every(binding=>binding.kind==='operator_registry_config'&&binding.independentAllowed===false&&binding.configurationSha256===pin.sha256&&binding.code.bytes===pin.bytes);
   if(registryArtifact){if(rows.some(entry=>entry.kind!=='operator_registry_config'||entry.independentAllowed||entry.configurationSha256!==pin.sha256||entry.code?.bytes!==pin.bytes))throw Error('Registry artifact proof differs');const selected=new Set(pin.bindings.map(descriptor));if(rows.some(entry=>selected.has(descriptor(entry))&&!declared.has(identity(entry))))throw Error('Partial registry descriptor family');return;}
   const families=new Map();for(const [key,actual] of expected){const entry=actual[0];if(entry.kind!=='operator_registry_config'){if(!declared.has(key))throw Error('Missing required non-registry binding');continue;}const family=descriptor(entry);if(!families.has(family))families.set(family,{config:entry.configurationSha256,keys:new Set(),urls:new Set()});families.get(family).keys.add(key);families.get(family).urls.add(entry.urlSha256);}
   const complete=[];for(const family of families.values()){const included=[...family.keys].filter(key=>declared.has(key)).length;if(included&&included!==family.keys.size)throw Error('Partial registry descriptor family');if(included)complete.push(family);}
   for(const family of families.values())if(![...family.keys].some(key=>declared.has(key))&&!complete.some(selected=>selected.config===family.config&&selected.urls.size===family.urls.size&&[...family.urls].every(url=>selected.urls.has(url))))throw Error('Missing non-equivalent registry family');
  };
  const check=pin=>{try{validateBindings(pin);}catch(error){blockers.push({code:'CONTENT_PROVENANCE_MISMATCH',path:pin.path,message:error.message});}};
  for(const pin of declarations.values())check(pin);for(const pin of stagePins)check(pin);
  const proposed=[];
  for(const control of controlRefs){
   const path=resolve(control.path),declared=externalMap.get(path);if(!declared||declared.sha256!==control.sha256){if(!proposeControls)blockers.push({code:'STAGING_CONTROL_INVENTORY_PIN_MISSING',...control});}
   if(control.role!=='corpus'){if(!declared||declared.sha256!==control.sha256)throw Error('Non-corpus control lacks independent inventory');proposed.push(declared);continue;}
   const rows=rowsFor(control);if(!rows.length||rows.some(entry=>entry.state!=='active'))throw Error('Corpus live bindings absent');
   const bindings=rows.map(entry=>{const url=urlMap.get(entry.urlSha256);if(!url)throw Error('Cannot recover witnessed URL: '+entry.urlSha256);const proof=entry.kind==='operator_registry_config'?{configurationSha256:entry.configurationSha256,schemaContractSha256:entry.schemaContractSha256,code:entry.code,approval:entry.approval}:{sourceSha256:entry.sourceSha256,observationId:entry.observationId,receiptSha256:entry.receiptSha256};return {...civic.ManagedSourceBindingSchema.parse({kind:entry.kind,url,...proof}),independentAllowed:entry.independentAllowed};});
   const pin=normalization.normalizePublicationPin({...control,path,bytes:corpusBytes.get(control.path).length,bindings});delete pin.role;delete pin.sourceId;check(pin);proposed.push(pin);
  }
  controlInventory=provenance.privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:proposed});
  const stagePaths=stagePins.map(pin=>pin.path),preparedPartition=partition.partitionPublicationInputs([...proposed,...stagePins],stagePaths),campaignBytes=await pinned(assembly.campaign),campaignBindings=normalization.normalizePublicationBindings(proposed.filter(pin=>campaign.sources.some(source=>resolve(source.corpus.path)===pin.path)).flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false})))),campaignPin={path:join(assembled?assembly.managedRoot:input.outputRoot,'campaign.json'),sha256:digest(campaignBytes),bytes:campaignBytes.length,bindings:campaignBindings};
  const committedPartition=partition.partitionPublicationInputs([...preparedPartition.primary,campaignPin,...preparedPartition.staging],stagePaths);
  const stageSizes={prepared:bounds.assertStep8ProvenanceSizes('prepared staging',partition.provenanceBytes(preparedPartition.primary).length,partition.provenanceBytes(preparedPartition.staging).length),committed:bounds.assertStep8ProvenanceSizes('committed staging',partition.provenanceBytes(committedPartition.primary).length,partition.provenanceBytes(committedPartition.staging).length)};
  const nativeBindings=[];let structuredReport;
  const db=witness.createCanonicalWitnessReadPool(pool?.options??{connectionString:process.env.DATABASE_URL});let client,committed=false;
  try{
   client=await db.connect();
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(fence.authority.mode!=='isolated-fixture')try{if(!input.structuredSelection)throw Error('Production requires an issued structured selection');const selection=await current.authenticateStep8StructuredSelection({selection:input.structuredSelection,runIds:input.structuredRunIds,readControl:pinned,requiredThrough,custody:{query:(sql,values)=>client.query(sql,values),readCas}});structuredReport=await precheckStructuredSelection({client,readCas,runIds:input.structuredRunIds,requiredThrough,policy:input.policy,core:await loadStructuredPrecheckCore(packageRoot),selection,expectedScopes:current.STEP8_STRUCTURED_SOURCE_SCOPES});}catch(error){blockers.push({code:'STRUCTURED_SELECTION_PRECHECK',message:error.message,report:error.report});}
   const rows=(await client.query("SELECT j.spec FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE r.run_id=ANY($1::uuid[]) AND r.receipt->>'step' IN ('structured_parse','structured_discover')",[input.structuredRunIds])).rows;
   for(const row of rows)for(const binding of row.spec.selector.sourceBindings??[])nativeBindings.push({...civic.ManagedSourceBindingSchema.parse(binding),independentAllowed:false});
   await client.query('COMMIT');committed=true;
  }finally{client?.release(committed?undefined:true);await db.end();}
  const policyProofs=new Map(),checkedPolicies=new Set(),proof=async hash=>{let value=policyProofs.get(hash);if(!value){value=await policyReceipt.loadPolicyReceipt({read:readCas},hash);policyProofs.set(hash,value);}return value;};
  for(const output of nativeOutputs){
   const run=JSON.parse((await readCas(output.runId)).toString('utf8')),inventory=JSON.parse((await readCas(output.policyInventory.sha256)).toString('utf8')),currentMap=inventory.currentAdmissionReceipts??{},hashes=new Set(Object.keys(currentMap));
   for(const step of run.queue.stepReceipts)if(step.spec.policyProofSha256)hashes.add(step.spec.policyProofSha256);
   for(const record of inventory.records)for(const receipt of record.receipts){hashes.add(receipt.receiptSha256);if(receipt.currentReceiptSha256&&currentMap[receipt.receiptSha256]!==receipt.currentReceiptSha256)throw Error('Pinned current policy mapping conflicts');}
   for(const hash of hashes){const currentHash=currentMap[hash]??hash,key=hash+':'+currentHash;if(checkedPolicies.has(key))continue;
    try{const original=await proof(hash),currentProof=await proof(currentHash);await policyReceipt.recheckPolicyReceipt(original,{...input.policy,evaluationAt:new Date().toISOString(),currentProof});witness.assertReconstructionPolicyExpiry(currentProof.expiresAt,requiredThrough);checkedPolicies.add(key);}
    catch(error){blockers.push({code:'NATIVE_POLICY_HORIZON',sourceSeal:output.runId,receiptSha256:hash,message:error.message});}
   }
  }
  const fixed=new Map();for(const output of nativeOutputs){const composition=JSON.parse((await readCas(output.compositionArtifactSha256)).toString('utf8'));for(const contribution of composition.contributions)for(const pin of Object.values(contribution.artifacts)){if(!pin)continue;const actual=declarations.get(resolve(pin.path));if(!actual||actual.sha256!==pin.sha256)throw Error('Composition input lacks exact native provenance');fixed.set(actual.path,actual);}}
  for(const pin of stagePins)fixed.set(pin.path,pin);for(const role of ['identityAssessments','regionalPolicyReceipts'])if(assembly[role]){const pin=externalMap.get(resolve(assembly[role].path));if(!pin)throw Error('Optional input missing');fixed.set(pin.path,pin);}
  const producers=paths=>normalization.normalizePublicationBindings(paths.flatMap(path=>{const pin=declarations.get(resolve(path));if(!pin)throw Error('Producer pin absent: '+path);return pin.bindings;}));
  const publicationBounds=bounds.step8PublicationProvenanceBounds({fixedInputs:[...fixed.values()],stagingPaths:stagePaths,outputRoot:input.outputRoot,textBindings:[...nativeMap.values()].flatMap(pin=>pin.bindings),nativeBindings,registryBindings:producers([assembly.registry.path]),identityBindings:assembly.identityAssessments?producers([assembly.identityAssessments.path]):[],criticalBindings:assembly.criticalAssessments?producers([assembly.criticalAssessments.path]):[]});
  if(!publicationBounds.pass)blockers.push({code:'PUBLICATION_PROVENANCE_SIZE_BOUND',...publicationBounds});
  for(const pin of controlsRead.values())await pinned(pin);
  report={schemaVersion:'stadtstack-r1-step8-publication-precheck-v1',status:blockers.length?'blocked':'static_controls_covered',readOnly:true,writes:[],network:false,providers:false,canonicalPasses:0,input:inputPin,processingCommit:input.currentGeneration.processingCommit,nativeSealCount:frame.seals.length,nativeInventories,inventoryInputCount:declarations.size,requiredControlCount:controlRefs.length,retainedCopiesVerified:stagePins.length,structured:structuredReport,requiredThrough:new Date(requiredThrough).toISOString(),inventoryEpoch:fence.inventorySha256,reads:[...controlsRead.values()],stageSizes,publicationBounds,controlInventory:{sha256:digest(Buffer.from(adapter.canonicalJson(controlInventory))),bytes:Buffer.byteLength(adapter.canonicalJson(controlInventory)),inputs:controlInventory.inputs.length},blockers,limitations:['Early refusal only; canonical native reconstruction and every unchanged Core publication/replay/loader/quality gate remain mandatory.','Exact fixed metadata and full producer bindings are inspected under the lock-free authority/segment/objection epoch fence.','Generated hash widths and artifact byte-length codec bounds give a conservative wire-size bound; no generated pin is issued.','Original corpus paths and historical release/out trees are unchanged; a proposed control inventory is an unissued private draft, not authority.'],normalizedInputSha256:adapter.semanticHash(input),managedReads:[...managedReads.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),inventoryFiles:[{path:join(state,'inventory.json'),sha256:fence.inventorySha256,bytes:manifestBytes.length},...(hot.storage?.segments??[]).map(pin=>({path:join(state,'inventory-segments',pin.sha256+'.json'),sha256:pin.sha256,bytes:pin.bytes}))],database:{readOnly:true,tables:['district_pipeline.jobs','district_pipeline.step_receipts'],runIds:input.structuredRunIds}};;
 }finally{await fence.finish();}
 return {report,controlInventory};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [path,sha256,flag]=process.argv.slice(2);if(!path||!sha256||!/^[a-f0-9]{64}$/.test(sha256)||process.argv.length>5||flag!==undefined&&flag!=='--emit-control-inventory')throw Error('Usage: r1-step8-precheck.mjs INPUT SHA256 [--emit-control-inventory]');
 const bytes=await readFile(path);if(digest(bytes)!==sha256)throw Error('Operator input digest mismatch');const {report,controlInventory}=await precheckStep8Publication(JSON.parse(bytes.toString('utf8')),{inputPin:{path:resolve(path),sha256},proposeControls:flag==='--emit-control-inventory'});
 if(flag){if(report.blockers.some(blocker=>!['STRUCTURED_SELECTION_PRECHECK','NATIVE_POLICY_HORIZON','NATIVE_SELECTION_HORIZON','IMPORT_DISPOSITION_HORIZON'].includes(blocker.code)))throw Error('Control proposal failed exact bindings or size checks');const {canonicalJson}=await load('district-adapter-contract.ts');process.stdout.write(canonicalJson(controlInventory));}
 else{console.log(JSON.stringify(report,null,2));if(report.blockers.length)process.exitCode=2;}
}
