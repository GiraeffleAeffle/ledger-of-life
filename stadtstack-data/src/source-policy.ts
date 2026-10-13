import {load} from 'cheerio';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {isPublicAddress} from './public-address.ts';
import { DocumentOriginSchema,DOCUMENT_ORIGIN_CLASSIFIER_VERSION,type DocumentOriginClassification } from './document-origin-contract.ts'

/** Owner operational decision only: not municipal permission, a licence, or an access-barrier exemption. */
export const APPROVED_OWNER_ROBOTS_OVERRIDE=Object.freeze({
 reason:'public civic sources, owner decision',
 date:'2026-10-11',
 approver:'owner',
 id:'owner-2026-10-11-public-civic-sources',
} as const);
export type OwnerRobotsOverride=typeof APPROVED_OWNER_ROBOTS_OVERRIDE&{readonly host:string};
/** Bind the global decision to one public target; callers must separately establish registered-source context. */
export function ownerRobotsOverrideFor(url:string):OwnerRobotsOverride|null {
 try{
  const target=new URL(url),host=target.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password||target.port&&!['80','443'].includes(target.port)||host.endsWith('.')||!host.includes('.')&&!isIP(host)||/\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)||isIP(host)&&!isPublicAddress(host))return null;
  for(const key of target.searchParams.keys())if(/^(?:token|access_token|api_key|apikey|password|secret|authorization|sessionid|phpsessid)$/i.test(key))return null;
  return Object.freeze({...APPROVED_OWNER_ROBOTS_OVERRIDE,host:target.hostname});
 }catch{return null;}
}
export function ownerRobotsOverrideApplies(url:string,supplied:unknown):boolean {
 const approved=ownerRobotsOverrideFor(url);
 if(!approved||!supplied||typeof supplied!=='object'||Array.isArray(supplied))return false;
 const value=supplied as Record<string,unknown>,keys=Object.keys(approved) as (keyof OwnerRobotsOverride)[];
 return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&value[key]===approved[key]);
}

export interface OwnerGenesisAccessDecision {
 readonly id:string;readonly date:string;readonly approver:'owner';readonly host:'www.regionalstatistik.de';
 readonly purpose:'regionalstatistik_genesis_statistics';readonly permission:'facts_with_attribution';
}
/** Code-reviewed decisions only, each backed by the owner's explicit written approval;
 * robots/corpus approvals do not authorize use of an account. No runtime overrides.
 * owner-2026-10-13-regionalstatistik-account: "1. yes" in the omp chat, recorded in
 * reports/approvals/r1-k2-and-genesis-owner-account-2026-10-13.json (sha256 d7c8074d…). */
export const APPROVED_OWNER_GENESIS_ACCESS:readonly OwnerGenesisAccessDecision[]=Object.freeze([
 Object.freeze({id:'owner-2026-10-13-regionalstatistik-account',date:'2026-10-13',approver:'owner',host:'www.regionalstatistik.de',purpose:'regionalstatistik_genesis_statistics',permission:'facts_with_attribution'} as const),
]);
export interface OwnerAccountAccess {decisionId:string;credentialKind:'token'|'password'}
export function isOwnerGenesisEndpoint(url:string):boolean {
 try{
  const target=new URL(url);
  return target.origin==='https://www.regionalstatistik.de'&&!target.username&&!target.password&&!target.search&&!target.hash&&/^\/genesisws\/rest\/2020\/data\/table(?:file)?$/.test(target.pathname);
 }catch{return false;}
}
export function ownerGenesisAccessFor(url:string):OwnerGenesisAccessDecision|null {
 if(!isOwnerGenesisEndpoint(url))return null;
 return APPROVED_OWNER_GENESIS_ACCESS.find(decision=>decision.host==='www.regionalstatistik.de'&&decision.approver==='owner'&&decision.purpose==='regionalstatistik_genesis_statistics'&&decision.permission==='facts_with_attribution'&&/^[a-z0-9][a-z0-9-]{0,159}$/.test(decision.id)&&/^\d{4}-\d{2}-\d{2}$/.test(decision.date))??null;
}
export function ownerAccountAccessApplies(url:string,audit:OwnerAccountAccess|undefined):boolean {
 const decision=ownerGenesisAccessFor(url);
 return !!decision&&!!audit&&audit.decisionId===decision.id&&(audit.credentialKind==='token'||audit.credentialKind==='password');
}
export function effectiveAccountAccess(policy:Pick<SourceAccessPolicy,'access'|'ownerAccountAccess'>,url:string):boolean {
 return policy.access==='public'?policy.ownerAccountAccess===undefined:policy.access==='authenticated_owner_account'&&ownerAccountAccessApplies(url,policy.ownerAccountAccess);
}

