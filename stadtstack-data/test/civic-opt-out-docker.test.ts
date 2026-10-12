import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,chmod,readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {withManagedSourceScratch,recoverManagedSourceScratch,recordHostOptOut,CivicPolicyStateError,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions,type ManagedSourceScratch} from '../src/civic-opt-out.ts';
import {ManagedDockerResourceSchema,type ManagedDockerResource} from '../src/civic-docker.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const source=Buffer.from('synthetic source, never an operational observation'),prompt='synthetic source-free system prompt';
const binding={kind:'http_observation' as const,url:'https://synthetic.example/document',sourceSha256:sha(source),observationId:'synthetic-observation',receiptSha256:sha('synthetic-receipt-binding')};
interface SyntheticCreate {
 Image:string;HostConfig:{Mounts:Array<{Type:string;Source:string;Target:string;ReadOnly:boolean;BindOptions:{Propagation:string}}>};
 [key:string]:unknown;
}
interface SyntheticContainer {Id:string;Name:string;Image:string;Config:Record<string,unknown>;HostConfig:SyntheticCreate['HostConfig'];State:{Running:boolean};Mounts:unknown[];NetworkSettings:{Networks:Record<string,unknown>}}
interface SyntheticContext {root:string;policy:CivicPolicyOptions;managedRoot:string;decisionId:typeof CIVIC_ACQUISITION_DECISION_ID;dispose():Promise<void>}
async function fixture(work:(context:SyntheticContext,socket:string,daemon:{value:SyntheticContainer|null;allowRemoval:boolean;deletes:number})=>Promise<void>){
 const context=await createCivicPolicyTestContext(),socket=join(context.root,'engine.sock');
 const daemon:{value:SyntheticContainer|null;allowRemoval:boolean;deletes:number}={value:null,allowRemoval:false,deletes:0};
 const server=createServer((request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/info'){response.end(JSON.stringify({ID:'synthetic-daemon'}));return;}
  if(request.method==='POST'&&request.url?.startsWith('/containers/create?')){
   const chunks:Buffer[]=[];request.on('data',(chunk:Buffer)=>chunks.push(chunk));request.on('end',()=>{
    const {HostConfig,...Config}=JSON.parse(Buffer.concat(chunks).toString()) as SyntheticCreate;
    daemon.value={Id:'a'.repeat(64),Name:'/'+new URL(request.url!,'http://synthetic').searchParams.get('name'),Image:Config.Image,Config,HostConfig,State:{Running:false},Mounts:HostConfig.Mounts.map(mount=>({Type:mount.Type,Source:mount.Source,Destination:mount.Target,RW:!mount.ReadOnly,Propagation:mount.BindOptions.Propagation})),NetworkSettings:{Networks:{}}};
    response.statusCode=201;response.end(JSON.stringify({Id:daemon.value.Id}));
   });return;
  }
  if(request.method==='GET'&&request.url?.endsWith('/json')){response.statusCode=daemon.value?200:404;response.end(JSON.stringify(daemon.value));return;}
  if(request.method==='DELETE'){daemon.deletes++;response.statusCode=daemon.allowRemoval?204:500;if(daemon.allowRemoval)daemon.value=null;response.end(daemon.allowRemoval?undefined:'{}');return;}
  response.statusCode=500;response.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(socket,resolve));await chmod(socket,0o600);
 try{await work(context,socket,daemon);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await context.dispose();}
}
async function writeControl(scope:ManagedSourceScratch){
 const directory=join(scope.directory,'control');await mkdir(directory,{mode:0o700});await writeFile(join(directory,'system-prompt.md'),prompt,{mode:0o444});await chmod(directory,0o755);
}
async function inventory(stateDir:string):Promise<{scratch:Array<{id:string;state:string;resources:ManagedDockerResource[]}>}>{
 const value=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 for(const lease of value.scratch)lease.resources=lease.resources.map((resource:unknown)=>ManagedDockerResourceSchema.parse(resource));
 return value;
}

test('recovery removes an inventoried leftover omp-b container before unlinking source scratch',async()=>fixture(async(context,socket,daemon)=>{
 let scratch='';
 await assert.rejects(withManagedSourceScratch(context.managedRoot,[binding],async scope=>{
  scratch=scope.directory;await scope.writeSource('source.txt',source);await writeControl(scope);
  const container=await scope.createContainer({profile:'omp-b',socketPath:socket,daemonId:'synthetic-daemon',imageId:'sha256:'+'b'.repeat(64),contractSha256:sha('synthetic-omp-contract'),controlSha256:sha(prompt),controlBytes:Buffer.byteLength(prompt)});
  assert.match(container.name,/^stadtstack-omp-b-/);
 },{...context.policy,decisionId:context.decisionId,kind:'artifacts',purpose:'artifact'}),error=>error instanceof CivicPolicyStateError&&error.code==='SCRATCH_CLEANUP_INCOMPLETE');
 assert.ok(daemon.value);assert.ok(daemon.deletes>0);assert.equal((await lstat(scratch)).isDirectory(),true);
 const pending=await inventory(context.policy.stateDir!);assert.equal(pending.scratch[0]!.state,'partial');
 const stored=pending.scratch[0]!.resources[0]!;assert.equal('profile' in stored?stored.profile:null,'omp-b');
 const blocked=await recoverManagedSourceScratch(context.policy);assert.equal(blocked.status,'partial');assert.ok(blocked.issues.some(issue=>issue.code==='daemon_resource_pending'));
 assert.equal((await readFile(join(scratch,'source.txt'))).equals(source),true);
 daemon.allowRemoval=true;
 const recovered=await recoverManagedSourceScratch(context.policy);assert.equal(recovered.status,'complete');assert.equal(recovered.recoveredLeases.length,1);assert.equal(daemon.value,null);
 await assert.rejects(lstat(scratch),{code:'ENOENT'});
 assert.equal((await inventory(context.policy.stateDir!)).scratch[0]!.resources[0]!.state,'removed');
}));

test('host objection purges the same leftover omp-b durable resource, with no second state store',async()=>fixture(async(context,socket,daemon)=>{
 let scratch='';
 await assert.rejects(withManagedSourceScratch(context.managedRoot,[binding],async scope=>{
  scratch=scope.directory;await scope.writeSource('source.txt',source);await writeControl(scope);
  await scope.createContainer({profile:'omp-b',socketPath:socket,daemonId:'synthetic-daemon',imageId:'sha256:'+'b'.repeat(64),contractSha256:sha('synthetic-omp-contract'),controlSha256:sha(prompt),controlBytes:Buffer.byteLength(prompt)});
 },{...context.policy,decisionId:context.decisionId,kind:'artifacts',purpose:'artifact'}));
 daemon.allowRemoval=true;
 const objection=await recordHostOptOut({host:'synthetic.example',reason:'rights_holder_objection'},context.policy);
 assert.equal(objection.purge.status,'purged');assert.equal(daemon.value,null);await assert.rejects(lstat(scratch),{code:'ENOENT'});
}));

test('parser resources preserve their implicit profile and use the same durable removal path',async()=>fixture(async(context,socket,daemon)=>{
 daemon.allowRemoval=true;
 await withManagedSourceScratch(context.managedRoot,[binding],async scope=>{
  const container=await scope.createContainer({socketPath:socket,imageId:'sha256:'+'b'.repeat(64),contractSha256:sha('synthetic-parser-contract'),artifactRelativePath:null});
  assert.match(container.name,/^stadtstack-parser-/);assert.ok(daemon.value);
  assert.equal(daemon.value.HostConfig.Mounts.length,0);
 },{...context.policy,decisionId:context.decisionId,kind:'artifacts',purpose:'document'});
 assert.equal(daemon.value,null);
 const stored=(await inventory(context.policy.stateDir!)).scratch[0]!.resources[0]!;
 assert.equal('profile' in stored,false);assert.equal(stored.state,'removed');
}));

test('omp-b control rejects extra files, changed prompt identity and unreviewed daemon before create',async()=>fixture(async(context,socket,daemon)=>{
 daemon.allowRemoval=true;
 await withManagedSourceScratch(context.managedRoot,[binding],async scope=>{
  await writeControl(scope);
  const spec={profile:'omp-b' as const,socketPath:socket,daemonId:'synthetic-daemon',imageId:'sha256:'+'b'.repeat(64),contractSha256:sha('synthetic-omp-contract'),controlSha256:sha(prompt),controlBytes:Buffer.byteLength(prompt)};
  await assert.rejects(scope.createContainer({...spec,controlSha256:sha('changed')}));assert.equal(daemon.value,null);
  await assert.rejects(scope.createContainer({...spec,daemonId:'another-daemon'}));assert.equal(daemon.value,null);
  await writeFile(join(scope.directory,'control','extra'),source,{mode:0o600});
  await assert.rejects(scope.createContainer(spec));assert.equal(daemon.value,null);
 },{...context.policy,decisionId:context.decisionId,kind:'artifacts',purpose:'artifact'});
}));
