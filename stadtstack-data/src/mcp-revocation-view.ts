import {createHash} from 'node:crypto';
import {isSourceRevoked,type VerifiedRevocations} from './civic-revocations.ts';

/** Read-view identity, not a new data release or a civic withdrawal event. */
export function revocationViewIdentity(releaseId:string,revocations:VerifiedRevocations):string {
 isSourceRevoked(revocations,{}); // Enforce the verified runtime brand.
 if(revocations.releaseId!==releaseId)throw Error('Revocation read-view release mismatch');
 return createHash('sha256').update(JSON.stringify(['stadtstack-mcp-read-view-v1',releaseId,revocations.artifactSha256])).digest('hex');
}
export function administrativeView(releaseId:string,revocations:VerifiedRevocations){
 return {kind:'signed_administrative_revocation' as const,viewId:revocationViewIdentity(releaseId,revocations),releaseId,revocationsSha256:revocations.artifactSha256,sequence:revocations.sequence,issuedAt:revocations.issuedAt,meaning:'Administrative withholding from this sealed release, not a civic withdrawal, deletion or supersession event.'};
}
export type AdministrativeView=ReturnType<typeof administrativeView>;
