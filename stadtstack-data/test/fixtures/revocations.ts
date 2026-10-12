import {createHash,generateKeyPairSync} from 'node:crypto';
import {compareRevocationTargets,revocationKeyId,signRevocations,verifyRevocations,type RevocationTarget} from '../../src/civic-revocations.ts';

/** Synthetic test authority only: ephemeral key material never leaves this function. */
export function verifiedMask(releaseId:string,targets:readonly RevocationTarget[]=[],sequence=0){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey);
 const bytes=signRevocations({schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-11T00:00:00.000Z',sequence,targets:[...targets].sort(compareRevocationTargets)},keyId,privateKey);
 return verifyRevocations(bytes,{schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:createHash('sha256').update(bytes).digest('hex'),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]},releaseId);
}
