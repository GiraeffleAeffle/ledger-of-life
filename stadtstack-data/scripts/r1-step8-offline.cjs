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
for(const key of ['spawn','spawnSync','exec','execSync','execFileSync','fork'])cp[key]=deny;
process.env.STADTSTACK_STEP8_OFFLINE='1';
cp.execFile[require('node:util').promisify.custom]=(file,args,options)=>new Promise((resolve,reject)=>{
 cp.execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
});
syncBuiltinESMExports();
