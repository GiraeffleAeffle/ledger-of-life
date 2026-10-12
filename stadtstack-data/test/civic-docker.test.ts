import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,realpath,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DockerParserResourceSchema,DockerOmpBResourceSchema,ManagedDockerResourceSchema,dockerParserConfig,dockerOmpBConfig,managedDockerConfig,dockerConfigSha256,inspectManagedDocker,createManagedDocker,startManagedDocker,removeManagedDocker,DockerLifecycleError,type ManagedDockerResource} from '../src/civic-docker.ts';

interface SyntheticInspection {
 Id:string|null;Name:string;Image:string;
 Config:Record<string,unknown>&{Labels:Record<string,string>;Env:string[]};
 HostConfig:Record<string,unknown>&{NetworkMode:string;Tmpfs:Record<string,string>};
 State:{Running:boolean};Mounts:Array<Record<string,unknown>>;NetworkSettings:{Networks:Record<string,unknown>};
}
function resource(profile:'parser'|'omp-b',socketPath:string):ManagedDockerResource{
 const scratchId=randomUUID(),nonce=randomUUID();
 const common={id:randomUUID(),scratchId,rootId:'1'.repeat(64),authoritySha256:'2'.repeat(64),nonce,name:`stadtstack-${profile}-${scratchId}-${nonce}`,socketPath,daemonId:'synthetic-daemon',imageId:'sha256:'+'3'.repeat(64),contractSha256:'4'.repeat(64),artifactRelativePath:null,artifactSha256:null,artifactBytes:null,configSha256:'0'.repeat(64),containerId:'5'.repeat(64),state:'created'};
 return ManagedDockerResourceSchema.parse(profile==='omp-b'?{...common,profile,controlSha256:'6'.repeat(64),controlBytes:123}:common);
}
function inspection(record:ManagedDockerResource,directory:string):SyntheticInspection{
 const {HostConfig,...Config}=managedDockerConfig(record,directory);
 return {Id:record.containerId,Name:'/'+record.name,Image:record.imageId,Config:{...Config,Env:'Env' in Config?Config.Env:[]},HostConfig,State:{Running:false},Mounts:HostConfig.Mounts.map(mount=>({Type:mount.Type,Source:mount.Source,Destination:mount.Target,RW:!mount.ReadOnly,Propagation:mount.BindOptions.Propagation})),NetworkSettings:{Networks:{[HostConfig.NetworkMode]:{}}}};
}
async function withDaemon(work:(socket:string,root:string,daemon:{value:SyntheticInspection|null;requests:string[];created:unknown})=>Promise<void>){
 const root=await realpath(await mkdtemp(join(tmpdir(),'civic-docker-test-'))),socket=join(root,'engine.sock');
 const daemon:{value:SyntheticInspection|null;requests:string[];created:unknown}={value:null,requests:[],created:null};
 const server=createServer((request,response)=>{
  const route=request.method+' '+request.url;daemon.requests.push(route);
  response.setHeader('content-type','application/json');
  if(route==='GET /info'){response.end(JSON.stringify({ID:'synthetic-daemon'}));return;}
  if(request.method==='GET'&&request.url?.endsWith('/json')){response.statusCode=daemon.value?200:404;response.end(JSON.stringify(daemon.value));return;}
  if(request.method==='POST'&&request.url?.startsWith('/containers/create?')){
   const chunks:Buffer[]=[];request.on('data',(chunk:Buffer)=>chunks.push(chunk));request.on('end',()=>{daemon.created=JSON.parse(Buffer.concat(chunks).toString());response.statusCode=201;response.end(JSON.stringify({Id:daemon.value?.Id}));});return;
  }
  if(request.method==='DELETE'){daemon.value=null;response.statusCode=204;response.end();return;}
  if(request.url?.endsWith('/start')&&daemon.value){daemon.value.State.Running=true;response.statusCode=204;response.end();return;}
  response.statusCode=500;response.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(socket,resolve));await chmod(socket,0o600);
 try{await work(socket,root,daemon);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(root,{recursive:true,force:true});}
}

test('parser profile keeps its original resource schema, exact create config and network isolation',async()=>withDaemon(async(socket,root,daemon)=>{
 const record=resource('parser',socket),directory=join(root,'scratch');record.configSha256=dockerConfigSha256(record,directory);
 assert.equal(DockerParserResourceSchema.safeParse(record).success,true);
 assert.equal('profile' in record,false);
 assert.equal(DockerParserResourceSchema.safeParse({...record,profile:'parser'}).success,false);
 const expected={Image:record.imageId,User:'65534:65534',WorkingDir:'/scratch',OpenStdin:true,StdinOnce:true,Tty:false,AttachStdin:true,AttachStdout:true,AttachStderr:true,StopTimeout:1,
  Entrypoint:['/usr/bin/env'],Cmd:['-i','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8','LC_ALL=C.UTF-8','TZ=UTC','HOME=/scratch/home','TMPDIR=/scratch/tmp','TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata','OMP_THREAD_LIMIT=1','/usr/bin/python3','-I','-S','/opt/stadtstack/parser-worker.py'],
  Labels:{'org.stadtstack.scratch':record.scratchId,'org.stadtstack.resource':record.id,'org.stadtstack.nonce':record.nonce,'org.stadtstack.root':record.rootId,'org.stadtstack.authority':record.authoritySha256,'org.stadtstack.contract':record.contractSha256,'org.stadtstack.input':'stdin-only','org.stadtstack.input-bytes':'0'},
  HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',IpcMode:'none',Privileged:false,AutoRemove:false,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges'],Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:32,
   Ulimits:[{Name:'cpu',Soft:120,Hard:120},{Name:'nofile',Soft:64,Hard:64},{Name:'nproc',Soft:32,Hard:32},{Name:'fsize',Soft:33554432,Hard:33554432},{Name:'core',Soft:0,Hard:0}],LogConfig:{Type:'none',Config:{}},Tmpfs:{'/scratch':'rw,noexec,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700'},Mounts:[]}};
 assert.deepEqual(dockerParserConfig(record,directory),expected);assert.deepEqual(managedDockerConfig(record,directory),expected);
 daemon.value=inspection(record,directory);assert.deepEqual(await inspectManagedDocker(record,directory,root),{id:record.containerId,running:false});
 daemon.value.HostConfig.NetworkMode='bridge';await assert.rejects(inspectManagedDocker(record,directory,root),DockerLifecycleError);
 const mounted={...record,artifactRelativePath:'document' as const,artifactSha256:'7'.repeat(64),artifactBytes:7};
 assert.deepEqual(dockerParserConfig(mounted,directory).HostConfig.Mounts,[{Type:'bind',Source:join(directory,'document'),Target:'/input/document',ReadOnly:true,BindOptions:{Propagation:'rprivate'}}]);
}));

