'use strict';
// Trusted offline reconstruction only. Keep same-host Unix sockets for canonical
// PG audit and allow the predecessor reader's exact local git-show operation.
// No readiness, model CLI, HTTP, DNS, TCP or arbitrary subprocess fallback exists.
const {syncBuiltinESMExports}=require('node:module');
const net=require('node:net'),http=require('node:http'),https=require('node:https'),dns=require('node:dns'),tls=require('node:tls'),cp=require('node:child_process');
function deny(){throw Error('Step8 offline guard: network/provider/process operation forbidden');}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const value=Array.isArray(args[0])?args[0][0]:args[0];
 const path=typeof value==='string'?value:value&&typeof value==='object'?value.path:undefined;
 if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0'))return deny();
 return connect.apply(this,args);
};
for(const module of [http,https]){module.request=deny;module.get=deny;}
tls.connect=deny;
const datagram=require('node:dgram');
for(const key of ['bind','connect','send'])datagram.Socket.prototype[key]=deny;
datagram.createSocket=deny;datagram.Socket=deny;
require('node:http2').connect=deny;
for(const module of [dns,dns.promises])for(const key of Object.keys(module))if(typeof module[key]==='function')module[key]=deny;
globalThis.fetch=deny;
const execFile=cp.execFile;
cp.execFile=function(file,args,...rest){
 if(file!=='git'||!Array.isArray(args)||args.length!==3||args[0]!=='--no-replace-objects'||args[1]!=='show'||!/^[a-f0-9]{40}:\.\/(?:out|release)\/[a-zA-Z0-9/_.-]+$/.test(args[2]))return deny();
 return execFile.call(this,file,args,...rest);
};
// Reconstruction uses only our fixed service. Force its runtime, preload,
// streams and environment rather than trusting caller options.
const fork=cp.fork,worker=require('node:path').resolve(__dirname,'../src/r1-step8-reconstruction-worker.ts');
const workerArgs=['--experimental-strip-types','--max-old-space-size=1024','--require',__filename];
cp.fork=function(file,args,options){
 if(file!==worker||!Array.isArray(args)||args.length||!options||options.execPath!==process.execPath||JSON.stringify(options.execArgv)!==JSON.stringify(workerArgs)||options.serialization!=='advanced'||JSON.stringify(options.stdio)!==JSON.stringify(['ignore','ignore','inherit','ipc'])||Object.keys(options).some(key=>!['execPath','execArgv','serialization','stdio','env'].includes(key)))return deny();
 return fork.call(this,worker,[],{execPath:process.execPath,execArgv:workerArgs,serialization:'advanced',stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,NODE_OPTIONS:''}});
};
// Unchanged Core's dead-owner recovery uses flock's inherited-fd form. Admit
// only that zero-byte, private, owned inventory.break.lock descriptor; no
// command-execution form, path argument, shell, environment or provider is allowed.
const spawn=cp.spawn,fs=require('node:fs'),paths=require('node:path');
cp.spawn=function(file,args,options){
 if(file!=='/usr/bin/flock'||JSON.stringify(args)!==JSON.stringify(['--exclusive','--nonblock','3'])||!options||Object.keys(options).length!==1||!Array.isArray(options.stdio)||options.stdio.length!==4||options.stdio.slice(0,3).some(value=>value!=='ignore')||!Number.isInteger(options.stdio[3])||options.stdio[3]<3)return deny();
 try{
  const fd=options.stdio[3],path=fs.readlinkSync('/proc/self/fd/'+fd),opened=fs.fstatSync(fd),named=fs.lstatSync(path);
  if(!paths.isAbsolute(path)||paths.basename(path)!=='inventory.break.lock'||fs.realpathSync(path)!==path||!opened.isFile()||!named.isFile()||opened.uid!==process.getuid()||opened.nlink!==1||(opened.mode&0o777)!==0o600||opened.size!==0||opened.dev!==named.dev||opened.ino!==named.ino)return deny();
 }catch{return deny();}
 return spawn.call(this,'/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',options.stdio[3]]});
};
for(const key of ['spawnSync','exec','execSync','execFileSync'])cp[key]=deny;
process.env.STADTSTACK_STEP8_OFFLINE='1';
cp.execFile[require('node:util').promisify.custom]=(file,args,options)=>new Promise((resolve,reject)=>{
 cp.execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
});
syncBuiltinESMExports();
