import {readFile,writeFile,mkdir,rename,lstat,open,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,hashSchema} from './district-schema.ts';

export async function writePrivateJson(path:string,value:unknown):Promise<string>{
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const bytes=JSON.stringify(value,null,2)+'\n',temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
 await rename(temporary,path);
 return sha256(bytes);
}
export async function readPinnedJson(path:string,expectedSha256:string,maxBytes=32*1024*1024):Promise<unknown>{
 hashSchema.parse(expectedSha256);
 const metadata=await lstat(path);if(!metadata.isFile()||metadata.size>maxBytes)throw Error('Private artifact size/type rejected');
 const bytes=await readFile(path);if(bytes.length>maxBytes||sha256(bytes)!==expectedSha256)throw Error('Private artifact byte binding mismatch');
 return JSON.parse(bytes.toString('utf8'));
}
export async function acquirePrivateRunLock(path:string,purpose:string):Promise<()=>Promise<void>>{
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const nonce=randomUUID(),handle=await open(path,'wx',0o600);
 await handle.writeFile(JSON.stringify({pid:process.pid,nonce,purpose,startedAt:new Date().toISOString()})+'\n');await handle.close();
 return async()=>{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.pid!==process.pid||owner.nonce!==nonce)throw Error('Private run lock owner changed');await unlink(path);};
}
