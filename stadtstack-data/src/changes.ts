import {z} from 'zod';
import type {Signal} from './schema.ts';
export const changesSchema=z.object({added:z.array(z.string()),changed:z.array(z.string()),removed:z.array(z.string()),generatedAt:z.string().optional()}).strict();
export type Changes=z.infer<typeof changesSchema>;
export function diff(previous:Signal[],current:Signal[]):Changes{const before=new Map(previous.map(f=>[f.properties.id,f.properties.version])),after=new Map(current.map(f=>[f.properties.id,f.properties.version]));return {added:[...after.keys()].filter(id=>!before.has(id)).sort(),changed:[...after.keys()].filter(id=>before.has(id)&&before.get(id)!==after.get(id)).sort(),removed:[...before.keys()].filter(id=>!after.has(id)).sort()};}
