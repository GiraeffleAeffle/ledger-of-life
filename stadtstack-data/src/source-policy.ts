import {load} from 'cheerio';
import {isIP} from 'node:net';
import {isPublicAddress} from './public-address.ts';
import {DocumentOriginSchema,type DocumentOriginClassification} from './document-origin.ts';

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

export interface PolicyEvidence {url:string;locator:string;value:string;sha256?:string;checkedAt?:string}
export interface SourceAccessPolicy {
 robots:{state:'allowed'|'blocked'|'unavailable';url:string;sha256?:string;checkedAt?:string};
 tdm:{state:'reserved'|'not_reserved'|'not_declared'|'unavailable';evidence:PolicyEvidence[]};
 access:'public'|'authentication'|'captcha'|'paywall';
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
 return parsed.data.classification!=='official_work'&&(policy.robots.state==='blocked'||policy.tdm.state==='reserved');
}
/** Shared pre-CAS/pre-model admission; PDF metadata completeness is additionally checked by the schema gate. */
export function effectiveSourcePermission(policy:SourceAccessPolicy,document:{url:string;sha256:string}):boolean {
 if(!effectiveRobotsPermission(policy,document.url)||policy.access!=='public'||policy.tdm.state==='unavailable'||documentOriginExcludes(policy,document))return false;
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
 if(!Array.isArray(value))throw Error('TDMRep must be an array');
 for(const item of value)if(!item||typeof item!=='object'||typeof item.location!=='string'||!item.location.startsWith('/')||![0,1].includes(item['tdm-reservation'])||item['tdm-policy']!==undefined&&typeof item['tdm-policy']!=='string')throw Error('Invalid TDMRep rule');
 return value as TdmRule[];
}
export function inspectResourcePolicy(url:string,headers:Record<string,string|undefined>,body:Buffer,mimeType:string):{reservation:0|1|null;evidence:PolicyEvidence[];access:SourceAccessPolicy['access']} {
 const evidence:PolicyEvidence[]=[];let reservation:0|1|null=null,access:SourceAccessPolicy['access']='public';
 const header=headers['tdm-reservation']?.trim();
 if(header==='0'||header==='1'){reservation=Number(header) as 0|1;evidence.push({url,locator:'HTTP TDM-Reservation',value:header});}
 if(headers['tdm-policy'])evidence.push({url,locator:'HTTP TDM-Policy',value:headers['tdm-policy']});
 if(/(?:^|,)\s*(?:noai|noimageai)\s*(?:,|$)/i.test(headers['x-robots-tag']??'')){reservation=1;evidence.push({url,locator:'HTTP X-Robots-Tag',value:headers['x-robots-tag']!});}
 const looksLikeHtml=/^<(?:!doctype\s+html|html|head|body|title|form|div)\b/i.test(body.subarray(0,256).toString('utf8').trimStart());
 if(/html/.test(mimeType)||looksLikeHtml){
  const $=load(body.toString('utf8')),title=$('title,h1').text().replace(/\s+/g,' ').trim();
  $('meta[name]').each((_,element)=>{
   const name=($(element).attr('name')??'').toLowerCase(),value=($(element).attr('content')??'').trim();
   if(name==='tdm-reservation'&&(value==='0'||value==='1')){if(reservation!==1)reservation=Number(value) as 0|1;evidence.push({url,locator:'HTML meta[name=tdm-reservation]',value});}
   if(name==='tdm-policy')evidence.push({url,locator:'HTML meta[name=tdm-policy]',value});
   if(name==='robots'&&/(?:^|,)\s*(?:noai|noimageai)\s*(?:,|$)/i.test(value)){reservation=1;evidence.push({url,locator:'HTML meta[name=robots]',value});}
  });
  if(/captcha|verify (?:that )?you are human|just a moment|sicherheitsüberprüfung|access denied|zugriff verweigert/i.test(title)||$('#challenge-form,#cf-challenge-running').length)access='captcha';
  else if($('input[type=password]').length&&/login|log in|anmeld|authentifiz|sign in/i.test(title))access='authentication';
  else if(/paywall|payment required|zahlung erforderlich|abonnement erforderlich/i.test(title))access='paywall';
 }
 return {reservation,evidence,access};
}