export interface PolicyEvidence {url:string;locator:string;value:string;sha256?:string;checkedAt?:string;valueSha256?:string;valueBytes?:number;locatorSha256?:string;locatorBytes?:number;itemCount?:number}
export interface SourceAccessPolicy {
 robots:{state:'allowed'|'blocked'|'unavailable';url:string;sha256?:string;checkedAt?:string};
 tdm:{state:'reserved'|'not_reserved'|'not_declared'|'unavailable';evidence:PolicyEvidence[];referenceStatus?:'unavailable';declarationStatus?:'unavailable'};
 access:'public'|'authentication'|'captcha'|'paywall'|'authenticated_owner_account';
 ownerAccountAccess?:OwnerAccountAccess;
 legalClassification:'not_assessed';
 publication:'facts_with_attribution_only';
 ownerRobotsOverride?:OwnerRobotsOverride;
 robotsStatus?:'allowed'|'disallowed'|'unavailable';
 override?:'owner-approved 2026-10-11';
 ownerTdmOverride?:OwnerRobotsOverride;
 tdmOverride?:'owner-approved 2026-10-11';
 documentOrigin?:DocumentOriginClassification;
}
export interface TdmRule {location:string;'tdm-reservation':0|1;'tdm-policy'?:string}

export const MAX_POLICY_METADATA_EVIDENCE=64;
const policyDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
const metadataLocators:Record<string,true>={
 'HTTP TDM-Reservation':true,'HTTP TDM-Policy':true,'HTTP X-Robots-Tag':true,
 'HTML meta[name=tdm-reservation]':true,'HTML meta[name=tdm-policy]':true,'HTML meta[name=robots]':true,
 'robots.txt applicable StadtstackData group':true,'robots.txt HTTP absence':true,
 'Actual robots retrieval/interpretation attempt unavailable':true,'Robots representation rejected before raw retention':true,
 'W3C TDMRep origin rules':true,'TDMRep standardized location HTTP absence':true,'TDMRep matching location':true,
 'TDMRep standardized location HTTP absence after same-host redirect':true,
 'Machine policy retrieval or interpretation failed':true,'Policy evidence digest':true,'Policy evidence inventory':true,
};
const metadataValues:Record<string,true>={
 '0':true,'1':true,'checked':true,'404':true,'410':true,'unavailable':true,'inaccessible':true,
 'noai':true,'noimageai':true,'noai,noimageai':true,'no_tdm_reservation_field':true,
 'metadata_parse_failed':true,'metadata_unavailable':true,'metadata_too_large':true,
 'policy_reference_present':true,'invalid_policy_reference':true,'unstructured_policy_evidence':true,'policy_evidence_inventory':true,
 'invalid_reservation_declaration':true,
};
export function isPolicyMetadataUrl(value:string):boolean{
 return typeof value==='string'&&value.length<=8192&&!/\s/.test(value)&&ownerRobotsOverrideFor(value)!==null;
}
export function isValidTdmPolicyReference(value:string):boolean{
 return typeof value==='string'&&value.length<=1024&&/^https?:\/\/\S+$/i.test(value)&&isPolicyMetadataUrl(value);
}
export function isContentFreePolicyEvidence(item:PolicyEvidence):boolean{
 if(!isPolicyMetadataUrl(item.url)||!(Object.hasOwn(metadataLocators,item.locator)||/^PDF\.js (?:\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,40})?|fixture) XMP metadata \(pdf-tdm-v\d{1,3}\)$/.test(item.locator))||!Object.hasOwn(metadataValues,item.value))return false;
 if(item.locator==='HTTP TDM-Policy'||item.locator==='HTML meta[name=tdm-policy]'){
  if(!['policy_reference_present','invalid_policy_reference'].includes(item.value)||!item.valueSha256||item.valueBytes===undefined)return false;
 }
 if(item.value==='invalid_reservation_declaration'&&(!['HTTP TDM-Reservation','HTML meta[name=tdm-reservation]'].includes(item.locator)||!item.valueSha256||item.valueBytes===undefined))return false;
 if(['unstructured_policy_evidence','policy_evidence_inventory'].includes(item.value)&&(!item.valueSha256||item.valueBytes===undefined))return false;
 if(item.locator==='Policy evidence digest'&&(!item.locatorSha256||item.locatorBytes===undefined))return false;
 if(item.value==='policy_evidence_inventory'&&item.itemCount===undefined)return false;
 return true;
}
function projectPolicyEvidence(item:PolicyEvidence):PolicyEvidence{
 if(isContentFreePolicyEvidence(item))return {...item};
 const reference=item.locator==='HTTP TDM-Policy'||item.locator==='HTML meta[name=tdm-policy]';
 const locator=Object.hasOwn(metadataLocators,item.locator)||/^PDF\.js (?:\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,40})?|fixture) XMP metadata \(pdf-tdm-v\d{1,3}\)$/.test(item.locator)?item.locator:'Policy evidence digest';
 let value=Object.hasOwn(metadataValues,item.value)?item.value:'unstructured_policy_evidence';
 if(reference)value=isValidTdmPolicyReference(item.value)?'policy_reference_present':'invalid_policy_reference';
 else if(item.locator==='HTTP X-Robots-Tag'||item.locator==='HTML meta[name=robots]'){
  const directives:string[]=[];
  if(/(?:^|,)\s*noai\s*(?:,|$)/i.test(item.value))directives.push('noai');
  if(/(?:^|,)\s*noimageai\s*(?:,|$)/i.test(item.value))directives.push('noimageai');
  if(directives.length)value=directives.join(',');
 }
 return {url:item.url,locator,value,...(item.sha256?{sha256:item.sha256}:{}),...(item.checkedAt?{checkedAt:item.checkedAt}:{}),valueSha256:policyDigest(item.value),valueBytes:Buffer.byteLength(item.value),...(locator!==item.locator||locator==='Policy evidence digest'?{locatorSha256:policyDigest(item.locator),locatorBytes:Buffer.byteLength(item.locator)}:{})};
}
function boundedPolicyEvidence(items:PolicyEvidence[]):{evidence:PolicyEvidence[];unavailable:boolean;declarationUnavailable:boolean}{
 const evidence:PolicyEvidence[]=[],inventory=createHash('sha256');let bytes=0,unavailable=false,declarationUnavailable=false;
 for(const item of items){
  const projected=projectPolicyEvidence(item),serialized=JSON.stringify(projected);
  inventory.update(serialized).update('\\n');bytes+=Buffer.byteLength(item.value);
  unavailable ||= projected.value==='invalid_policy_reference';
  declarationUnavailable ||= projected.value==='invalid_reservation_declaration';
  if(evidence.length<(items.length>MAX_POLICY_METADATA_EVIDENCE?MAX_POLICY_METADATA_EVIDENCE-1:MAX_POLICY_METADATA_EVIDENCE))evidence.push(projected);
 }
 if(items.length>MAX_POLICY_METADATA_EVIDENCE)evidence.push({url:items[0].url,locator:'Policy evidence inventory',value:'policy_evidence_inventory',valueSha256:inventory.digest('hex'),valueBytes:bytes,itemCount:items.length});
 return {evidence,unavailable,declarationUnavailable};
}
/** Content-free persistence codec. Declarations are retained, never rewritten as permission. */
export function projectSourcePolicyMetadata(policy:SourceAccessPolicy):SourceAccessPolicy{
 const projected=boundedPolicyEvidence(policy.tdm.evidence),origin=policy.documentOrigin;
 let documentOrigin=origin;
 if(origin){
  const inventory=createHash('sha256'),evidence:DocumentOriginClassification['evidence']=[];
  for(const item of origin.evidence){
   const already=/^origin-rule-(?:digest|inventory)$/.test(item.locator)&&/^sha256:[a-f0-9]{64}$/.test(item.value),encoded=JSON.stringify([item.locator,item.value]);
   inventory.update(encoded).update('\\n');
   if(evidence.length<(origin.evidence.length>64?63:64))evidence.push(already?item:{locator:'origin-rule-digest',value:'sha256:'+policyDigest(encoded)});
  }
  if(origin.evidence.length>64)evidence.push({locator:'origin-rule-inventory',value:'sha256:'+inventory.digest('hex')});
  documentOrigin={...origin,evidence};
 }
 return {...policy,tdm:{...policy.tdm,evidence:projected.evidence,...(projected.unavailable?{referenceStatus:'unavailable' as const}:{}),...(projected.declarationUnavailable?{declarationStatus:'unavailable' as const}:{})},...(documentOrigin?{documentOrigin}:{})};
}

