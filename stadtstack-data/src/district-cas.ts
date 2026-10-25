import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {HashSchema} from './district-adapter-contract.ts';

export type ArtifactKind = 'source_original'|'text'|'parser_output'|'provider_response'|'receipt'|'manifest'|'derived';
export interface CasArtifact {sha256:string; byteLength:number; kind:ArtifactKind; mimeType:string; storageKey:string}
export interface CasAdmission {state:'allowed'; sourceSha256:string; policyProofSha256:string; checkedAt:string; expiresAt:string}
export interface CasPutOptions {kind:ArtifactKind; mimeType:string; admission?:CasAdmission}
const forbiddenComponents:Record<string,true> = {out:true,public:true,www:true,htdocs:true};
function assertPrivateLocation(path:string, publicRoots:readonly string[]):void {
  if (path.split(sep).some(part=>forbiddenComponents[part.toLowerCase()]===true)) throw Error('CAS public location rejected');
  for (const root of publicRoots) {
    const rel=relative(root,path);
    if (rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))) throw Error('CAS public location rejected');
  }
}
function missing(error:unknown):boolean {return (error as NodeJS.ErrnoException).code==='ENOENT';}
async function syncDirectory(path:string):Promise<void> {const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try {await handle.sync();} finally {await handle.close();}}
async function privateDirectory(path:string):Promise<void> {
  try {await mkdir(path,{mode:0o700});await syncDirectory(dirname(path));} catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('CAS directory must be private and non-symlink');
}

/** Private filesystem CAS. Callers must register metadata only after put resolves.
 * A crash may orphan an object; it cannot commit a reference to partial bytes.
 * Source originals require a current, exact-byte policy proof, including cache hits.
 * Public release code never receives a CAS path through artifact metadata.
 */
export class DistrictCas {
  readonly root:string;
  readonly maxBytes:number;
  private readonly publicRoots:readonly string[];
  private initialization:Promise<void>|undefined;
  constructor(root=resolve('cache/districts/cas'), options:{maxBytes?:number;publicRoots?:readonly string[]}={}) {
    this.root=resolve(root);this.maxBytes=options.maxBytes??128*1024*1024;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1)throw Error('CAS byte bound rejected');
    this.publicRoots=(options.publicRoots??[resolve('out'),resolve('public')]).map(path=>resolve(path));
    assertPrivateLocation(this.root,this.publicRoots);
  }
  private async initialize():Promise<void> {
    if(!this.initialization)this.initialization=this.initializeRoot().catch(error=>{this.initialization=undefined;throw error;});
    await this.initialization;
  }
  private async initializeRoot():Promise<void> {
    let existing=this.root;const pending:string[]=[];
    for(;;){try{await lstat(existing);break;}catch(error){if(!missing(error))throw error;pending.unshift(existing);existing=dirname(existing);}}
    const canonicalParent=await realpath(existing);
    const canonicalRoot=resolve(canonicalParent,relative(existing,this.root));
    const canonicalPublic=await Promise.all(this.publicRoots.map(async path=>{try{return await realpath(path);}catch(error){if(!missing(error))throw error;return path;}}));
    assertPrivateLocation(canonicalRoot,canonicalPublic);
    if((await lstat(existing)).isSymbolicLink())throw Error('CAS root symlink rejected');
    for(const path of pending)await privateDirectory(path);
    await privateDirectory(this.root);
    await privateDirectory(join(this.root,'sha256'));
  }
  private async objectPath(sha256:string):Promise<string> {
    HashSchema.parse(sha256);await this.initialize();
    const shard=join(this.root,'sha256',sha256.slice(0,2));await privateDirectory(shard);
    return join(shard,sha256);
  }
  private async readObject(path:string,sha256:string):Promise<Buffer> {
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=await handle.stat();
      if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>this.maxBytes)throw Error('CAS object size/type/permissions rejected');
      const bytes=await handle.readFile();
      if(bytes.length>this.maxBytes||createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('CAS byte binding mismatch');
      return bytes;
    } finally {await handle.close();}
  }
  async put(bytes:Uint8Array,options:CasPutOptions):Promise<CasArtifact> {
    if(bytes.byteLength>this.maxBytes)throw Error('CAS byte bound exceeded');
    if(!options.mimeType||options.mimeType.length>256||/[\r\n]/.test(options.mimeType))throw Error('CAS MIME rejected');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(options.kind==='source_original') {
      const proof=options.admission, now=Date.now();
      if(!proof||proof.state!=='allowed'||proof.sourceSha256!==sha256||!Number.isFinite(Date.parse(proof.checkedAt))||Date.parse(proof.checkedAt)>now||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=now)throw Error('CAS original requires current byte-bound admission');
      HashSchema.parse(proof.policyProofSha256);
    }
    const path=await this.objectPath(sha256), temporary=join(dirname(path),'.'+randomUUID()+'.tmp');
    const artifact={sha256,byteLength:bytes.byteLength,kind:options.kind,mimeType:options.mimeType,storageKey:'sha256/'+sha256.slice(0,2)+'/'+sha256};
    try {await this.readObject(path,sha256);return artifact;}catch(error){if(!missing(error))throw error;}
    const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {
      await handle.writeFile(bytes);await handle.sync();await handle.close();
      // Rehash the fsynced file, not only the caller's potentially mutable buffer.
      await this.readObject(temporary,sha256);
      await rename(temporary,path);await syncDirectory(dirname(path));
      return artifact;
    } finally {
      await handle.close();
      try{await unlink(temporary);}catch(error){if(!missing(error))throw error;}
    }
  }
  async read(sha256:string):Promise<Buffer> {return this.readObject(await this.objectPath(sha256),sha256);}
  async verify(sha256:string):Promise<void> {await this.read(sha256);}
}
