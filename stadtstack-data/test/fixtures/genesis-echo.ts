import {deflateRawSync} from 'node:zlib';

export function unicodeEscape(value:string,mixed=false):string {
 return [...value].map((char,index)=>mixed&&index%2?JSON.stringify(char).slice(1,-1):'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
}
export function percentEscape(value:string,passes=1):string {
 let result=[...Buffer.from(value)].map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('');
 for(let pass=1;pass<passes;pass++)result=result.replaceAll('%','%25');
 return result;
}
/** Complete synthetic deflated ZIPs, with CRC and bound local/central names. */
export function deflatedZip(members:Record<string,string>):Buffer {
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [path,text] of Object.entries(members)){
  const name=Buffer.from(path),plain=Buffer.from(text),packed=deflateRawSync(plain);let crc=0xffffffff;
  for(const byte of plain){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(plain.length,22);header.writeUInt16LE(name.length,26);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(8,10);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(packed.length,20);entry.writeUInt32LE(plain.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
  local.push(header,name,packed);central.push(entry,name);offset+=header.length+name.length+packed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(members).length,8);end.writeUInt16LE(Object.keys(members).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
