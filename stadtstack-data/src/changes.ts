import type {Signal} from './schema.ts';
export interface Changes {added:string[];changed:string[];removed:string[];generatedAt?:string}
export function diff(previous:Signal[],current:Signal[]):Changes{const before=new Map(previous.map(f=>[f.properties.id,f.properties.version])),after=new Map(current.map(f=>[f.properties.id,f.properties.version]));return {added:[...after.keys()].filter(id=>!before.has(id)).sort(),changed:[...after.keys()].filter(id=>before.has(id)&&before.get(id)!==after.get(id)).sort(),removed:[...before.keys()].filter(id=>!after.has(id)).sort()};}
