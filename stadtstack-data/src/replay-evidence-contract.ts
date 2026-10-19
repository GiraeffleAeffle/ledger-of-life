import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {HashSchema} from './district-adapter-contract.ts';

/** A new execution owns a fresh evidence namespace, never the source CAS. This
 * is derived from the already pinned workspace, not an operator fallback path. */
export function replayEvidenceCasRoot(workspace:string,base:string):string{return resolve(base,workspace)+'-artifacts';}
const pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema,bytes:z.number().int().nonnegative()}).strict();
const gitPath=z.string().min(1).refine(path=>!isAbsolute(path)&&!path.includes('\\')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'));
const gitPin=z.object({path:gitPath,sha256:HashSchema,bytes:z.number().int().nonnegative()}).strict();
export const ReplayEvidenceInputPinsSchema=z.object({
 schemaVersion:z.literal('stadtstack-replay-input-pins-v1'),
 sourceCas:z.object({root:z.string().refine(isAbsolute),hashPath:z.literal('sha256/<first-two-hex>/<sha256>'),references:z.literal('hash references in the pinned dependencies')}).strict(),
 receipt:pin,provenance:pin,
 dependencies:z.array(pin.extend({bindingsSha256:HashSchema}).strict()).min(1),
 staging:z.array(pin.extend({destination:gitPath}).strict()).min(1),
 expectedRelease:z.object({manifest:pin,members:z.array(pin).min(1)}).strict(),
 priorReleases:z.array(z.object({gitCommit:z.string().regex(/^[a-f0-9]{40}$/),directory:z.enum(['out','release']),releaseId:HashSchema,
  usage:z.literal('historical_change_reconstruction_only'),manifest:gitPin,members:z.array(gitPin).min(1)}).strict()).min(1),
 runtime:z.object({packageLock:pin,sourceFiles:z.array(pin).min(1)}).strict(),
}).strict();
export type ReplayEvidenceInputPins=z.infer<typeof ReplayEvidenceInputPinsSchema>;
export const ReplayArtifactAuditSchema=z.object({schemaVersion:z.literal('district-replay-artifact-audit-v1'),path:gitPath,sha256:HashSchema,
 bytes:z.number().int().nonnegative(),mimeType:z.string().min(1),kind:z.literal('derived'),storageKey:z.string().regex(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/),
 inputBindingSha256:HashSchema,producerBindingsSha256:HashSchema}).strict();
