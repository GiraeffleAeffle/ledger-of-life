import {readdir,readFile} from 'node:fs/promises';
import {digest,semanticHash} from './district-adapter-contract.ts';

/** Complete host checkout provenance, including mixed semantic/enforcement modules.
 * Captured once per process, before execution. It never enters a selector, key,
 * output compatibility check, or security authorization. Deploy immutable checkouts;
 * restart the executor after edits so loaded modules and this manifest agree. */
let snapshot:Promise<Record<string,string>>|undefined;
export function hostCodeVersions():Promise<Record<string,string>> {
 return snapshot??=captureHostCodeVersions();
}
async function captureHostCodeVersions():Promise<Record<string,string>> {
 const files:string[]=[];
 async function visit(relative:string):Promise<void>{
  const entries=await readdir(new URL('../'+relative+'/',import.meta.url),{withFileTypes:true});
  for(const entry of entries){
   if(entry.isSymbolicLink())throw Error('Host provenance refuses symlinked source');
   const path=relative+'/'+entry.name;
   if(entry.isDirectory())await visit(path);
   else if(entry.isFile())files.push(path);
  }
 }
 await visit('src');await visit('scripts');await visit('docker');
 files.push('package.json','package-lock.json','Dockerfile.parser','Dockerfile.parser.dockerignore','sources/district-host-groups.json');
 const manifest=await Promise.all(files.sort().map(async file=>({file,sha256:digest(await readFile(new URL('../'+file,import.meta.url)))})));
 return {hostCodeManifestVersion:'district-host-code-v1',hostCodeManifestSha256:semanticHash(manifest),...Object.fromEntries(manifest.map(({file,sha256})=>['hostCode.'+file,sha256]))};
}
