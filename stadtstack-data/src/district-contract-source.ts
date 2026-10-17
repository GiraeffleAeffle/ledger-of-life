import {readFile} from 'node:fs/promises';
import {digest} from './district-adapter-contract.ts';

/** Injection is confined to fingerprint computation, never execution authorization. */
export type ContractSourceHash=(file:string)=>Promise<string>;
export const contractSourceHash:ContractSourceHash=async file=>digest(await readFile(new URL(file,import.meta.url)));
export function contractSourceManifest(files:readonly string[],hash:ContractSourceHash=contractSourceHash){
 return Promise.all(files.map(async file=>({file,sha256:await hash(file)})));
}
