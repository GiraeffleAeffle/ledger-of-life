import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {readFile,writeFile,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {withManagedSourceScratch,recoverManagedSourceScratch,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {dockerParserConfig} from '../src/civic-docker.ts';
import type {DockerParserResource} from '../src/civic-docker.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
interface FakeContainer {id:string;name:string;config:Record<string,unknown>;running:boolean;socket?:Duplex;waiters:ServerResponse[]}
async function fakeDaemon(path:string){
 const containers=new Map<string,FakeContainer>(),connections=new Set<Duplex>(),events:string[]=[];
 const settings={daemonId:'synthetic-local-engine',refuseDelete:false,omitDelete:false,failCreate:false,tamperLabels:false,onCreate:undefined as ((container:FakeContainer)=>Promise<void>)|undefined,onStart:undefined as ((container:FakeContainer)=>Promise<void>)|undefined,onDelete:undefined as ((container:FakeContainer)=>Promise<void>)|undefined};
 const send=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(value===null?'':JSON.stringify(value));};
 const find=(key:string)=>[...containers.values()].find(item=>item.id===key||item.name===key);
 const frame=(channel:number,text:string)=>{const bytes=Buffer.from(text),header=Buffer.alloc(8);header[0]=channel;header.writeUInt32BE(bytes.length,4);return Buffer.concat([header,bytes]);};
 const finish=(container:FakeContainer,code:number)=>{container.running=false;for(const res of container.waiters.splice(0))send(res,200,{StatusCode:code});};
 const server=createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url!,'http://unix'),chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),body=bytes.length?JSON.parse(bytes.toString('utf8')):null;
  if(req.method==='GET'&&url.pathname==='/info'){send(res,200,{ID:settings.daemonId});return;}
  if(req.method==='POST'&&url.pathname==='/containers/create'){
   events.push('create');if(settings.failCreate){send(res,500,{Message:'Synthetic unavailable create outcome'});return;}
   const name=url.searchParams.get('name')!,container:FakeContainer={name,id:digest(name),config:body,running:false,waiters:[]};containers.set(name,container);await settings.onCreate?.(container);if(!res.destroyed)send(res,201,{Id:container.id});return;
  }
  const match=/^\/containers\/([^/]+)(?:\/(json|start|wait|attach))?$/.exec(url.pathname);if(!match){send(res,404,{});return;}
  const container=find(decodeURIComponent(match[1]));if(!container){send(res,404,{});return;}
  if(req.method==='GET'&&match[2]==='json'){
   const host=container.config.HostConfig as Record<string,unknown>,labels={...(container.config.Labels as Record<string,string>)};if(settings.tamperLabels)labels['org.stadtstack.nonce']='foreign-container';
   const mounts=(host.Mounts as Array<Record<string,unknown>>).map(item=>({Type:item.Type,Source:item.Source,Destination:item.Target,RW:false,Propagation:'rprivate'}));
   send(res,200,{Id:container.id,Name:'/'+container.name,Image:container.config.Image,Config:{...container.config,Labels:labels},HostConfig:host,State:{Running:container.running},Mounts:mounts,NetworkSettings:{Networks:{none:{}}}});return;
  }
  if(req.method==='POST'&&match[2]==='start'){
   events.push('start');assert.ok(container.socket,'attach must precede start');await settings.onStart?.(container);container.running=true;const ready=frame(1,'{"ready":true}\n');container.socket!.write(ready.subarray(0,3));container.socket!.write(ready.subarray(3));send(res,204,null);return;
  }
  if(req.method==='POST'&&match[2]==='wait'){if(container.running)container.waiters.push(res);else send(res,200,{StatusCode:0});return;}
  if(req.method==='DELETE'&&!match[2]){
   events.push('delete');await settings.onDelete?.(container);if(settings.refuseDelete){send(res,503,{Message:'Synthetic daemon unavailable'});return;}
   if(!settings.omitDelete){finish(container,137);container.socket?.destroy();containers.delete(container.name);}send(res,204,null);return;
  }
  send(res,404,{});
 })().catch(()=>send(res,500,{Message:'Synthetic protocol failure'}));});
 server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
 server.on('upgrade',(req,socket,head)=>{
  const match=/^\/containers\/([^/]+)\/attach/.exec(req.url??''),container=match?find(decodeURIComponent(match[1])):undefined;
  if(!container||head.length){socket.destroy();return;}events.push('attach');container.socket=socket;socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  socket.on('data',()=>{});socket.on('end',()=>{container.socket?.write(frame(2,'synthetic diagnostic\n'));container.socket?.write(frame(1,'{"ok":true}\n'));finish(container,0);container.socket?.end();});socket.on('error',()=>{});
 });
 const listening=Promise.withResolvers<void>();server.once('error',listening.reject);server.listen(path,listening.resolve);await listening.promise;await chmod(path,0o600);
 return {containers,settings,events,async close(){for(const socket of connections)socket.destroy();const closed=Promise.withResolvers<void>();server.close(error=>error?closed.reject(error):closed.resolve());await closed.promise;}};
}

