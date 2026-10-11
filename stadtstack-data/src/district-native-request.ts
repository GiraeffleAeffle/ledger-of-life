import {z} from 'zod';
export type NativePublicOperation='genesis_guest'|'ted_search';
const tedBody=z.object({query:z.string().min(1).max(4000),fields:z.array(z.string().min(1).max(100)).min(1).max(30),limit:z.number().int().min(1).max(100),scope:z.literal('ALL'),paginationMode:z.literal('ITERATION'),onlyLatestVersions:z.literal(false),iterationNextToken:z.string().max(16000).optional()}).strict();
/** Public operation profiles, not a caller-controlled authentication/header escape hatch. */
export function nativePublicRequestHeaders(url:URL,method:'GET'|'POST',body:string|undefined,operation?:NativePublicOperation):Record<string,string>{
 if(method!=='POST')return {};
 if(!body||Buffer.byteLength(body)>65536)throw Error('Native public request bound rejected');
 if(operation==='genesis_guest'){
  if(url.origin!=='https://www.regionalstatistik.de'||!/^\/genesisws\/rest\/2020\/(?:metadata\/table|data\/table(?:file)?)$/.test(url.pathname)||url.search)throw Error('GENESIS guest profile endpoint mismatch');
  const params=new URLSearchParams(body),allowed=['name','area','language','regionalvariable','regionalkey','startyear','endyear','compress','transpose','job','format','quality'];
  if([...params.keys()].some(key=>!allowed.includes(key))||[...params.keys()].some(key=>params.getAll(key).length!==1)||params.get('area')!=='free'||params.get('language')!=='de'||!/^\d{5}-\d{2}-\d{2}$/.test(params.get('name')??''))throw Error('GENESIS public selector rejected');
  if(url.pathname.includes('/data/')&&(!/^\d{5}(?:\d{3})?$/.test(params.get('regionalkey')??'')||!/^\d{4}$/.test(params.get('startyear')??'')||params.get('startyear')!==params.get('endyear')||['compress','transpose','job'].some(key=>params.get(key)!=='false')))throw Error('GENESIS data request must be single-region single-year synchronous');
  return {'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',username:'GAST',password:'GAST'};
 }
 if(operation==='ted_search'){
  if(url.href!=='https://api.ted.europa.eu/v3/notices/search')throw Error('TED public profile endpoint mismatch');
  tedBody.parse(JSON.parse(body));return {'Content-Type':'application/json'};
 }
 return {'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'};
}
