import {isIP} from 'node:net';

/** Conservative native public-unicast policy shared by discovery and publication. */
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);
 if(family===4){
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
 }
 if(family===6){
  const [firstPart,secondPart]=address.toLowerCase().split(':');
  const first=Number.parseInt(firstPart,16),second=Number.parseInt(secondPart||'0',16);
  // Compressed leading zeros (for example ::1 and ::ffff:127.0.0.1) are not global unicast.
  return Number.isFinite(first)&&first>=0x2000&&first<0x3fff&&first!==0x2002&&!(first===0x2001&&(second<0x200||second===0xdb8));
 }
 return false;
}
