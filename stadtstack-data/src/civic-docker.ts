import {request} from 'node:http';
import {lstat,realpath} from 'node:fs/promises';
import {resolve,join,parse,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {PassThrough,Writable} from 'node:stream';
import type {Readable,Duplex} from 'node:stream';
import {z} from 'zod';
import {PARSER_PROCESS,OMP_PROCESS} from './district-execution-profile.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const DockerParserResourceSchema=z.object({
 id:z.string().uuid(),scratchId:z.string().uuid(),rootId:hex,authoritySha256:hex,nonce:z.string().uuid(),name:z.string().regex(/^stadtstack-parser-[a-f0-9-]{36}-[a-f0-9-]{36}$/),
 socketPath:z.string().min(1).max(4096),daemonId:z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),imageId:image,contractSha256:hex,
 artifactRelativePath:z.literal('document').nullable(),artifactSha256:hex.nullable(),artifactBytes:z.number().int().nonnegative().max(64*1024*1024).nullable(),configSha256:hex,containerId:hex.nullable(),state:z.enum(['reserved','create_requested','created','start_requested','removed','uncertain']),
}).strict();
export type DockerParserResource=z.infer<typeof DockerParserResourceSchema>;
// Parser records retain their original closed schema; only omp-b records carry
// the explicit discriminator and source-free control-file identity.
export const DockerOmpBResourceSchema=DockerParserResourceSchema.extend({
 profile:z.literal('omp-b'),name:z.string().regex(/^stadtstack-omp-b-[a-f0-9-]{36}-[a-f0-9-]{36}$/),
 artifactRelativePath:z.null(),artifactSha256:z.null(),artifactBytes:z.null(),
 controlSha256:hex,controlBytes:z.number().int().positive().max(65536),
}).strict();
export const ManagedDockerResourceSchema=z.union([DockerParserResourceSchema,DockerOmpBResourceSchema]);
export type ManagedDockerResource=z.infer<typeof ManagedDockerResourceSchema>;
export type ManagedDockerIdentity=DockerParserIdentity|(DockerParserIdentity&{profile:'omp-b';controlSha256:string;controlBytes:number});
export type DockerParserIdentity=Pick<DockerParserResource,'id'|'scratchId'|'rootId'|'authoritySha256'|'nonce'|'name'|'imageId'|'contractSha256'|'artifactRelativePath'|'artifactSha256'|'artifactBytes'>;
export type ManagedDockerOptions=
 |{profile?:'parser';socketPath:string;imageId:string;contractSha256:string;artifactRelativePath:'document'|null}
 |{profile:'omp-b';socketPath:string;daemonId:string;imageId:string;contractSha256:string;controlSha256:string;controlBytes:number};