test('Docker name is reserved before create, CID committed before start, attach is lossless, removal precedes scratch unlink',async()=>{
 const fixture=await createCivicPolicyTestContext(),daemon=await fakeDaemon(join(fixture.root,'d.sock')),bytes=Buffer.from('synthetic parser input');let directory='';
 try{
  daemon.settings.onCreate=async container=>{const inventory=JSON.parse(await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8')),resource=inventory.scratch[0].resources[0];assert.equal(resource.name,container.name);assert.equal(resource.state,'create_requested');assert.equal(resource.containerId,null);};
  daemon.settings.onStart=async container=>{const inventory=JSON.parse(await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8')),resource=inventory.scratch[0].resources[0];assert.equal(resource.containerId,container.id);assert.equal(resource.state,'start_requested');};
  daemon.settings.onDelete=async()=>{assert.equal((await lstat(join(directory,'document'))).isFile(),true);};
  await withManagedSourceScratch(fixture.managedRoot,[{phase:'pre-admission',url:'https://parser-fixture.invalid/input',sourceSha256:digest(bytes)}],async scope=>{
   directory=scope.directory;await scope.writeSource('document',bytes);await chmod(join(directory,'document'),0o444);
   const container=await scope.createContainer({socketPath:join(fixture.root,'d.sock'),imageId:'sha256:'+'a'.repeat(64),contractSha256:'b'.repeat(64),artifactRelativePath:'document'}),session=await container.start();let stdout='',stderr='';
   session.stdout.setEncoding('utf8');session.stderr.setEncoding('utf8');session.stdout.on('data',chunk=>{stdout+=chunk;});session.stderr.on('data',chunk=>{stderr+=chunk;});session.stdin.end('{}\n');
   assert.deepEqual(await session.completion,{exitCode:0});assert.deepEqual(await container.wait(),{exitCode:0});assert.match(stdout,/"ready":true/);assert.match(stdout,/"ok":true/);assert.match(stderr,/synthetic diagnostic/);await container.remove();
  },{decisionId:fixture.decisionId,purpose:'classification',...fixture.policy});
  assert.deepEqual(daemon.events.slice(0,3),['create','attach','start']);assert.equal(daemon.containers.size,0);await assert.rejects(lstat(directory),{code:'ENOENT'});
 }finally{await daemon.close();await fixture.dispose();}
});

test('unconfirmed daemon removal retains mounted source bytes and reports partial until actual removal is confirmed',async()=>{
 const fixture=await createCivicPolicyTestContext(),daemon=await fakeDaemon(join(fixture.root,'d.sock')),bytes=Buffer.from('held source');let directory='';
 try{
  daemon.settings.omitDelete=true;
  await assert.rejects(withManagedSourceScratch(fixture.managedRoot,[{phase:'pre-admission',url:'https://parser-fixture.invalid/input',sourceSha256:digest(bytes)}],async scope=>{
   directory=scope.directory;await scope.writeSource('document',bytes);await chmod(join(directory,'document'),0o444);await scope.createContainer({socketPath:join(fixture.root,'d.sock'),imageId:'sha256:'+'a'.repeat(64),contractSha256:'b'.repeat(64),artifactRelativePath:'document'});
  },{decisionId:fixture.decisionId,purpose:'classification',...fixture.policy}),CivicPolicyStateError);
  assert.equal(daemon.containers.size,1);assert.deepEqual(await readFile(join(directory,'document')),bytes);
  const partial=await recoverManagedSourceScratch(fixture.policy);assert.equal(partial.status,'partial');assert.ok(partial.issues.some(issue=>issue.code==='daemon_resource_pending'));assert.equal(partial.deletedFiles,0);
  daemon.settings.omitDelete=false;const recovered=await recoverManagedSourceScratch(fixture.policy);assert.equal(recovered.status,'complete');assert.equal(daemon.containers.size,0);await assert.rejects(lstat(directory),{code:'ENOENT'});
 }finally{daemon.settings.omitDelete=false;await recoverManagedSourceScratch(fixture.policy).catch(()=>{});await daemon.close();await fixture.dispose();}
});

test('daemon identity and nonce changes cannot redirect cleanup to an unrelated container',async()=>{
 const fixture=await createCivicPolicyTestContext(),daemon=await fakeDaemon(join(fixture.root,'d.sock'));let directory='';
 try{
  await assert.rejects(withManagedSourceScratch(fixture.managedRoot,[{phase:'pre-admission',url:'https://parser-fixture.invalid/input',sourceSha256:digest('source')}],async scope=>{
   directory=scope.directory;await scope.createContainer({socketPath:join(fixture.root,'d.sock'),imageId:'sha256:'+'a'.repeat(64),contractSha256:'b'.repeat(64),artifactRelativePath:null});daemon.settings.tamperLabels=true;
  },{decisionId:fixture.decisionId,purpose:'classification',...fixture.policy}),CivicPolicyStateError);
  assert.equal(daemon.events.includes('delete'),false);assert.equal((await lstat(directory)).isDirectory(),true);
  daemon.settings.tamperLabels=false;daemon.settings.daemonId='different-engine';assert.equal((await recoverManagedSourceScratch(fixture.policy)).status,'partial');assert.equal(daemon.events.includes('delete'),false);
  daemon.settings.daemonId='synthetic-local-engine';assert.equal((await recoverManagedSourceScratch(fixture.policy)).status,'complete');
 }finally{daemon.settings.tamperLabels=false;daemon.settings.daemonId='synthetic-local-engine';await recoverManagedSourceScratch(fixture.policy).catch(()=>{});await daemon.close();await fixture.dispose();}
});

test('worker death after daemon create but before CID receipt is recovered by the reserved name',async()=>{
 const fixture=await createCivicPolicyTestContext(),daemon=await fakeDaemon(join(fixture.root,'d.sock'));let worker:ChildProcess|undefined;
 try{
  daemon.settings.onCreate=async()=>{worker!.kill('SIGKILL');};
  const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href,script=`import {withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};import {createHash} from 'node:crypto';const [root,policy,socketPath]=process.argv.slice(1);await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://parser-fixture.invalid/input',sourceSha256:createHash('sha256').update('source').digest('hex')}],async scope=>{await scope.createContainer({socketPath,imageId:'sha256:'+'a'.repeat(64),contractSha256:'b'.repeat(64),artifactRelativePath:null});},{...JSON.parse(policy),decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification'});`;
  worker=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,fixture.managedRoot,JSON.stringify(fixture.policy),join(fixture.root,'d.sock')],{stdio:'ignore'});
  const exited=Promise.withResolvers<void>();worker.once('error',exited.reject);worker.once('close',()=>exited.resolve());await exited.promise;
  const inventory=JSON.parse(await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8')),resource=inventory.scratch[0].resources[0];assert.equal(resource.state,'create_requested');assert.equal(resource.containerId,null);assert.equal(daemon.containers.size,1);
  daemon.settings.onCreate=undefined;assert.equal((await recoverManagedSourceScratch(fixture.policy)).status,'complete');assert.equal(daemon.containers.size,0);
 }finally{worker?.kill('SIGKILL');daemon.settings.onCreate=undefined;await recoverManagedSourceScratch(fixture.policy).catch(()=>{});await daemon.close();await fixture.dispose();}
});

test('unknown create outcomes cannot be declared absent while a late daemon create is still possible',async()=>{
 const fixture=await createCivicPolicyTestContext(),daemon=await fakeDaemon(join(fixture.root,'d.sock'));let directory='';
 try{
  daemon.settings.failCreate=true;
  await assert.rejects(withManagedSourceScratch(fixture.managedRoot,[{phase:'pre-admission',url:'https://parser-fixture.invalid/input',sourceSha256:digest('source')}],async scope=>{directory=scope.directory;await scope.createContainer({socketPath:join(fixture.root,'d.sock'),imageId:'sha256:'+'a'.repeat(64),contractSha256:'b'.repeat(64),artifactRelativePath:null});},{decisionId:fixture.decisionId,purpose:'classification',...fixture.policy}),CivicPolicyStateError);
  assert.equal((await recoverManagedSourceScratch(fixture.policy)).status,'partial');assert.equal((await lstat(directory)).isDirectory(),true);
  const inventory=JSON.parse(await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8')),resource=inventory.scratch[0].resources[0] as DockerParserResource;
  daemon.settings.failCreate=false;daemon.containers.set(resource.name,{name:resource.name,id:digest(resource.name),config:dockerParserConfig(resource,directory),running:false,waiters:[]});
  assert.equal((await recoverManagedSourceScratch(fixture.policy)).status,'complete');
 }finally{daemon.settings.failCreate=false;await recoverManagedSourceScratch(fixture.policy).catch(()=>{});await daemon.close();await fixture.dispose();}
});