/** Evaluate robots only. Access, TDM (including PDF metadata), DNS and source binding remain separate gates. */
export function effectiveRobotsPermission(policy:SourceAccessPolicy,documentUrl:string):boolean {
 if(policy.robots.state==='allowed')return policy.ownerRobotsOverride===undefined&&policy.override===undefined&&(policy.robotsStatus===undefined||policy.robotsStatus==='allowed');
 if(!ownerRobotsOverrideApplies(documentUrl,policy.ownerRobotsOverride)||policy.robotsStatus!==(policy.robots.state==='blocked'?'disallowed':'unavailable')||policy.override!=='owner-approved 2026-10-11')return false;
 if(!policy.robots.checkedAt||!Number.isFinite(Date.parse(policy.robots.checkedAt)))return false;
 if(policy.robots.state==='blocked'&&(!policy.robots.sha256||!/^[a-f0-9]{64}$/.test(policy.robots.sha256)))return false;
 try{
  const document=new URL(documentUrl),robots=new URL(policy.robots.url);
  return ownerRobotsOverrideApplies(robots.href,policy.ownerRobotsOverride)&&robots.origin===document.origin&&robots.pathname==='/robots.txt'&&!robots.search&&!robots.hash;
 }catch{return false;}
}

/** Unknown is never promoted to official; legacy ordinary policies may omit classification. */
export function documentOriginExcludes(policy:SourceAccessPolicy,document:{url:string;sha256:string}):boolean {
 if(!policy.documentOrigin)return Boolean(policy.ownerRobotsOverride||policy.ownerTdmOverride||policy.robots.state==='blocked'||policy.tdm.state==='reserved');
 const parsed=DocumentOriginSchema.safeParse(policy.documentOrigin);
 if(!parsed.success||parsed.data.url!==document.url||parsed.data.sha256!==document.sha256)return true;
 if((policy.robots.state==='blocked'||policy.tdm.state==='reserved')&&parsed.data.classifierVersion!==DOCUMENT_ORIGIN_CLASSIFIER_VERSION)return true;
 return parsed.data.classification!=='official_work'&&(policy.robots.state==='blocked'||policy.tdm.state==='reserved');
}
/** Shared pre-CAS/pre-model admission; PDF metadata completeness is additionally checked by the schema gate. */
export function effectiveSourcePermission(policy:SourceAccessPolicy,document:{url:string;sha256:string}):boolean {
 if(!effectiveRobotsPermission(policy,document.url)||!effectiveAccountAccess(policy,document.url)||policy.tdm.state==='unavailable'||policy.tdm.referenceStatus==='unavailable'||policy.tdm.declarationStatus==='unavailable'||documentOriginExcludes(policy,document))return false;
 if(policy.tdm.state==='reserved')return policy.documentOrigin?.classification==='official_work'&&policy.tdmOverride==='owner-approved 2026-10-11'&&ownerRobotsOverrideApplies(document.url,policy.ownerTdmOverride);
 return policy.ownerTdmOverride===undefined&&policy.tdmOverride===undefined;
}