test('omp-b profile is a closed resource and Engine create/inspect/remove uses its complete reviewed config',async()=>withDaemon(async(socket,root,daemon)=>{
 const record=resource('omp-b',socket),directory=join(root,'scratch');record.configSha256=dockerConfigSha256(record,directory);
 assert.equal(DockerOmpBResourceSchema.safeParse(record).success,true);assert.equal(DockerParserResourceSchema.safeParse(record).success,false);
 assert.equal(ManagedDockerResourceSchema.safeParse({...record,profile:'unreviewed'}).success,false);
 if(!('profile' in record))throw new Error('Expected omp-b fixture');
 const config=dockerOmpBConfig(record,directory);
 assert.deepEqual(Object.keys(config.HostConfig.Tmpfs).sort(),['/home/omp','/tmp','/work']);
 assert.equal(config.HostConfig.NetworkMode,'bridge');assert.equal(config.User,'65534:65534');assert.equal(config.HostConfig.ReadonlyRootfs,true);
 assert.deepEqual(config.HostConfig.Mounts,[{Type:'bind',Source:join(directory,'control'),Target:'/control',ReadOnly:true,BindOptions:{Propagation:'rprivate'}}]);
 assert.equal(JSON.stringify(config).includes('ANTHROPIC_OAUTH_TOKEN'),false);
 daemon.value=inspection(record,directory);
 assert.equal(await createManagedDocker(record,directory,root),record.containerId);assert.deepEqual(daemon.created,config);
 await startManagedDocker(record,directory,root);assert.deepEqual(await inspectManagedDocker(record,directory,root),{id:record.containerId,running:true});
 await removeManagedDocker({...record,state:'start_requested'},directory,root);assert.equal(daemon.value,null);
 assert.ok(daemon.requests.some(route=>route===`DELETE /containers/${record.containerId}?force=1&v=1`));
 assert.equal(daemon.requests.at(-1),`GET /containers/${record.name}/json`);
}));

