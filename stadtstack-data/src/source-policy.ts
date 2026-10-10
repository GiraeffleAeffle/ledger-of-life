import {load} from 'cheerio';

export interface PolicyEvidence {url:string;locator:string;value:string;sha256?:string;checkedAt?:string}
export interface SourceAccessPolicy {
 robots:{state:'allowed'|'blocked'|'unavailable';url:string;sha256?:string;checkedAt?:string};
 tdm:{state:'reserved'|'not_reserved'|'not_declared'|'unavailable';evidence:PolicyEvidence[]};
 access:'public'|'authentication'|'captcha'|'paywall';
 legalClassification:'not_assessed';
 publication:'facts_with_attribution_only';
}
export interface TdmRule {location:string;'tdm-reservation':0|1;'tdm-policy'?:string}

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
