export const TOPICS: readonly {id:string;label:string;keywords:string[];pattern:RegExp;summary:string}[];
export function tokens(title:string):string[];
export function titleClusters<T extends {title:string;municipalityId:string}>(items:T[],threshold?:number):T[][];