/** Prefix glob with '*' and optional trailing '$'; never compile remote patterns as regex. */
export function matchesPolicyPattern(pattern:string,value:string):boolean {
 const end=pattern.endsWith('$'),parts=(end?pattern.slice(0,-1):pattern).split('*'),first=parts[0];
 if(!value.startsWith(first))return false;
 let position=first.length;
 if(parts.length===1)return !end||position===value.length;
 const suffix=end?parts.pop()!:null;
 for(let index=1;index<parts.length;index++){
  const part=parts[index];if(!part)continue;
  const found=value.indexOf(part,position);if(found<0)return false;position=found+part.length;
 }
 return suffix===null||value.length-suffix.length>=position&&value.endsWith(suffix);
}
/** W3C TDMRep 2024 §6.1: first matching rule wins; this is not a copyright licence. */
export function tdmRuleForUrl(rules:TdmRule[],url:string):TdmRule|undefined {
 const target=new URL(url),normalize=(value:string)=>value.replace(/%([0-9a-f]{2})/gi,(_,hex:string)=>{const char=String.fromCharCode(Number.parseInt(hex,16));return /[A-Za-z0-9._~-]/.test(char)?char:'%'+hex.toUpperCase();}).replace(/[^\x00-\x7F]/gu,char=>encodeURIComponent(char));
 const path=normalize(target.pathname+target.search);
 for(const rule of rules){
  if(matchesPolicyPattern(normalize(rule.location),path))return rule;
 }
 return undefined;
}
export function parseTdmRules(value:unknown):TdmRule[]{
 if(!Array.isArray(value)||value.length>10_000)throw Error('TDMRep must be a bounded array');
 for(const item of value)if(!item||typeof item!=='object'||Object.keys(item).some(key=>!['location','tdm-reservation','tdm-policy'].includes(key))||typeof item.location!=='string'||!item.location.startsWith('/')||item.location.length>2048||![0,1].includes(item['tdm-reservation'])||item['tdm-policy']!==undefined&&(typeof item['tdm-policy']!=='string'||!isValidTdmPolicyReference(item['tdm-policy'])))throw Error('Invalid TDMRep rule');
 return value as TdmRule[];
}
export interface TdmReservationDeclaration {state:'absent'|'valid'|'invalid';reservation:0|1|null}
/** Only one exact scalar is a valid update; combined fields never erase a known reservation. */
export function parseTdmReservation(value:string|undefined):TdmReservationDeclaration{
 if(value===undefined)return {state:'absent',reservation:null};
 const scalar=value.trim();
 if(scalar==='0'||scalar==='1')return {state:'valid',reservation:Number(scalar) as 0|1};
 return {state:'invalid',reservation:scalar.split(',').some(token=>token.trim()==='1')?1:null};
}
export interface ResourcePolicyInspection {reservation:0|1|null;evidence:PolicyEvidence[];access:SourceAccessPolicy['access'];unavailable:boolean;referenceUnavailable:boolean;declarationUnavailable:boolean}
export function inspectResourcePolicy(url:string,headers:Record<string,string|undefined>,body:Buffer,mimeType:string):ResourcePolicyInspection {
 const evidence:PolicyEvidence[]=[];let reservation:0|1|null=null,access:SourceAccessPolicy['access']='public';
 const recordReservation=(value:string|undefined,locator:string)=>{
  const parsed=parseTdmReservation(value);
  if(parsed.reservation!==null){if(reservation!==1)reservation=parsed.reservation;evidence.push({url,locator,value:String(parsed.reservation)});}
  if(parsed.state==='invalid')evidence.push({url,locator,value:'invalid_reservation_declaration',valueSha256:policyDigest(value!),valueBytes:Buffer.byteLength(value!)});
 };
 recordReservation(headers['tdm-reservation'],'HTTP TDM-Reservation');
 if(headers['tdm-policy']!==undefined)evidence.push({url,locator:'HTTP TDM-Policy',value:headers['tdm-policy']});
 if(/(?:^|,)\s*(?:noai|noimageai)\s*(?:,|$)/i.test(headers['x-robots-tag']??'')){reservation=1;evidence.push({url,locator:'HTTP X-Robots-Tag',value:headers['x-robots-tag']!});}
 const looksLikeHtml=/^<(?:!doctype\s+html|html|head|body|title|form|div)\b/i.test(body.subarray(0,256).toString('utf8').trimStart());
 if(/html/.test(mimeType)||looksLikeHtml){
  const $=load(body.toString('utf8')),title=$('title,h1').text().replace(/\s+/g,' ').trim();
  $('meta[name]').each((_,element)=>{
   const name=($(element).attr('name')??'').toLowerCase(),rawValue=$(element).attr('content')??'',value=rawValue.trim();
   if(name==='tdm-reservation')recordReservation(rawValue,'HTML meta[name=tdm-reservation]');
   if(name==='tdm-policy')evidence.push({url,locator:'HTML meta[name=tdm-policy]',value});
   if(name==='robots'&&/(?:^|,)\s*(?:noai|noimageai)\s*(?:,|$)/i.test(value)){reservation=1;evidence.push({url,locator:'HTML meta[name=robots]',value});}
  });
  if(/captcha|verify (?:that )?you are human|just a moment|sicherheitsüberprüfung|access denied|zugriff verweigert/i.test(title)||$('#challenge-form,#cf-challenge-running').length)access='captcha';
  else if($('input[type=password]').length&&/login|log in|anmeld|authentifiz|sign in/i.test(title))access='authentication';
  else if(/paywall|payment required|zahlung erforderlich|abonnement erforderlich/i.test(title))access='paywall';
 }
 const projected=boundedPolicyEvidence(evidence);
 return {reservation,evidence:projected.evidence,access,unavailable:projected.unavailable||projected.declarationUnavailable,referenceUnavailable:projected.unavailable,declarationUnavailable:projected.declarationUnavailable};
}
