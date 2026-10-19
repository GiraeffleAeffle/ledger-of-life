import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import type {PrivatePublicationProvenance,AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';

const Hash=z.string().regex(/^[a-f0-9]{64}$/),MAX_BYTES=128*1024*1024;
export const NativeProvenancePinSchema=z.object({path:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),sha256:Hash,bytes:z.number().int().nonnegative().max(MAX_BYTES).optional()}).strict();
export const NativeProvenanceWitnessSchema=z.object({output:NativeProvenancePinSchema,provenance:NativeProvenancePinSchema}).strict();
export const ProvenanceSupplementSelectionSchema=NativeProvenancePinSchema.extend({targets:z.array(Hash).min(1).max(32)}).strict();
const EvidenceSchema=z.object({nativeOutput:NativeProvenancePinSchema,nativeProvenance:NativeProvenancePinSchema,witnesses:z.array(NativeProvenanceWitnessSchema).max(256),targets:z.array(Hash).min(1).max(32)});
export type NativeProvenancePin=z.infer<typeof NativeProvenancePinSchema>;
export type NativeProvenanceWitness=z.infer<typeof NativeProvenanceWitnessSchema>;
export type SupplementEvidence=z.infer<typeof EvidenceSchema>;
export type SupplementSelection=z.infer<typeof ProvenanceSupplementSelectionSchema>;
export const WITNESSED_PROVENANCE_CORE_DEPENDENCIES=['src/civic-opt-out.ts','src/district-publication-provenance.ts','src/district-adapter-contract.ts','src/r1-step8-managed-read-view.ts'] as const;
const defaultCoreRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const stamp=(stat:Awaited<ReturnType<typeof metadata>>)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,stat.uid,stat.nlink].join(':');
const metadata=(path:string)=>lstat(path,{bigint:true});
async function loadCore(root:string){
 const [civic,provenance,adapter,audit]=await Promise.all(WITNESSED_PROVENANCE_CORE_DEPENDENCIES.map(file=>import(pathToFileURL(join(root,file)).href)));
 return {civic:civic as typeof import('./civic-opt-out.ts'),provenance:provenance as typeof import('./district-publication-provenance.ts'),adapter:adapter as typeof import('./district-adapter-contract.ts'),audit:audit as typeof import('./r1-step8-managed-read-view.ts')};
}
type Core=Awaited<ReturnType<typeof loadCore>>;
type NativeRecord={output:NativeProvenancePin;provenance:NativeProvenancePin;inventory:PrivatePublicationProvenance};
type FileRecord={bytes:Buffer;stamp:string};
export interface WitnessedProvenanceContext {readonly witnesses:number;finish():Promise<void>}
interface ContextState {
 core:Core;policy:CivicPolicyOptions;witnesses:NativeProvenanceWitness[];native:Map<string,NativeRecord>;files:Map<string,FileRecord>;
 fence:Awaited<ReturnType<Core['audit']['createReadOnlyManagedSourceAudit']>>;inventoryPin:NativeProvenancePin;inventoryStamp:string;finished:boolean;
}
const contexts=new WeakMap<WitnessedProvenanceContext,ContextState>();
const pinKey=(pin:NativeProvenancePin)=>JSON.stringify([pin.path,pin.sha256]);
function state(context:WitnessedProvenanceContext){const value=contexts.get(context);if(!value||value.finished)throw Error('Native provenance context unavailable or finished');return value;}
async function readPrivate(pin:NativeProvenancePin,files:Map<string,FileRecord>,maxBytes=MAX_BYTES){
 const actual=NativeProvenancePinSchema.parse(pin),before=await metadata(actual.path),cached=files.get(pinKey(actual));
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||(before.mode&0o077n)!==0n||before.size>BigInt(maxBytes)||await realpath(actual.path)!==actual.path)throw Error('Unsafe native provenance control');
 if(cached){if(stamp(before)!==cached.stamp||actual.bytes!==undefined&&actual.bytes!==cached.bytes.length)throw Error('Native provenance witness changed');return cached.bytes;}
 const handle=await open(actual.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=await handle.stat({bigint:true}),bytes=await handle.readFile(),after=await handle.stat({bigint:true});if(stamp(before)!==stamp(opened)||stamp(opened)!==stamp(after)||bytes.length!==Number(after.size)||actual.bytes!==undefined&&actual.bytes!==bytes.length||digest(bytes)!==actual.sha256)throw Error('Native provenance control pin mismatch');files.set(pinKey(actual),{bytes,stamp:stamp(after)});return bytes;}finally{await handle.close();}
}
async function assertCurrent(value:ContextState){
 if(value.finished)throw Error('Native provenance context finished');
 await value.core.civic.assertCivicPolicyAuthority(value.policy);
 if(stamp(await metadata(value.inventoryPin.path))!==value.inventoryStamp)throw Error('Native provenance inventory epoch changed');
 if((await value.core.civic.readCivicOptOutSnapshot(value.policy)).sha256!==value.fence.optOutSnapshotSha256)throw Error('Native provenance objection epoch changed');
 for(const [key,file] of value.files){const path=JSON.parse(key)[0] as string;if(stamp(await metadata(path))!==file.stamp||await realpath(path)!==path)throw Error('Native provenance witness changed');}
}
async function nativeRecord(value:ContextState,outputPin:NativeProvenancePin,provenancePin?:NativeProvenancePin){
 const cached=value.native.get(pinKey(outputPin));if(cached){await readPrivate(outputPin,value.files);if(provenancePin&&(pinKey(cached.provenance)!==pinKey(provenancePin)||provenancePin.bytes!==undefined&&cached.provenance.bytes!==provenancePin.bytes))throw Error('Native witness provenance pin differs');return cached;}
 const raw=await readPrivate(outputPin,value.files),output=z.object({runId:Hash,privateProvenance:NativeProvenancePinSchema.extend({bytes:z.number().int().nonnegative(),bindings:z.array(z.unknown()).min(1)}),artifacts:z.object({extractionRun:NativeProvenancePinSchema}).passthrough()}).passthrough().parse(JSON.parse(raw.toString('utf8')));
 const pin=NativeProvenancePinSchema.parse({path:output.privateProvenance.path,sha256:output.privateProvenance.sha256,bytes:output.privateProvenance.bytes});
 if(provenancePin&&(pinKey(pin)!==pinKey(provenancePin)||provenancePin.bytes!==undefined&&pin.bytes!==provenancePin.bytes))throw Error('Native output changes independently pinned provenance');
 const bytes=await readPrivate(pin,value.files),bindings=output.privateProvenance.bindings.map(binding=>value.core.provenance.artifactBindingSchema.parse(binding));
 await value.core.civic.assertManagedSourceBindings(pin.path,bindings,value.policy);
 const inventory=value.core.provenance.privatePublicationProvenanceSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(output.artifacts.extractionRun.sha256!==output.runId||!inventory.inputs.some(input=>resolve(dirname(pin.path),input.path)===output.artifacts.extractionRun.path&&input.sha256===output.runId))throw Error('Witness is not bound to its native extraction run');
 await value.fence.read(pin.path,pin.sha256);
 const result={output:{...outputPin,bytes:raw.length},provenance:pin,inventory};value.native.set(pinKey(outputPin),result);return result;
}
/** A batch caches decodes, never mutable authorization: all file identities,
 * inventory/objection epochs and Core's complete live checks remain mandatory.
 * coreRoot lets private adoption load the active pinned Core, not side-worktree
 * implementations. It is a trusted caller option, never a raw evidence field. */
