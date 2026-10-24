export const STEP8_JSON_LIMIT_BYTES=64*1024*1024;

function stringBytes(value:string){
 let bytes=2;
 for(let index=0;index<value.length;index++){
  const code=value.charCodeAt(index);
  if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)bytes+=2;
  else if(code<32)bytes+=6;
  else if(code<128)bytes++;
  else if(code<2048)bytes+=2;
  else if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(index+1);if(next>=0xdc00&&next<=0xdfff){bytes+=4;index++;}else bytes+=6;}
  else bytes+=code>=0xdc00&&code<=0xdfff?6:3;
 }
 return bytes;
}

/** Exact UTF-8 size of JSON.stringify(value,null,2)+'\n', without constructing
 * that string. Refuse during traversal, before V8's string/allocation ceiling.
 * Operator JSON is ordinary data: unsupported objects/toJSON hooks fail closed. */
export function step8JsonBytes(value:unknown,label='JSON',maximum=STEP8_JSON_LIMIT_BYTES,initialDepth=0){
 let bytes=1;const ancestors=new Set<object>();
 const add=(count:number)=>{bytes+=count;if(bytes>=maximum)throw Error(`Step8 JSON size limit: ${label} requires at least ${bytes} bytes; maximum exclusive ${maximum}`);};
 const visit=(item:unknown,depth:number,inArray=false):void=>{
  if(item===null||item===undefined&&inArray){add(4);return;}
  if(typeof item==='string'){add(stringBytes(item));return;}
  if(typeof item==='number'){add(Number.isFinite(item)?String(item).length:4);return;}
  if(typeof item==='boolean'){add(item?4:5);return;}
  if(typeof item!=='object'||item===undefined)throw Error('Unsupported Step8 JSON value: '+label);
  if(ancestors.has(item))throw Error('Cyclic Step8 JSON value: '+label);
  if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw Error('Non-data Step8 JSON object: '+label);
  ancestors.add(item);const array=Array.isArray(item),keys=array?undefined:Object.keys(item).filter(key=>(item as Record<string,unknown>)[key]!==undefined),length=array?item.length:keys!.length;
  add(2);if(length){add(1);for(let index=0;index<length;index++){
   add(2*(depth+1));const key=array?index:keys![index],child=(item as Record<string|number,unknown>)[key];if(!array)add(stringBytes(String(key))+2);
   visit(child,depth+1,array);add(index===length-1?1:2);
  }add(2*depth);}ancestors.delete(item);
 };
 visit(value,initialDepth);return bytes;
}
export function encodeStep8Json(value:unknown,label='JSON',maximum=STEP8_JSON_LIMIT_BYTES){
 const expected=step8JsonBytes(value,label,maximum),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
 if(bytes.length!==expected)throw Error('Step8 JSON size calculation mismatch: '+label);
 return bytes;
}
export function assertStep8JsonArtifact(name:string,bytes:Uint8Array){
 if(/\.(?:json|geojson)$/.test(name)&&bytes.length>=STEP8_JSON_LIMIT_BYTES)throw Error(`Step8 JSON size limit: ${name} is ${bytes.length} bytes`);
}