test('omp-b inspection rejects every constrained field change and all mount/environment/network expansions',async()=>withDaemon(async(socket,root,daemon)=>{
 const record=resource('omp-b',socket),directory=join(root,'scratch');record.configSha256=dockerConfigSha256(record,directory);
 const baseline=inspection(record,directory),mutations:Array<{name:string;change:(value:SyntheticInspection)=>void}>=[];
 for(const key of ['Image','User','WorkingDir','OpenStdin','StdinOnce','Tty','AttachStdin','AttachStdout','AttachStderr','Entrypoint','Cmd','StopTimeout','Env'])mutations.push({name:'Config.'+key,change:value=>{const current=value.Config[key];value.Config[key]=typeof current==='boolean'?!current:Array.isArray(current)?[...current,'unexpected']:'unexpected';}});
 for(const key of Object.keys(baseline.HostConfig))mutations.push({name:'HostConfig.'+key,change:value=>{const current=value.HostConfig[key];value.HostConfig[key]=typeof current==='boolean'?!current:typeof current==='number'?current+1:Array.isArray(current)?[...current,'unexpected']:current!==null&&typeof current==='object'?{...current,unexpected:true}:'unexpected';}});
 for(const key of Object.keys(baseline.Config.Labels))mutations.push({name:'label '+key,change:value=>{value.Config.Labels[key]='unexpected';}});
 mutations.push(
  {name:'extra mount',change:value=>value.Mounts.push({Type:'bind',Source:'/home/max',Destination:'/host',RW:false,Propagation:'rprivate'})},
  {name:'missing mount',change:value=>{value.Mounts=[];}},
  {name:'writable control mount',change:value=>{value.Mounts[0]!.RW=true;}},
  {name:'missing tmpfs',change:value=>{delete value.HostConfig.Tmpfs['/tmp'];}},
  {name:'missing stop timeout',change:value=>{delete value.Config.StopTimeout;}},
  {name:'network none',change:value=>{value.HostConfig.NetworkMode='none';}},
  {name:'network endpoint none',change:value=>{value.NetworkSettings.Networks={none:{}};}},
  {name:'extra env',change:value=>value.Config.Env.push('HTTP_PROXY=http://host')},
  {name:'extra label',change:value=>{value.Config.Labels.unexpected='value';}},
  {name:'wrong image identity',change:value=>{value.Image='sha256:'+'9'.repeat(64);}},
  {name:'wrong container identity',change:value=>{value.Id='9'.repeat(64);}},
  {name:'wrong name',change:value=>{value.Name='/another';}},
 );
 for(const key of ['Binds','Devices','DeviceRequests','VolumesFrom','Links','PortBindings'])mutations.push({name:'extra '+key,change:value=>{value.HostConfig[key]=['unexpected'];}});
 for(const key of ['PidMode','UTSMode'])mutations.push({name:'host '+key,change:value=>{value.HostConfig[key]='host';}});
 for(const key of ['Volumes','ExposedPorts','Healthcheck','OnBuild'])mutations.push({name:'extra Config.'+key,change:value=>{value.Config[key]={unexpected:true};}});
 mutations.push({name:'duplicate tmpfs mount',change:value=>{value.Mounts.push({Type:'tmpfs',Destination:'/tmp'},{Type:'tmpfs',Destination:'/tmp'});}});
 for(const mutation of mutations){daemon.value=structuredClone(baseline);mutation.change(daemon.value);await assert.rejects(inspectManagedDocker(record,directory,root),DockerLifecycleError,mutation.name);}
 daemon.value=structuredClone(baseline);await assert.rejects(inspectManagedDocker({...record,configSha256:'9'.repeat(64)},directory,root),DockerLifecycleError);
 daemon.value=structuredClone(baseline);await assert.rejects(inspectManagedDocker({...record,daemonId:'different-daemon'},directory,root),DockerLifecycleError);
}));
