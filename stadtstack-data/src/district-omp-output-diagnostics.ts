import {z} from 'zod';
import {canonicalJson} from './district-adapter-contract.ts';

const bounded=z.number().int().min(0).max(96*1024),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const OmpOutputDeliverySchema=z.object({requestSha256:hash,systemPromptSha256:hash}).strict();
export const OmpStdinDeliverySchema=z.object({intendedBytes:z.number().int().min(0).max(512*1024),deliveredBytes:z.number().int().min(0).max(512*1024),deliveredSha256:hash,frameBytes:z.number().int().min(2).max(528*1024+1)}).strict();
export type OmpStdinDelivery=z.infer<typeof OmpStdinDeliverySchema>;
export type OmpOutputDelivery=z.infer<typeof OmpOutputDeliverySchema>&{stdin:OmpStdinDelivery};
const lengths=z.object({utf16:bounded,bytes:bounded,leadingWhitespace:bounded,trailingWhitespace:bounded}).strict();
const fence=z.object({opening:z.enum(['json','JSON','unlabelled','other','none']),closing:z.enum(['exact','whitespace','other','none']),exactWrapper:z.boolean()}).strict();
const objects=z.object({count:bounded,offsets:z.array(z.tuple([bounded,bounded])).max(4),leadingNonJson:bounded.nullable(),trailingNonJson:bounded.nullable()}).strict();
const syntax=z.object({balance:z.number().int().min(-96*1024).max(96*1024),minimum:z.number().int().min(-96*1024).max(96*1024),unclosedString:z.boolean(),unclosedContainers:bounded,mismatch:z.boolean(),parseCategory:z.enum(['valid','end','token','property','colon','delimiter','string','escape','control','number','other']),parsePosition:bounded.nullable(),parseInput:z.enum(['raw','wrapper'])}).strict();
const completion=z.object({stopReason:z.literal('stop'),outputTokens:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable()}).strict();
const sections={lengths,fence,objects,syntax,completion,delivery:OmpOutputDeliverySchema,stdin:OmpStdinDeliverySchema};
export const OmpOutputStructureSchema=z.object({version:z.literal('omp-output-structure-v3'),...sections}).strict().superRefine((value,ctx)=>{
 const n=value.lengths.utf16,o=value.objects;
 if(value.lengths.leadingWhitespace+value.lengths.trailingWhitespace>n||o.offsets.length!==Math.min(o.count,4)||o.offsets.some(([start,end],index)=>start>=end||end>n||index>0&&start<o.offsets[index-1]![1])||o.count!==1&&(o.leadingNonJson!==null||o.trailingNonJson!==null)||o.count===1&&(o.leadingNonJson!==o.offsets[0]![0]||o.trailingNonJson!==n-o.offsets[0]![1]))ctx.addIssue({code:'custom',message:'Invalid bounded output structure'});
});
export type OmpOutputStructure=z.infer<typeof OmpOutputStructureSchema>;
/** This is the existing, deliberately narrow normalization, not JSON extraction. */
export function exactOmpJsonFence(text:string):string|undefined{
 const match=/^[ \t\r\n]*```json\r?\n([\s\S]*)\r?\n```[ \t\r\n]*$/.exec(text);
 return match&&!/^[ \t]*```/m.test(match[1]!)?match[1]!:undefined;
}
/** Pure structural observation: never retain text, property names or parser prose. */
export function describeOmpOutput(text:string,delivery:OmpOutputDelivery,outputTokens:unknown):OmpOutputStructure{
 const {stdin,...hashes}=delivery;
 const wrapper=exactOmpJsonFence(text),input=wrapper??text;
 const leading=/^[ \t\r\n]*/.exec(text)![0].length,trailing=leading===text.length?0:/[ \t\r\n]*$/.exec(text)![0].length;
 const open=/^[ \t\r\n]*```([^\r\n]*)/.exec(text),close=/(?:^|\n)([^\r\n]*```[^\r\n]*)[ \t\r\n]*$/.exec(text);
 const opening=!open?'none':open[1]==='json'?'json':open[1]==='JSON'?'JSON':open[1]===''?'unlabelled':'other';
 const closing=!close?'none':close[1]==='```'?'exact':/^[ \t]*```[ \t]*$/.test(close[1]!)?'whitespace':'other';
 let quoted=false,escaped=false,balance=0,minimum=0,mismatch=false,start=-1,count=0;
 const stack:string[]=[],offsets:[number,number][]=[];
 for(let index=0;index<text.length;index++){
  const char=text[index]!;
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"'){quoted=true;continue;}
  if(char==='{')balance++;else if(char==='}')balance--;
  minimum=Math.min(minimum,balance);
  if(char==='{'||char==='['){if(!stack.length)start=char==='{'?index:-1;stack.push(char);}
  else if(char==='}'||char===']'){
   const opener=stack.pop();if(opener!==(char==='}'?'{':'['))mismatch=true;
   if(!stack.length&&start>=0){
    try{const value:unknown=JSON.parse(text.slice(start,index+1));if(value!==null&&typeof value==='object'&&!Array.isArray(value)){count++;if(offsets.length<4)offsets.push([start,index+1]);}}catch{/* Structure only; never accept the extracted candidate. */}
    start=-1;
   }
  }
 }
 let parseCategory:OmpOutputStructure['syntax']['parseCategory']='valid',parsePosition:number|null=null;
 try{JSON.parse(input);}catch(error){
  const message=error instanceof SyntaxError?error.message:'';
  const position=/at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
  if(position&&Number(position[1])<=input.length)parsePosition=Number(position[1]);
  if(message==='Unexpected end of JSON input'){parseCategory='end';parsePosition=input.length;}
  else if(message.startsWith('Unexpected token'))parseCategory='token';
  else if(message.startsWith('Expected property'))parseCategory='property';
  else if(message.startsWith("Expected ':'"))parseCategory='colon';
  else if(message.startsWith("Expected ','"))parseCategory='delimiter';
  else if(message.startsWith('Unterminated string'))parseCategory='string';
  else if(message.startsWith('Bad escaped')||message.startsWith('Bad Unicode escape'))parseCategory='escape';
  else if(message.startsWith('Bad control character'))parseCategory='control';
  else if(message.startsWith('No number')||message.startsWith('Unterminated fractional')||message.startsWith('Exponent part'))parseCategory='number';
  else parseCategory='other';
 }
 return OmpOutputStructureSchema.parse({version:'omp-output-structure-v3',lengths:{utf16:text.length,bytes:Buffer.byteLength(text),leadingWhitespace:leading,trailingWhitespace:trailing},fence:{opening,closing,exactWrapper:wrapper!==undefined},objects:{count,offsets,leadingNonJson:count===1?offsets[0]![0]:null,trailingNonJson:count===1?text.length-offsets[0]![1]:null},syntax:{balance,minimum,unclosedString:quoted,unclosedContainers:stack.length,mismatch,parseCategory,parsePosition,parseInput:wrapper===undefined?'raw':'wrapper'},completion:{stopReason:'stop',outputTokens:typeof outputTokens==='number'&&Number.isSafeInteger(outputTokens)&&outputTokens>=0?outputTokens:null},delivery:hashes,stdin});
}
/** Eight independently bounded codec slots; no lossy clipping or free-form fields. */
export function ompOutputStructureVersions(input:OmpOutputStructure):Record<string,string>{
 const value=OmpOutputStructureSchema.parse(input),versions:Record<string,string>={ompStructureVersion:value.version};
 for(const key of Object.keys(sections) as (keyof typeof sections)[]){const encoded=canonicalJson(value[key]);if(Buffer.byteLength(encoded)>256)throw new Error('Output structure codec bound');versions['ompStructure'+key[0]!.toUpperCase()+key.slice(1)]=encoded;}
 return versions;
}
export function ompOutputStructureFromVersions(versions:Record<string,string>):OmpOutputStructure|null{
 const value:Record<string,unknown>={version:versions.ompStructureVersion};
 try{for(const key of Object.keys(sections)){const encoded=versions['ompStructure'+key[0]!.toUpperCase()+key.slice(1)];if(typeof encoded!=='string'||Buffer.byteLength(encoded)>256)return null;value[key]=JSON.parse(encoded);}}catch{return null;}
 const parsed=OmpOutputStructureSchema.safeParse(value);return parsed.success?parsed.data:null;
}
