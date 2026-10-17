import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Readable} from 'node:stream';
import {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,ScopeSchema,canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {DistrictExecutionHold,DistrictJobStore} from './district-jobs.ts';
import {DistrictDatabaseConnectionLost,guardDistrictPool,withDistrictDatabaseScope} from './district-database.ts';
import {assertManagedSourceReadable,withCivicPolicyShutdown} from './civic-opt-out.ts';
import {assessmentItemSchema} from './district-assessment.ts';
import {DistrictAssessmentBroker,assessmentEvidenceArtifactHashes,enqueueAssessmentB} from './district-assessment-broker.ts';
import {NATIVE_B_SELECTOR} from './district-b-native-model.ts';
import {PolicyReceiptSchema} from './district-policy-receipt.ts';
import {readOperatorRegistryInputPin} from './district-registry-config.ts';
import {persistOperatorRegistry} from './district-r1-state.ts';
import {formatR1Failure,parseR1RegistryArguments,registeredScope,type R1FailurePhase} from './district-r1.ts';

// Keep the acquisition CLI and its authenticated observation fingerprint immutable.
// This separate native-only surface reuses its registry, custody and failure gates.
export const NativeAssessmentBEnqueueManifestSchema=z.object({jobs:z.array(z.object({
 itemArtifactSha256:HashSchema,sourceScope:ScopeSchema,policyProofSha256:HashSchema,transport:z.literal('vm-omp'),
}).strict()).min(1).max(10000)}).strict();

export async function readNativeAssessmentBManifest(input:Readable,signal:AbortSignal){
 signal.throwIfAborted();
 const abort=()=>input.destroy(new DistrictDatabaseConnectionLost());
 signal.addEventListener('abort',abort,{once:true});
 let bytes=0;const chunks:Uint8Array[]=[];
 try{
  for await(const chunk of input){
   signal.throwIfAborted();const value=typeof chunk==='string'?Buffer.from(chunk):chunk as Uint8Array;
   bytes+=value.byteLength;if(bytes>4*1024*1024)throw Error('Operator manifest too large');chunks.push(value);
  }
  signal.throwIfAborted();return NativeAssessmentBEnqueueManifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 }finally{signal.removeEventListener('abort',abort);}
}

export async function districtR1AssessmentCli(argv=process.argv.slice(2),context:{phase:R1FailurePhase}={phase:'startup'}){
 return withDistrictDatabaseScope(database=>withCivicPolicyShutdown(async()=>{
  context.phase='startup';const [command,...rawArgs]=argv;
  if(command==='--help'||command==='help'){
   process.stdout.write(`Usage: district-r1-assessment-cli.ts enqueue-assessment-b --registry-config DESCRIPTOR_PATH --registry-config-sha256 HASH [bounded JSON stdin]\nNative B: vm-omp only, ${NATIVE_B_SELECTOR}; no model or transport fallback.\n`);return;
  }
  if(command!=='enqueue-assessment-b')throw Error('Unknown native assessment command');
  if(process.platform!=='linux')throw new DistrictExecutionHold('isolation_unavailable');
  const {registryPin,args}=parseR1RegistryArguments(rawArgs);
  if(args.length)throw Error('Native assessment enqueue requires only explicit registry configuration flags and bounded JSON stdin');
  const admitted=await readOperatorRegistryInputPin(registryPin,{}),registry=admitted.registry;
  if(!process.env.DATABASE_URL)throw Error('Database configuration required');
  const pool=guardDistrictPool(new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,statement_timeout:10000}));
  const store=new DistrictJobStore(pool),cas=new DistrictCas(join(dirname(fileURLToPath(import.meta.url)),'../cache/districts/cas'));
  try{
   context.phase='admission';await persistOperatorRegistry(store,cas,admitted);
   const manifest=await readNativeAssessmentBManifest(process.stdin,database.signal),broker=new DistrictAssessmentBroker(pool,cas),jobKeys:string[]=[];
   for(const job of manifest.jobs){
    database.signal.throwIfAborted();
    await assertManagedSourceReadable(join(cas.root,'sha256',job.itemArtifactSha256.slice(0,2),job.itemArtifactSha256));
    const item=assessmentItemSchema.parse(JSON.parse((await cas.read(job.itemArtifactSha256)).toString('utf8')));
    if(semanticHash(item)!==job.itemArtifactSha256||!item.sources.some(source=>source.admissionReceiptSha256===job.policyProofSha256))throw Error('Assessment item primary policy binding mismatch');
    const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(job.policyProofSha256)).toString('utf8')));
    if(semanticHash(proof.scope)!==semanticHash(job.sourceScope))throw Error('Assessment item registered scope mismatch');
    registeredScope(registry,job.sourceScope,registry.municipalities.find(city=>city.id===job.sourceScope.municipalityId)?.sources.find(source=>source.id===job.sourceScope.sourceId)?.url??'');
    for(const hash of assessmentEvidenceArtifactHashes(item))await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash));
    jobKeys.push(await enqueueAssessmentB(broker,job));
   }
   process.stdout.write(canonicalJson({jobKeys})+'\n');
  }finally{await pool.end();}
 },database.signal));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const context:{phase:R1FailurePhase}={phase:'startup'};
 districtR1AssessmentCli(process.argv.slice(2),context).catch(error=>{process.stderr.write(formatR1Failure(error,context.phase));process.exitCode=2;});
}
