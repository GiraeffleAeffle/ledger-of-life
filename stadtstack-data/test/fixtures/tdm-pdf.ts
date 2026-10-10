import {deflateSync} from 'node:zlib';

/** A complete synthetic one-page PDF, with an optional real (possibly compressed) XMP stream. */
export function metadataPdf(xml?:string,compressed=true):Buffer {
 const objects:Buffer[]=[
  Buffer.from(`<< /Type /Catalog /Pages 2 0 R${xml!==undefined?' /Metadata 4 0 R':''} >>`),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>'),
 ];
 if(xml!==undefined){const metadata=compressed?deflateSync(Buffer.from(xml)):Buffer.from(xml);objects.push(Buffer.concat([Buffer.from(`<< /Type /Metadata /Subtype /XML${compressed?' /Filter /FlateDecode':''} /Length ${metadata.length} >>\nstream\n`),metadata,Buffer.from('\nendstream')]));}
 const chunks=[Buffer.from('%PDF-1.7\n%\xFF\xFF\xFF\xFF\n','latin1')],offsets:number[]=[];let offset=chunks[0].length;
 for(let index=0;index<objects.length;index++){
  offsets.push(offset);const chunk=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),objects[index],Buffer.from('\nendobj\n')]);chunks.push(chunk);offset+=chunk.length;
 }
 chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
 return Buffer.concat(chunks);
}
export const reservedXmp='<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:mine="http://www.w3.org/ns/tdmrep/"><mine:reservation>1</mine:reservation><mine:policy>https://stadt.de/tdm-policy.json</mine:policy></rdf:Description></rdf:RDF></x:xmpmeta>';