export async function createWitnessedProvenanceContext(rawWitnesses:NativeProvenanceWitness[],policy:CivicPolicyOptions={},options:{coreRoot?:string}={}):Promise<WitnessedProvenanceContext>{
 const witnesses=z.array(NativeProvenanceWitnessSchema).max(256).parse(rawWitnesses),seen=new Set<string>();for(const witness of witnesses){if(seen.has(pinKey(witness.output)))throw Error('Duplicate native provenance witness');seen.add(pinKey(witness.output));}
 const core=await loadCore(resolve(options.coreRoot??defaultCoreRoot)),authority=await core.civic.assertCivicPolicyAuthority(policy),bound={...policy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const fence=await core.audit.createReadOnlyManagedSourceAudit(bound),inventoryPin={path:join(resolve(bound.stateDir??core.civic.CIVIC_POLICY_STATE_DIR),'inventory.json'),sha256:fence.inventorySha256},epochFiles=new Map<string,FileRecord>();
 await readPrivate(inventoryPin,epochFiles,512*1024*1024);
 const value:ContextState={core,policy:bound,witnesses,native:new Map(),files:new Map(),fence,inventoryPin,inventoryStamp:epochFiles.get(pinKey(inventoryPin))!.stamp,finished:false};
 const context:WitnessedProvenanceContext=Object.freeze({witnesses:witnesses.length,async finish():Promise<void>{const live=state(context);await assertCurrent(live);await live.fence.finish();live.finished=true;}});contexts.set(context,value);
 for(const witness of witnesses)await nativeRecord(value,witness.output,witness.provenance);
 await assertCurrent(value);return context;
}
function samePolicy(value:ContextState,policy:CivicPolicyOptions){
 const expected={stateDir:resolve(value.policy.stateDir??value.core.civic.CIVIC_POLICY_STATE_DIR),authorityId:value.policy.authorityId,authoritySha256:value.policy.authoritySha256};
 const supplied={stateDir:resolve(policy.stateDir??value.core.civic.CIVIC_POLICY_STATE_DIR),authorityId:policy.authorityId??value.core.civic.CIVIC_POLICY_AUTHORITY_ID,authoritySha256:policy.authoritySha256??value.policy.authoritySha256};
 if(value.core.adapter.canonicalJson(expected)!==value.core.adapter.canonicalJson(supplied))throw Error('Native provenance context belongs to another authority');
}
async function withContext<T>(witnesses:NativeProvenanceWitness[],policy:CivicPolicyOptions,context:WitnessedProvenanceContext|undefined,work:(value:ContextState)=>Promise<T>){
 const owned=!context,selected=context??await createWitnessedProvenanceContext(witnesses,policy),value=state(selected);samePolicy(value,policy);
 if(value.core.adapter.canonicalJson(value.witnesses)!==value.core.adapter.canonicalJson(witnesses))throw Error('Native provenance context witness set differs');
 try{await assertCurrent(value);const result=await work(value);await assertCurrent(value);if(owned)await selected.finish();return result;}catch(error){if(owned)await selected.finish().catch(()=>{});throw error;}
}
async function supplemented(value:ContextState,inputs:SupplementEvidence){
 const native=await nativeRecord(value,inputs.nativeOutput,inputs.nativeProvenance),result=structuredClone(native.inventory),targets=new Set(inputs.targets),found=new Set<string>();
 if(targets.size!==inputs.targets.length)throw Error('Duplicate provenance supplement target');
 for(const pin of result.inputs){
  if(!targets.has(pin.sha256))continue;found.add(pin.sha256);
  const bindings=new Map(pin.bindings.map(binding=>[value.core.adapter.canonicalJson(binding),binding]));
  for(const witness of value.witnesses){const manifest=(await nativeRecord(value,witness.output,witness.provenance)).inventory;for(const other of manifest.inputs){
   if(other.sha256!==pin.sha256)continue;if(other.path!==pin.path||other.bytes!==pin.bytes)throw Error('Shared target path or byte-size differs');
   for(const binding of other.bindings){if(binding.kind!=='http_observation'||binding.independentAllowed!==true)throw Error('Supplement requires actual native HTTP binding witnesses');bindings.set(value.core.adapter.canonicalJson(binding),binding);}
  }}
  if(bindings.size<=pin.bindings.length)throw Error('No independent supplemental bindings for target');
  pin.bindings=[...bindings].sort(([a],[b])=>a.localeCompare(b)).map(([,binding])=>binding);
 }
 if(found.size!==targets.size)throw Error('Supplement target absent from native provenance');
 const inventory=value.core.provenance.privatePublicationProvenanceSchema.parse(result),bytes=encode(inventory);return {inventory,bytes,sha256:digest(bytes)};
}
/** Workflow-specific input members (e.g. window18) remain caller-owned. */
export async function buildProvenanceSupplement(raw:SupplementEvidence,policy:CivicPolicyOptions={},context?:WitnessedProvenanceContext){
 const inputs=EvidenceSchema.parse(raw);return withContext(inputs.witnesses,policy,context,value=>supplemented(value,inputs));
}
/** Never weakens exact-set Core checks. The returned capability is issued by
 * the selected unchanged Core module, not forged or wrapped by this module. */
export async function authenticateSupplement(raw:SupplementEvidence,pin:NativeProvenancePin,policy:CivicPolicyOptions={},context?:WitnessedProvenanceContext):Promise<AuthenticatedPublicationProvenance>{
 const inputs=EvidenceSchema.parse(raw);return withContext(inputs.witnesses,policy,context,async value=>{
  const expected=await supplemented(value,inputs),bytes=await readPrivate(pin,value.files);if(!bytes.equals(expected.bytes))throw Error('Supplement differs from independently witnessed native union');
  const reader=await value.core.provenance.authenticatePublicationProvenance(pin.path,pin.sha256,value.policy);
  for(const input of expected.inventory.inputs)await reader.read(resolve(dirname(pin.path),input.path));return reader;
 });
}
/** Shared Step8 consumer: unsupplemented seals still receive exact binding-set
 * authentication. A supplement is explicit, never an inferred fallback. */
export async function authenticateSealProvenance(output:NativeProvenancePin,selection:SupplementSelection|undefined,policy:CivicPolicyOptions={},context?:WitnessedProvenanceContext){
 const witnesses=context?state(context).witnesses:[];
 return withContext(witnesses,policy,context,async value=>{
  const native=await nativeRecord(value,output);
  if(!selection){const reader=await value.core.provenance.authenticatePublicationProvenance(native.provenance.path,native.provenance.sha256,value.policy);for(const input of native.inventory.inputs)await reader.read(resolve(dirname(native.provenance.path),input.path));return {reader,inventory:native.inventory,originalProvenance:native.provenance};}
  const {targets,...pin}=ProvenanceSupplementSelectionSchema.parse(selection),inputs={nativeOutput:output,nativeProvenance:native.provenance,witnesses,targets},expected=await supplemented(value,inputs),bytes=await readPrivate(pin,value.files);
  if(!bytes.equals(expected.bytes))throw Error('Supplement differs from independently witnessed native union');
  const reader=await value.core.provenance.authenticatePublicationProvenance(pin.path,pin.sha256,value.policy);for(const input of expected.inventory.inputs)await reader.read(resolve(dirname(pin.path),input.path));return {reader,inventory:expected.inventory,originalProvenance:native.provenance};
 });
}
