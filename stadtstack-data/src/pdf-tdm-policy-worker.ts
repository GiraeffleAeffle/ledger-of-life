import {XMLParser,XMLValidator} from 'fast-xml-parser';

// Isolated process: input and diagnostics never leave this worker. Only TDM findings are emitted.
const MAX_INPUT=32*1024*1024,MAX_METADATA=1024*1024,MAX_NODES=50000;
const WORKER_POLICY_VERSION='pdf-tdm-v2';
let metadataProblem=false;
const observeDiagnostic=(...values:unknown[])=>{
 if(values.some(value=>typeof value==='string'&&/metadata|xmp/i.test(value)&&/invalid|skipp|fail|error/i.test(value)))metadataProblem=true;
};
console.log=observeDiagnostic;console.info=observeDiagnostic;console.warn=observeDiagnostic;console.error=observeDiagnostic;
interface Findings {state:'checked';reservation:0|1|null;policyPresent:boolean;metadataPresent:boolean}
class MetadataFailure extends Error {reason:string;constructor(reason:string){super(reason);this.reason=reason;}}
const predefined:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
/** Decode XML atoms once, after parsing structure. Replacement output is never rescanned. */
function decodeXmlReferences(value:unknown):string {
 if(typeof value!=='string')throw new MetadataFailure('metadata_parse_error');
 return value.replace(/&([^;&]*);/g,(_whole,reference:string)=>{
  if(Object.hasOwn(predefined,reference))return predefined[reference];
  let point:number;
  if(/^#x[0-9a-fA-F]+$/.test(reference))point=Number.parseInt(reference.slice(2),16);
  else if(/^#[0-9]+$/.test(reference))point=Number.parseInt(reference.slice(1),10);
  else throw new MetadataFailure('invalid_xml_reference');
  if(!(point===9||point===10||point===13||point>=0x20&&point<=0xd7ff||point>=0xe000&&point<=0xfffd||point>=0x10000&&point<=0x10ffff))throw new MetadataFailure('invalid_xml_reference');
  return String.fromCodePoint(point);
 });
}

async function main():Promise<Findings>{
 const chunks:Buffer[]=[];let length=0;
 for await(const chunk of process.stdin){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>MAX_INPUT)throw new MetadataFailure('size_limit');chunks.push(bytes);}
 if(!length)throw new MetadataFailure('parse_error');
 const bytes=Buffer.concat(chunks,length);
 // Stream dictionaries cannot themselves be Flate-compressed PDF object streams. Decode PDF Name escapes
 // so an unreadable /Metadata stream cannot silently turn into "no metadata" in PDF.js's forgiving API.
 let metadataObjectPresent=false;
 const names=/\/(?:#[0-9A-Fa-f]{2}|[A-Za-z])+/g;
 for(const match of bytes.toString('latin1').matchAll(names)){
  const name=match[0].replace(/#([0-9a-f]{2})/gi,(_,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)));
  if(name==='/Metadata'){metadataObjectPresent=true;break;}
 }
 // PDF.js's platform bootstrap may log during import; the isolated stdout-redaction hook must run first.
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength),useSystemFonts:false,disableFontFace:true,stopAtErrors:true,verbosity:5});
 try{
  const document=await task.promise,{metadata}=await document.getMetadata();
  if(metadataProblem)throw new MetadataFailure('metadata_parse_error');
  if(!metadata){if(metadataObjectPresent)throw new MetadataFailure('metadata_unreadable');return {state:'checked',reservation:null,policyPresent:false,metadataPresent:false};}
  const raw=metadata.getRaw();
  if(!raw||Buffer.byteLength(raw)>MAX_METADATA)throw new MetadataFailure(raw?'metadata_size_limit':'metadata_parse_error');
  if(/<!DOCTYPE|<!ENTITY/i.test(raw)||XMLValidator.validate(raw)!==true)throw new MetadataFailure('metadata_parse_error');
  // FXP's numeric decoder depends on its HTML mode. Keep atoms raw and perform XML-only,
  // single-pass decoding below; otherwise &amp;#49; risks being decoded twice.
  const parsed:unknown=new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false,parseAttributeValue:false,processEntities:false,cdataPropName:'#cdata'}).parse(raw);
  let nodes=0,reservation:0|1|null=null,policyPresent=false;
  const isTdm=(namespace:string|undefined)=>namespace==='http://www.w3.org/ns/tdmrep/'||namespace==='http://www.w3.org/ns/tdmrep#';
  const readValue=(name:string,value:unknown)=>{
   if(typeof value!=='string')throw new MetadataFailure('metadata_parse_error');
   if(name==='policy'){policyPresent ||= value.trim().length>0;return;}
   const clean=value.trim();if(clean!=='0'&&clean!=='1')throw new MetadataFailure('invalid_tdm_reservation');
   if(clean==='1'||reservation===null)reservation=Number(clean) as 0|1;
  };
  const visit=(items:unknown,inherited:Record<string,string>,depth:number)=>{
   if(depth>64||!Array.isArray(items))throw new MetadataFailure('metadata_structure_limit');
   for(const item of items){
    if(++nodes>MAX_NODES||!item||typeof item!=='object')throw new MetadataFailure('metadata_structure_limit');
    const node=item as Record<string,unknown>,attributes=node[':@'] as Record<string,unknown>|undefined;
    const bindings:Record<string,string>=Object.assign(Object.create(null),inherited);
    for(const [key,value] of Object.entries(attributes??{}))if(typeof value==='string'){
     if(key==='@_xmlns')bindings['']=decodeXmlReferences(value);else if(key.startsWith('@_xmlns:'))bindings[key.slice(8)]=decodeXmlReferences(value);
    }
    for(const [key,value] of Object.entries(attributes??{})){
     const match=/^@_([^:]+):(reservation|policy)$/.exec(key);
     if(match&&isTdm(bindings[match[1]]))readValue(match[2],decodeXmlReferences(value));
    }
    for(const [key,value] of Object.entries(node)){
     if(key===':@'||key==='#text'||key==='#cdata'||key.startsWith('?')||key.startsWith('!'))continue;
     const split=key.indexOf(':'),prefix=split<0?'':key.slice(0,split),name=split<0?key:key.slice(split+1);
     // Inspect values only for properties in the TDM namespace. Other metadata is not exported or interpreted.
     if(isTdm(bindings[prefix])&&(name==='reservation'||name==='policy')){
      if(!Array.isArray(value))throw new MetadataFailure('metadata_parse_error');
      const text=value.map(part=>{
       if(!part||typeof part!=='object'||Object.keys(part).length!==1)throw new MetadataFailure('metadata_parse_error');
       if('#text' in part)return decodeXmlReferences(part['#text']);
       if('#cdata' in part){
        const cdata=part['#cdata'];
        if(!Array.isArray(cdata)||cdata.length!==1||!cdata[0]||typeof cdata[0]!=='object'||Object.keys(cdata[0]).length!==1||typeof cdata[0]['#text']!=='string')throw new MetadataFailure('metadata_parse_error');
        return cdata[0]['#text']; // XML references are literal inside CDATA.
       }
       throw new MetadataFailure('metadata_parse_error');
      }).join('');
      readValue(name,text);
     }else visit(value,bindings,depth+1);
    }
   }
  };
  visit(parsed,{},0);return {state:'checked',reservation,policyPresent,metadataPresent:true};
 }catch(error){
  if(error instanceof MetadataFailure)throw error;
  throw new MetadataFailure(error instanceof Error&&error.name==='PasswordException'?'encrypted_pdf':'parse_error');
 }finally{await task.destroy();}
}
main().then(result=>process.stdout.write(JSON.stringify({policyVersion:WORKER_POLICY_VERSION,...result})+'\n')).catch(error=>{
 process.stdout.write(JSON.stringify({policyVersion:WORKER_POLICY_VERSION,state:'unavailable',reason:error instanceof MetadataFailure?error.reason:'worker_error'})+'\n');
});