export interface DockerAttach {stdin:Writable;stdout:Readable;stderr:Readable;failure:Promise<never>;ended:Promise<void>;close():void}
export class DockerLifecycleError extends Error {
 readonly code:string;
 constructor(code:string){super('Managed Docker resource requires operator review');this.name='DockerLifecycleError';this.code=code;}
}
const labels=(resource:DockerParserIdentity)=>({'org.stadtstack.scratch':resource.scratchId,'org.stadtstack.resource':resource.id,'org.stadtstack.nonce':resource.nonce,'org.stadtstack.root':resource.rootId,'org.stadtstack.authority':resource.authoritySha256,'org.stadtstack.contract':resource.contractSha256,'org.stadtstack.input':resource.artifactSha256??'stdin-only','org.stadtstack.input-bytes':String(resource.artifactBytes??0)});
function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',')+'}';return JSON.stringify(value);
}
export function dockerParserConfig(resource:DockerParserIdentity,scratchDirectory:string){
 return {
  Image:resource.imageId,...PARSER_PROCESS,OpenStdin:true,StdinOnce:true,Tty:false,AttachStdin:true,AttachStdout:true,AttachStderr:true,StopTimeout:1,Labels:labels(resource),
  HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',IpcMode:'none',Privileged:false,AutoRemove:false,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges'],Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:32,
   Ulimits:[{Name:'cpu',Soft:120,Hard:120},{Name:'nofile',Soft:64,Hard:64},{Name:'nproc',Soft:32,Hard:32},{Name:'fsize',Soft:33554432,Hard:33554432},{Name:'core',Soft:0,Hard:0}],LogConfig:{Type:'none',Config:{}},
   Tmpfs:{'/scratch':'rw,noexec,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700'},
   Mounts:resource.artifactRelativePath?[{Type:'bind',Source:join(scratchDirectory,'document'),Target:'/input/document',ReadOnly:true,BindOptions:{Propagation:'rprivate'}}]:[],
  },
 };
}
export function dockerOmpBConfig(resource:DockerParserIdentity&{profile:'omp-b';controlSha256:string;controlBytes:number},scratchDirectory:string){
 return {
  Image:resource.imageId,...OMP_PROCESS,OpenStdin:true,StdinOnce:true,Tty:false,AttachStdin:true,AttachStdout:true,AttachStderr:true,StopTimeout:1,
  Labels:{...labels(resource),'org.stadtstack.profile':'omp-b','org.stadtstack.control':resource.controlSha256,'org.stadtstack.control-bytes':String(resource.controlBytes)},
  HostConfig:{ReadonlyRootfs:true,NetworkMode:'bridge',IpcMode:'none',Privileged:false,AutoRemove:false,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges:true'],Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:32,
   Ulimits:[{Name:'nofile',Soft:64,Hard:64},{Name:'nproc',Soft:32,Hard:32},{Name:'fsize',Soft:33554432,Hard:33554432},{Name:'core',Soft:0,Hard:0}],LogConfig:{Type:'none',Config:{}},
   Tmpfs:Object.fromEntries(['/home/omp','/tmp','/work'].map(path=>[path,'rw,noexec,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700'])),
   Mounts:[{Type:'bind',Source:join(scratchDirectory,'control'),Target:'/control',ReadOnly:true,BindOptions:{Propagation:'rprivate'}}],
  },
 };
}
export function managedDockerConfig(resource:ManagedDockerIdentity,scratchDirectory:string){
 return 'profile' in resource?dockerOmpBConfig(resource,scratchDirectory):dockerParserConfig(resource,scratchDirectory);
}
export function dockerConfigSha256(resource:ManagedDockerIdentity,scratchDirectory:string):string{return hash(stable(managedDockerConfig(resource,scratchDirectory)));}
/** Resolve an explicitly selected LOCAL Unix socket, never DOCKER_HOST or TCP. */
export async function canonicalDockerSocket(input:string,fixtureRoot?:string):Promise<string>{
 if(!isAbsolute(input)||input.includes('\0')||input.split('/').some(part=>part==='..'))throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');
 const initial=await lstat(input);if(initial.isSymbolicLink()||!initial.isSocket())throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');
 const path=await realpath(input);
 if(fixtureRoot){const child=relative(resolve(fixtureRoot),path);if(!child||child==='..'||child.startsWith('../')||isAbsolute(child))throw new DockerLifecycleError('DOCKER_FIXTURE_SOCKET_REQUIRED');}
 else if(!/^\/run\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/.test(path))throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');
 let current=parse(path).root;
 for(const component of path.slice(current.length).split('/').filter(Boolean)){
  current=join(current,component);const stat=await lstat(current);
  if(stat.isSymbolicLink()||stat.uid!==0&&stat.uid!==process.getuid?.())throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');
  if(current===path){if(!stat.isSocket()||stat.nlink!==1||(stat.mode&0o002)!==0)throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');}
  else if(!stat.isDirectory()||(stat.mode&0o022)!==0&&(stat.mode&0o1000)===0)throw new DockerLifecycleError('DOCKER_SOCKET_UNSAFE');
 }
 return path;
}
interface EngineResponse {status:number;value:unknown}
async function engine(socketPath:string,method:string,path:string,body?:unknown,timeoutMs=30_000,signal?:AbortSignal):Promise<EngineResponse>{
 const encoded=body===undefined?undefined:JSON.stringify(body);if(encoded!==undefined&&Buffer.byteLength(encoded)>65536)throw new DockerLifecycleError('DOCKER_REQUEST_BOUND');
 const {promise,resolve,reject}=Promise.withResolvers<EngineResponse>();let timer:NodeJS.Timeout|undefined;
 const fail=()=>{clearTimeout(timer);reject(new DockerLifecycleError('DOCKER_UNAVAILABLE'));};
 const req=request({socketPath,method,path,signal,headers:encoded===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}},response=>{
  const chunks:Buffer[]=[];let bytes=0;
  response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){response.destroy();req.destroy();fail();}else chunks.push(chunk);});
  response.on('error',fail);response.on('end',()=>{clearTimeout(timer);try{const data=Buffer.concat(chunks,bytes);resolve({status:response.statusCode??0,value:data.length?JSON.parse(data.toString('utf8')):null});}catch{fail();}});
 });
 timer=setTimeout(()=>{req.destroy();fail();},timeoutMs);req.on('error',fail);req.end(encoded);return promise;
}
export async function dockerDaemonIdentity(socketPath:string,signal?:AbortSignal):Promise<string>{
 const result=await engine(socketPath,'GET','/info',undefined,30_000,signal);
 if(result.status!==200)throw new DockerLifecycleError('DOCKER_UNAVAILABLE');
 return z.object({ID:z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/)}).parse(result.value).ID;
}
async function sameDaemon(resource:ManagedDockerResource,fixtureRoot?:string,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();if(await canonicalDockerSocket(resource.socketPath,fixtureRoot)!==resource.socketPath||await dockerDaemonIdentity(resource.socketPath,signal)!==resource.daemonId)throw new DockerLifecycleError('DOCKER_DAEMON_CHANGED');
}
const inspectSchema=z.object({Id:hex,Name:z.string(),Image:image,Config:z.record(z.string(),z.unknown()),HostConfig:z.record(z.string(),z.unknown()),State:z.object({Running:z.boolean()}).passthrough(),Mounts:z.array(z.record(z.string(),z.unknown())).optional(),NetworkSettings:z.object({Networks:z.record(z.string(),z.unknown()).optional()}).passthrough().optional()}).passthrough();
export async function inspectManagedDocker(resource:ManagedDockerResource,scratchDirectory:string,fixtureRoot?:string):Promise<{id:string;running:boolean}|null>{
 await sameDaemon(resource,fixtureRoot);const result=await engine(resource.socketPath,'GET','/containers/'+encodeURIComponent(resource.name)+'/json');
 if(result.status===404)return null;if(result.status!==200)throw new DockerLifecycleError('DOCKER_INSPECTION_FAILED');
 const value=inspectSchema.parse(result.value),expected=managedDockerConfig(resource,scratchDirectory),omp='profile' in resource;
 if(value.Name!=='/'+resource.name||value.Image!==resource.imageId||resource.containerId!==null&&value.Id!==resource.containerId||resource.configSha256!==dockerConfigSha256(resource,scratchDirectory))throw new DockerLifecycleError('DOCKER_IDENTITY_MISMATCH');
 const actualLabels=z.record(z.string(),z.string()).parse(value.Config.Labels);
 for(const [key,expectedValue] of Object.entries(expected.Labels))if(actualLabels[key]!==expectedValue)throw new DockerLifecycleError('DOCKER_IDENTITY_MISMATCH');
 for(const key of ['User','WorkingDir','OpenStdin','StdinOnce','Tty','AttachStdin','AttachStdout','AttachStderr','Entrypoint','Cmd'] as const)if(stable(value.Config[key])!==stable(expected[key]))throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 if(omp&&(value.Config.Image!==resource.imageId||!('Env' in expected)||stable(value.Config.Env)!==stable(expected.Env)||stable(actualLabels)!==stable(expected.Labels)))throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 // Inspect may include image/default fields; every explicitly constrained field
 // and every mount/security expansion is nevertheless checked, never trusted by name.
 for(const [key,expectedValue] of Object.entries(expected.HostConfig)){
  const actual=value.HostConfig[key];
  if(key==='CapAdd'&&(actual===null||actual===undefined))continue;
  if(key==='Mounts'&&expected.HostConfig.Mounts.length===0&&(actual===null||actual===undefined))continue;
  if(stable(actual)!==stable(expectedValue))throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 }
 for(const key of ['Binds','Devices','DeviceRequests','VolumesFrom','Links','PortBindings']){const valueAt=value.HostConfig[key];if(valueAt!==null&&valueAt!==undefined&&stable(valueAt)!=='[]'&&stable(valueAt)!=='{}')throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');}
 for(const key of ['PidMode','UTSMode'])if(value.HostConfig[key]!==undefined&&value.HostConfig[key]!=='')throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 if(omp){
  for(const key of ['Volumes','ExposedPorts','Healthcheck','OnBuild']){const field=value.Config[key];if(field!==null&&field!==undefined&&stable(field)!=='{}'&&stable(field)!=='[]')throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');}
 }
 const mounts=value.Mounts??[],tmpfsPaths=Object.keys(expected.HostConfig.Tmpfs);
 for(const mount of mounts){
  if(mount.Type==='tmpfs'&&typeof mount.Destination==='string'&&tmpfsPaths.includes(mount.Destination))continue;
  const bind=expected.HostConfig.Mounts[0];
  if(!bind||mount.Type!=='bind'||mount.Source!==bind.Source||mount.Destination!==bind.Target||mount.RW!==false||mount.Propagation!=='rprivate')throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 }
 if(mounts.filter(mount=>mount.Type==='bind').length!==expected.HostConfig.Mounts.length)throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 if(omp&&tmpfsPaths.some(path=>mounts.filter(mount=>mount.Type==='tmpfs'&&mount.Destination===path).length>1))throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 const networks=Object.keys(value.NetworkSettings?.Networks??{});
 if(networks.some(name=>name!==expected.HostConfig.NetworkMode)||omp&&value.State.Running&&(networks.length!==1||networks[0]!=='bridge'))throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 if((omp||value.Config.StopTimeout!==undefined)&&value.Config.StopTimeout!==1)throw new DockerLifecycleError('DOCKER_CONTRACT_MISMATCH');
 return {id:value.Id,running:value.State.Running};
}
export async function createManagedDocker(resource:ManagedDockerResource,scratchDirectory:string,fixtureRoot?:string):Promise<string>{
 await sameDaemon(resource,fixtureRoot);
 const result=await engine(resource.socketPath,'POST','/containers/create?name='+encodeURIComponent(resource.name),managedDockerConfig(resource,scratchDirectory));
 if(result.status!==201)throw new DockerLifecycleError('DOCKER_CREATE_UNCERTAIN');
 const id=z.object({Id:hex}).passthrough().parse(result.value).Id,inspected=await inspectManagedDocker({...resource,containerId:id},scratchDirectory,fixtureRoot);
 if(!inspected||inspected.running)throw new DockerLifecycleError('DOCKER_CREATE_UNCERTAIN');return id;
}
/** Cleanup is independent of host-abort signals but not of daemon/ownership proof. */
export async function removeManagedDocker(resource:ManagedDockerResource,scratchDirectory:string,fixtureRoot?:string):Promise<void>{
 const observed=await inspectManagedDocker(resource,scratchDirectory,fixtureRoot);
 if(!observed){if(resource.containerId===null&&resource.state!=='reserved'&&resource.state!=='removed')throw new DockerLifecycleError('DOCKER_CREATE_OUTCOME_UNCONFIRMED');return;}
 const result=await engine(resource.socketPath,'DELETE','/containers/'+encodeURIComponent(observed.id)+'?force=1&v=1');
 if(result.status!==204&&result.status!==404)throw new DockerLifecycleError('DOCKER_REMOVAL_UNCONFIRMED');
 if(await inspectManagedDocker({...resource,containerId:observed.id},scratchDirectory,fixtureRoot))throw new DockerLifecycleError('DOCKER_REMOVAL_UNCONFIRMED');
}
export async function startManagedDocker(resource:ManagedDockerResource,scratchDirectory:string,fixtureRoot?:string):Promise<void>{
 const observed=await inspectManagedDocker(resource,scratchDirectory,fixtureRoot);if(!observed||!resource.containerId||observed.running)throw new DockerLifecycleError('DOCKER_START_REJECTED');
 const result=await engine(resource.socketPath,'POST','/containers/'+resource.containerId+'/start');if(result.status!==204)throw new DockerLifecycleError('DOCKER_START_UNCERTAIN');
}
export async function waitManagedDocker(resource:ManagedDockerResource,fixtureRoot?:string,signal?:AbortSignal):Promise<{exitCode:number}>{
 await sameDaemon(resource,fixtureRoot,signal);if(!resource.containerId)throw new DockerLifecycleError('DOCKER_IDENTITY_MISMATCH');
 const result=await engine(resource.socketPath,'POST','/containers/'+resource.containerId+'/wait?condition=not-running',undefined,'profile' in resource?245_000:185_000,signal);
 if(result.status!==200)throw new DockerLifecycleError('DOCKER_WAIT_UNAVAILABLE');
 const value=z.object({StatusCode:z.number().int().min(0).max(255),Error:z.object({Message:z.string()}).nullable().optional()}).parse(result.value);if(value.Error?.Message)throw new DockerLifecycleError('DOCKER_WAIT_FAILED');return {exitCode:value.StatusCode};
}
/** Non-TTY attach is opened before start. Payloads remain streams, never audit data. */
export async function attachManagedDocker(resource:ManagedDockerResource,scratchDirectory:string,fixtureRoot?:string):Promise<DockerAttach>{
 const observed=await inspectManagedDocker(resource,scratchDirectory,fixtureRoot);if(!observed||!resource.containerId)throw new DockerLifecycleError('DOCKER_IDENTITY_MISMATCH');
 const {promise,resolve,reject}=Promise.withResolvers<DockerAttach>();
 const req=request({socketPath:resource.socketPath,method:'POST',path:'/containers/'+resource.containerId+'/attach?stream=1&stdin=1&stdout=1&stderr=1',headers:{connection:'Upgrade',upgrade:'tcp'}});let upgraded=false;
 const timer=setTimeout(()=>{req.destroy();reject(new DockerLifecycleError('DOCKER_ATTACH_UNAVAILABLE'));},30_000);
 req.on('error',()=>{clearTimeout(timer);if(!upgraded)reject(new DockerLifecycleError('DOCKER_ATTACH_UNAVAILABLE'));});req.on('response',response=>{clearTimeout(timer);response.resume();reject(new DockerLifecycleError('DOCKER_ATTACH_UNAVAILABLE'));});
 req.on('upgrade',(response,socket:Duplex,head:Buffer)=>{
  clearTimeout(timer);if(response.statusCode!==101){socket.destroy();reject(new DockerLifecycleError('DOCKER_ATTACH_UNAVAILABLE'));return;}upgraded=true;
  const stdout=new PassThrough({highWaterMark:65536}),stderr=new PassThrough({highWaterMark:65536}),failed=Promise.withResolvers<never>(),finished=Promise.withResolvers<void>(),blocked=new Set<PassThrough>();
  void failed.promise.catch(()=>{});void finished.promise.catch(()=>{});
  let closed=false,endedClean=false,inputBytes=0,outputBytes=0,headerBytes=0,remaining=0,channel=1;const header=Buffer.allocUnsafe(8);
  const fail=()=>{if(closed)return;closed=true;const error=new DockerLifecycleError('DOCKER_ATTACH_FAILED');failed.reject(error);finished.reject(error);socket.destroy();stdout.destroy(error);stderr.destroy(error);};
  stdout.on('error',()=>{});stderr.on('error',()=>{});
  const consume=(chunk:Buffer)=>{
   let offset=0;
   while(offset<chunk.length){
    if(remaining===0){const count=Math.min(8-headerBytes,chunk.length-offset);chunk.copy(header,headerBytes,offset,offset+count);headerBytes+=count;offset+=count;if(headerBytes!==8)continue;
     channel=header[0];remaining=header.readUInt32BE(4);headerBytes=0;if(![1,2].includes(channel)||header[1]||header[2]||header[3]||remaining>4*1024*1024){fail();return;}if(!remaining)continue;
    }
    const count=Math.min(remaining,chunk.length-offset);outputBytes+=count;if(outputBytes>512*1024*1024){fail();return;}
    const target=channel===1?stdout:stderr;
    if(!target.write(chunk.subarray(offset,offset+count))&&!blocked.has(target)){blocked.add(target);socket.pause();target.once('drain',()=>{blocked.delete(target);if(!closed&&!blocked.size)socket.resume();});}
    offset+=count;remaining-=count;
   }
  };
  socket.on('data',consume);socket.on('error',fail);socket.on('close',()=>{if(!closed&&!endedClean)fail();});socket.on('end',()=>{if(remaining||headerBytes){fail();return;}endedClean=true;stdout.end();stderr.end();finished.resolve();});
  const stdin=new Writable({write(chunk:Buffer,_encoding,callback){inputBytes+=chunk.length;if(closed||inputBytes>64*1024*1024){callback(new DockerLifecycleError('DOCKER_INPUT_BOUND'));fail();return;}socket.write(chunk,callback);},final(callback){socket.end();callback();},destroy(error,callback){if(error)fail();callback(error);}});stdin.on('error',()=>{});
  const attachment={stdin,stdout,stderr,failure:failed.promise,ended:finished.promise,close(){if(!endedClean)fail();closed=true;socket.destroy();stdin.destroy();stdout.destroy();stderr.destroy();}};
  resolve(attachment);if(head.length)consume(head);
 });req.end();return promise;
}
