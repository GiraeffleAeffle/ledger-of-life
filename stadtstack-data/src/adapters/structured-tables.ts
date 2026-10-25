import {inflateRawSync} from 'node:zlib';
import {load} from 'cheerio';

/** Native lexemes, not formatted/normalized display values. Formula caches are never trusted. */
export interface NativeFormatField {path:string;rawValue:string|number|null}
export interface NativeNumberFormat {styleIndex:number|null;numFmtId:string|null;formatCode:string|null;percentStyle:boolean;dateStyle:boolean;mappingVersion:string;evidence:NativeFormatField[]}
export interface NativeCell {address:string;raw:string;type:'string'|'number'|'boolean'|'date';dateStyle:boolean;numberFormat?:NativeNumberFormat}
export const NATIVE_NUMBER_FORMAT_VERSION='native-number-format-v2';
export interface NativeTable {format:'csv'|'xlsx'|'xls';sheet:string|null;rows:NativeCell[][];date1904:boolean}
export const TABLE_LIMITS=Object.freeze({inputBytes:16*1024*1024,totalBytes:64*1024*1024,memberBytes:16*1024*1024,members:512,ratio:200,rows:100000,columns:512,cells:2000000});
export interface ZipLimits {inputBytes:number;totalBytes:number;memberBytes:number;members:number;ratio:number}
export interface CsvLimits {inputBytes:number;rows:number;columns:number;cells:number}
const HARD_LIMITS:Record<string,number>={inputBytes:128*1024*1024,totalBytes:512*1024*1024,memberBytes:128*1024*1024,members:2048,ratio:200,rows:2000000,columns:4096,cells:8000000};
function checkedLimits<T extends ZipLimits|CsvLimits>(defaults:T,overrides:Partial<T>):T {
 const limits={...defaults,...overrides};for(const [key,value] of Object.entries(limits))if(!Object.hasOwn(defaults,key)||typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>HARD_LIMITS[key])throw Error('Invalid/hard resource limit '+key);return limits;
}
const decoder=new TextDecoder('utf-8',{fatal:true});
export function columnName(index:number):string {let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;}
function bound(bytes:Uint8Array):void {if(bytes.byteLength>TABLE_LIMITS.inputBytes)throw Error('Table input byte limit');}
function cell(address:string,raw:string,type:NativeCell['type']='string',dateStyle=false):NativeCell{return {address,raw,type,dateStyle};}
const BUILTIN_FORMATS:Record<string,string>={'0':'General','1':'0','2':'0.00','3':'#,##0','4':'#,##0.00','9':'0%','10':'0.00%','11':'0.00E+00','14':'mm-dd-yy','15':'d-mmm-yy','16':'d-mmm','17':'mmm-yy','18':'h:mm AM/PM','19':'h:mm:ss AM/PM','20':'h:mm','21':'h:mm:ss','22':'m/d/yy h:mm','45':'mm:ss','46':'[h]:mm:ss','47':'mmss.0'};
const IMPLICIT_OOXML_NUMBER_FORMAT:NativeNumberFormat={styleIndex:null,numFmtId:'0',formatCode:'General',percentStyle:false,dateStyle:false,mappingVersion:NATIVE_NUMBER_FORMAT_VERSION,evidence:[]};
function formatSemantics(code:string|null):{percentStyle:boolean;dateStyle:boolean} {
 if(code===null)return {percentStyle:false,dateStyle:false};
 if(code==='Percent')return {percentStyle:true,dateStyle:false};
 if(['Short Date','Long Date','Medium Date','General Date','Short Time','Medium Time','Long Time'].includes(code))return {percentStyle:false,dateStyle:true};
 // Quoted/escaped literal %, fill/spacing directives and bracketed conditions/colors are not scaling markers.
 const clean=code.replace(/"(?:[^"]|"")*"|\\.|_.|\*./g,'').replace(/\[([hms]+)\]/gi,'$1').replace(/\[[^\]]*\]/g,'');
 const sections=clean.split(';').slice(0,3).filter(section=>section!==''&&section!=='@'),percentCounts=sections.map(section=>(section.match(/%/g)??[]).length);
 if(percentCounts.some(n=>n>1)||(percentCounts.some(n=>n>0)&&percentCounts.some(n=>n===0)))throw Error('Mixed/compound percentage formats require checked rendering');
 const words=clean.match(/[A-Za-z]+/g)??[],dateStyle=words.length>0&&words.every(word=>/^(?:(?:y{1,4}|m{1,5}|d{1,4}|h{1,2}|s{1,2})+|AM|PM|A|P|General|E)$/i.test(word))&&words.some(word=>/^(?:y{1,4}|m{1,5}|d{1,4}|h{1,2}|s{1,2})+$/i.test(word));
 const percentStyle=percentCounts.some(n=>n===1);if(percentStyle&&dateStyle)throw Error('Mixed date/percentage format');return {percentStyle,dateStyle};
}
/** Exact decimal x100 only for source-number cells whose effective native style specifies percent. */
export function nativePercentValue(c:NativeCell):string {
 const raw=c.raw.trim();if(c.type!=='number'||!c.numberFormat?.percentStyle)return raw;
 const match=/^([+-]?)(\d*)(?:\.(\d*))?(?:[Ee]([+-]?\d+))?$/.exec(raw);if(!match||!(match[2]||match[3])||raw.length>4096)throw Error('Invalid styled percentage number');
 const exponent=Number(match[4]??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000)throw Error('Styled percentage exponent bound');
 const digits=match[2]+(match[3]??''),point=match[2].length+exponent+2;let shifted=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
 let [whole,fraction='']=shifted.split('.');whole=whole.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');shifted=whole+(fraction?'.'+fraction:'');return match[1]==='-'&&shifted!=='0'?'-'+shifted:shifted;
}

export function readCsv(bytes:Uint8Array,options:{delimiter?:string;encoding?:'utf-8'|'windows-1252';limits?:Partial<CsvLimits>}={}):NativeTable {
 const limits=checkedLimits<CsvLimits>({inputBytes:TABLE_LIMITS.inputBytes,rows:TABLE_LIMITS.rows,columns:TABLE_LIMITS.columns,cells:TABLE_LIMITS.cells},options.limits??{});if(bytes.byteLength>limits.inputBytes)throw Error('CSV input byte limit');let text=new TextDecoder(options.encoding??'utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
 const first=text.split(/\r?\n/,1)[0];const sep=/^sep=([;,\t])$/i.exec(first);if(sep)text=text.slice(first.length).replace(/^\r?\n/,'');
 let delimiter=options.delimiter??sep?.[1];
 if(delimiter===undefined){
  const counts:Record<string,number>={';':0,',':0,'\t':0};let quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted){if(c==='\r'||c==='\n')break;if(Object.hasOwn(counts,c))counts[c]++;}}
  const candidates=Object.entries(counts).sort((a,b)=>b[1]-a[1]);if(candidates[0][1]>0&&candidates[0][1]===candidates[1][1])throw Error('Ambiguous CSV delimiter');delimiter=candidates[0][1]?candidates[0][0]:',';
 }
 if(![';',',','\t'].includes(delimiter))throw Error('Unsupported CSV delimiter');
 const rows:NativeCell[][]=[];let row:NativeCell[]=[],value='',quoted=false,closed=false,count=0;
 const field=()=>{if(row.length>=limits.columns||++count>limits.cells)throw Error('CSV cell limit');row.push(cell(columnName(row.length)+(rows.length+1),value));value='';closed=false;};
 const finish=()=>{field();if(rows.length>=limits.rows)throw Error('CSV row limit');rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else {quoted=false;closed=true;}}else value+=c;continue;}
  if(c==='"'){if(value||closed)throw Error('Malformed CSV quoting');quoted=true;}
  else if(c===delimiter)field();else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;finish();}
  else {if(closed)throw Error('CSV trailing characters after quoted field');value+=c;}}
 if(quoted)throw Error('Unterminated CSV field');if(value||closed||row.length)finish();
 return {format:'csv',sheet:null,rows,date1904:false};
}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Uint8Array):number {let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
/** No extraction to disk. ZIP64, encryption, symlinks and ambiguous duplicate names fail closed. */
export function readZip(bytes:Uint8Array,overrides:Partial<ZipLimits>={}):Map<string,Uint8Array> {
 const limits=checkedLimits<ZipLimits>({inputBytes:TABLE_LIMITS.inputBytes,totalBytes:TABLE_LIMITS.totalBytes,memberBytes:TABLE_LIMITS.memberBytes,members:TABLE_LIMITS.members,ratio:TABLE_LIMITS.ratio},overrides);if(bytes.byteLength>limits.inputBytes)throw Error('ZIP input byte limit');const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
 for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(b.readUInt32LE(p)===0x06054b50&&p+22+b.readUInt16LE(p+20)===b.length){end=p;break;}
 if(end<0)throw Error('Invalid ZIP directory');const members=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
 if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==members||members===65535||members>limits.members||offset+size!==end)throw Error('ZIP directory bounds or multidisk/ZIP64');
 const output=new Map<string,Uint8Array>();let p=offset,total=0;const spans:Array<[number,number]>=[];
 for(let n=0;n<members;n++){
  if(p+46>end||b.readUInt32LE(p)!==0x02014b50)throw Error('Invalid ZIP member');
  const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),crc=b.readUInt32LE(p+16),compressed=b.readUInt32LE(p+20),uncompressed=b.readUInt32LE(p+24),names=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),local=b.readUInt32LE(p+42);
  if(p+46+names+extra+comment>end)throw Error('ZIP member directory overrun');
  const name=decoder.decode(b.subarray(p+46,p+46+names)),mode=b.readUInt32LE(p+38)>>>16;
  if(!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some(part=>part==='..'||part==='.')||(mode&0xf000)===0xa000||output.has(name))throw Error('Unsafe ZIP member path/type');
  if(flags&0x41||![0,8].includes(method)||b.readUInt16LE(p+34)||uncompressed>limits.memberBytes||uncompressed>Math.max(1,compressed)*limits.ratio||(total+=uncompressed)>limits.totalBytes)throw Error('ZIP encryption/expansion/method limit');
  if(local+30>offset||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)throw Error('Invalid ZIP local header');
  const localNames=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28),start=local+30+localNames+localExtra,stop=start+compressed;
  if(stop>offset||decoder.decode(b.subarray(local+30,local+30+localNames))!==name||spans.some(([a,z])=>local<z&&stop>a))throw Error('ZIP member overlap/binding mismatch');
  if(!(flags&8)&&(b.readUInt32LE(local+14)!==crc||b.readUInt32LE(local+18)!==compressed||b.readUInt32LE(local+22)!==uncompressed))throw Error('ZIP local size/CRC mismatch');
  spans.push([local,stop]);const raw=b.subarray(start,stop),data=method===0?raw:inflateRawSync(raw,{maxOutputLength:Math.max(1,uncompressed)});
  if(data.length!==uncompressed||crc32(data)!==crc)throw Error('ZIP member CRC/size mismatch');
  output.set(name,data);p+=46+names+extra+comment;
 }
 if(p!==end)throw Error('ZIP directory size mismatch');return output;
}
function xml(bytes:Uint8Array|undefined){if(!bytes)throw Error('Missing OOXML member');const text=decoder.decode(bytes);if(/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))throw Error('XML DTD/entities prohibited');return load(text,{xmlMode:true});}
export function readXlsx(bytes:Uint8Array):NativeTable[] {
 const zip=readZip(bytes);if(!zip.has('[Content_Types].xml'))throw Error('Not an OOXML workbook');
 // Validate all XML/rels before selecting sheets; external relationships never execute or enter evidence.
 for(const [name,data] of zip)if(/\.(?:xml|rels)$/i.test(name)){const $=xml(data);if($('Relationship').toArray().some(el=>$(el).attr('TargetMode')==='External'&&!['http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink','http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink'].includes($(el).attr('Type')??'')))throw Error('External OOXML workbook/resource relationship prohibited');}
 const book=xml(zip.get('xl/workbook.xml')),rels=xml(zip.get('xl/_rels/workbook.xml.rels')),targets=new Map<string,string>();
 rels('Relationship').each((_,el)=>{const e=rels(el);if(e.attr('TargetMode')==='External')return;const id=e.attr('Id'),target=e.attr('Target');if(!id||!target||target.includes('\\')||target.split('/').some(p=>p==='..'||p==='.')||targets.has(id))throw Error('Unsafe OOXML relationship');targets.set(id,target.startsWith('/xl/')?target.slice(1):'xl/'+target);});
 const strings:string[]=[];if(zip.has('xl/sharedStrings.xml')){const $=xml(zip.get('xl/sharedStrings.xml'));$('sst > si').each((_,el)=>{strings.push($(el).find('t').toArray().map(t=>$(t).text()).join(''));});}
 const styles:NativeNumberFormat[]=[];
 if(zip.has('xl/styles.xml')){
  const $=xml(zip.get('xl/styles.xml')),custom=new Map<string,string>();$('numFmts > numFmt').each((_,el)=>{const id=$(el).attr('numFmtId'),code=$(el).attr('formatCode');if(!id||!/^\d+$/.test(id)||code===undefined||custom.has(id))throw Error('Invalid/duplicate native number format');custom.set(id,code);});
  const bases=$('cellStyleXfs > xf').toArray();
  $('cellXfs > xf').each((index,el)=>{
   const e=$(el),path=`xl/styles.xml/styleSheet/cellXfs/xf[${index+1}]`,baseId=e.attr('xfId'),apply=e.attr('applyNumberFormat'),evidence:NativeFormatField[]=[];
   if(baseId!==undefined&&(!/^\d+$/.test(baseId)||!bases[+baseId]))throw Error('Invalid base style reference');
   if(apply!==undefined&&!['0','1','false','true'].includes(apply))throw Error('Invalid applyNumberFormat');
   if(baseId!==undefined)evidence.push({path:path+'/@xfId',rawValue:baseId});if(apply!==undefined)evidence.push({path:path+'/@applyNumberFormat',rawValue:apply});
   const inherit=(apply==='0'||apply==='false'||e.attr('numFmtId')===undefined)&&baseId!==undefined,sourcePath=inherit?`xl/styles.xml/styleSheet/cellStyleXfs/xf[${Number(baseId)+1}]`:path,owner=inherit?$(bases[Number(baseId)]):e,id=owner.attr('numFmtId')??'0';
   if(!/^\d+$/.test(id))throw Error('Invalid native format ID');evidence.push({path:sourcePath+'/@numFmtId',rawValue:owner.attr('numFmtId')??null});
   if(+id>=164&&!custom.has(id))throw Error('Missing custom number format');const code=custom.get(id)??BUILTIN_FORMATS[id]??null;
   if(custom.has(id))evidence.push({path:`xl/styles.xml/styleSheet/numFmts/numFmt[@numFmtId='${id}']/@formatCode`,rawValue:code});
   styles.push({styleIndex:index,numFmtId:id,formatCode:code,...formatSemantics(code),mappingVersion:NATIVE_NUMBER_FORMAT_VERSION,evidence});
  });
 }
 const nativeDate1904=book('workbookPr').attr('date1904');if(nativeDate1904!==undefined&&!['0','1','true','false'].includes(nativeDate1904))throw Error('Invalid OOXML date system');
 const date1904=['1','true'].includes(nativeDate1904??'');const tables:NativeTable[]=[];let count=0;
 book('sheets > sheet').each((_,el)=>{const name=book(el).attr('name'),id=book(el).attr('r:id'),target=id?targets.get(id):null;if(!name||!target||tables.some(t=>t.sheet===name)||!/^xl\/worksheets\/[^/]+\.xml$/.test(target))throw Error('Invalid worksheet relationship');
  const $=xml(zip.get(target)),rows:NativeCell[][]=[];const seen=new Set<string>();
  if($('worksheet > cols').length>1)throw Error('Multiple OOXML column-default containers');
  const columnDefaults:Array<{styleIndex:number;evidence:NativeFormatField[]}|undefined>=[],columnConflicts=new Set<number>();
  let declaredColumns=0;
  $('worksheet > cols > col').each((ordinal,el)=>{
   if(++declaredColumns>16384)throw Error('OOXML column-default record bound');
   const e=$(el),minRaw=e.attr('min')??'',maxRaw=e.attr('max')??'',style=e.attr('style');
   if(!/^\d+$/.test(minRaw)||!/^\d+$/.test(maxRaw)||Number(minRaw)<1||Number(minRaw)>Number(maxRaw)||Number(maxRaw)>16384)throw Error('Invalid OOXML column-default range');
   if(style===undefined)return;if(!/^\d+$/.test(style)||styles[Number(style)]===undefined)throw Error('Invalid OOXML column-default style');
   const path=`${target}/worksheet/cols/col[${ordinal+1}]`,entry={styleIndex:Number(style),evidence:[{path:path+'/@min',rawValue:minRaw},{path:path+'/@max',rawValue:maxRaw},{path:path+'/@style',rawValue:style}]};
   // Resolve only the admitted reader width; broad native A:XFD declarations never allocate 16384 cells.
   for(let column=Number(minRaw)-1;column<Math.min(Number(maxRaw),TABLE_LIMITS.columns);column++){const previous=columnDefaults[column];if(previous){if(previous.styleIndex!==entry.styleIndex)columnConflicts.add(column);}else columnDefaults[column]=entry;}
  });
  $('sheetData > row').each((_,row)=>{const rowElement=$(row),rowRaw=rowElement.attr('r')??'',rowNo=Number(rowRaw);if(!/^\d+$/.test(rowRaw)||!Number.isInteger(rowNo)||rowNo<1||rowNo>TABLE_LIMITS.rows||rows[rowNo-1])throw Error('Worksheet row bounds/duplicates');const cells:NativeCell[]=[];
   const rowPath=`${target}/worksheet/sheetData/row[@r='${rowRaw}']`,rowStyle=rowElement.attr('s'),customFormat=rowElement.attr('customFormat');
   if(rowStyle!==undefined&&(!/^\d+$/.test(rowStyle)||styles[Number(rowStyle)]===undefined))throw Error('Invalid OOXML row-default style');
   if(customFormat!==undefined&&!['0','1','true','false'].includes(customFormat))throw Error('Invalid OOXML row customFormat');
   const rowStyleActive=customFormat==='1'||customFormat==='true';if(rowStyleActive&&rowStyle===undefined)throw Error('Active OOXML row-default style lacks native index');
   $(row).children('c').each((_,el)=>{const e=$(el),address=e.attr('r')??'',match=/^([A-Z]+)([1-9]\d*)$/.exec(address);if(!match||+match[2]!==rowNo||seen.has(address)||++count>TABLE_LIMITS.cells)throw Error('Worksheet cell bounds/duplicates');seen.add(address);let col=0;for(const c of match[1])col=col*26+c.charCodeAt(0)-64;col--;if(col>=TABLE_LIMITS.columns)throw Error('Worksheet column limit');
    if(e.children('f').length)throw Error('Formula cells require separate checked interpretation');const type=e.attr('t')??'n',value=e.children('v').text();let raw=value,kind:NativeCell['type']='number';
    if(type==='s'){if(!/^\d+$/.test(value)||strings[+value]===undefined)throw Error('Shared string reference invalid');raw=strings[+value];kind='string';}
    else if(type==='inlineStr'){raw=e.children('is').find('t').toArray().map(t=>$(t).text()).join('');kind='string';}
    else if(type==='str')kind='string';else if(type==='b'){if(!['0','1'].includes(raw))throw Error('Invalid boolean');kind='boolean';}
    else if(type==='d'){if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw))throw Error('Invalid ISO cell date');kind='date';}
    else if(type!=='n'||(raw&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw)))throw Error('Unsupported/error cell type');
    const style=e.attr('s');if(style!==undefined&&(!/^\d+$/.test(style)||styles[Number(style)]===undefined))throw Error('Invalid cell style');
    const columnDefault=columnDefaults[col],selection:NativeFormatField[]=[{path:`${rowPath}/c[@r='${address}']/@s`,rawValue:style??null}];let effectiveStyle:number;
    if(style!==undefined)effectiveStyle=Number(style);
    else {
     if(rowStyle!==undefined||customFormat!==undefined)selection.push({path:rowPath+'/@s',rawValue:rowStyle??null},{path:rowPath+'/@customFormat',rawValue:customFormat??null});
     if(rowStyleActive)effectiveStyle=Number(rowStyle);
     else if(columnDefault){if(columnConflicts.has(col))throw Error('Conflicting overlapping OOXML column-default styles');effectiveStyle=columnDefault.styleIndex;selection.push(...columnDefault.evidence);}
     else effectiveStyle=0;
    }
    const base=styles[effectiveStyle]??IMPLICIT_OOXML_NUMBER_FORMAT;
    if(kind==='number'&&base.formatCode===null)throw Error('Unsupported effective OOXML number format '+base.numFmtId);
    const numberFormat:NativeNumberFormat={...base,evidence:[...selection,...base.evidence,...(base.dateStyle?[{path:'xl/workbook.xml/workbook/workbookPr/@date1904',rawValue:nativeDate1904??null}]:[])]};
    cells[col]={...cell(address,raw,kind,numberFormat.dateStyle),numberFormat};
   });rows[rowNo-1]=cells;
  });tables.push({format:'xlsx',sheet:name,rows,date1904});
 });if(!tables.length)throw Error('Workbook contains no worksheets');return tables;
}
/** Excel 2003 SpreadsheetML only, never binary BIFF/OLE or guessed HTML masquerading as XLS. */
export function readSpreadsheetXml(bytes:Uint8Array):NativeTable[] {
 bound(bytes);const $=xml(bytes);if(!$('Workbook').length||!$('Workbook').attr('xmlns')?.includes('urn:schemas-microsoft-com:office:spreadsheet'))throw Error('Not Excel 2003 SpreadsheetML');
 const dateNode=$('ExcelWorkbook > Date1904, x\\:ExcelWorkbook > x\\:Date1904').first(),dateFlag=dateNode.text().trim();
 if(dateNode.length&&!['','0','1','true','false'].includes(dateFlag))throw Error('Invalid SpreadsheetML date system');
 const date1904=!!dateNode.length&&!['0','false'].includes(dateFlag),dateField:NativeFormatField={path:"Workbook/*[local-name()='ExcelWorkbook']/*[local-name()='Date1904']",rawValue:dateNode.length?dateNode.text():null};
 const styles=new Map<string,{parent:string|null;format:string|null}>(),resolved=new Map<string,NativeNumberFormat>();
 $('Workbook > Styles > Style').each((_,el)=>{const e=$(el),id=e.attr('ss:ID');if(!id||styles.has(id))throw Error('Invalid/duplicate SpreadsheetML style');styles.set(id,{parent:e.attr('ss:Parent')??null,format:e.children('NumberFormat').attr('ss:Format')??null});});
 const resolve=(id:string,chain=new Set<string>()):NativeNumberFormat=>{
  const cached=resolved.get(id);if(cached)return cached;if(chain.has(id))throw Error('Cyclic SpreadsheetML style parent');chain.add(id);
  const style=styles.get(id);if(!style){if(id!=='Default')throw Error('Missing SpreadsheetML style');const implicit:NativeNumberFormat={styleIndex:null,numFmtId:null,formatCode:'General',percentStyle:false,dateStyle:false,mappingVersion:NATIVE_NUMBER_FORMAT_VERSION,evidence:[]};resolved.set(id,implicit);return implicit;}
  const path=`Workbook/Styles/Style[@ss:ID='${id}']`,parent=style.parent??(id!=='Default'&&styles.has('Default')?'Default':null),base=parent?resolve(parent,chain):null,formatCode=style.format??base?.formatCode??'General';
  const evidence:NativeFormatField[]=style.format!==null?[{path:path+'/NumberFormat/@ss:Format',rawValue:style.format}]:base?[{path:path+'/@ss:Parent',rawValue:style.parent},...base.evidence]:[{path:path+'/NumberFormat/@ss:Format',rawValue:null}];
  const value:NativeNumberFormat={styleIndex:null,numFmtId:null,formatCode,...formatSemantics(formatCode),mappingVersion:NATIVE_NUMBER_FORMAT_VERSION,evidence};resolved.set(id,value);return value;
 };
 const tables:NativeTable[]=[];let count=0;
 $('Workbook > Worksheet').each((_,el)=>{
  const name=$(el).attr('ss:Name');if(!name||tables.some(t=>t.sheet===name))throw Error('SpreadsheetML sheet identity');const table=$(el).children('Table');if(table.length!==1)throw Error('SpreadsheetML requires one native table per sheet');
  const path=`Workbook/Worksheet[@ss:Name='${name}']/Table`,tableStyle=table.attr('ss:StyleID'),columnStyles=new Map<number,{id:string;path:string}>();let columnIndex=0;
  table.children('Column').each((ordinal,el)=>{const e=$(el),index=e.attr('ss:Index'),span=e.attr('ss:Span')??'0',id=e.attr('ss:StyleID');if(index!==undefined){if(!/^[1-9]\d*$/.test(index))throw Error('SpreadsheetML column index');columnIndex=+index-1;}if(!/^\d+$/.test(span)||columnIndex+Number(span)>=TABLE_LIMITS.columns)throw Error('SpreadsheetML column span bound');for(let n=0;n<=Number(span);n++)if(id){if(columnStyles.has(columnIndex+n))throw Error('Overlapping SpreadsheetML column styles');columnStyles.set(columnIndex+n,{id,path:`${path}/Column[${ordinal+1}]/@ss:StyleID`});}columnIndex+=Number(span)+1;});
  const rows:NativeCell[][]=[];let ri=0;
  table.children('Row').each((rowOrdinal,el)=>{
   const rowElement=$(el),index=rowElement.attr('ss:Index'),rowStyle=rowElement.attr('ss:StyleID');if(index!==undefined){if(!/^[1-9]\d*$/.test(index))throw Error('SpreadsheetML row index');ri=+index-1;}if(ri>=TABLE_LIMITS.rows||rows[ri])throw Error('SpreadsheetML row bounds');const row:NativeCell[]=[];let ci=0;
   rowElement.children('Cell').each((cellOrdinal,el)=>{
    const e=$(el),index=e.attr('ss:Index');if(index!==undefined){if(!/^[1-9]\d*$/.test(index))throw Error('SpreadsheetML cell index');ci=+index-1;}if(ci>=TABLE_LIMITS.columns||row[ci]||++count>TABLE_LIMITS.cells||e.attr('ss:Formula'))throw Error('SpreadsheetML cell bounds/formula');
    const data=e.children('Data'),type=data.attr('ss:Type')??'String',raw=data.text(),kind:NativeCell['type']=type==='String'?'string':type==='Number'?'number':type==='Boolean'?'boolean':type==='DateTime'?'date':(()=>{throw Error('Unsupported SpreadsheetML cell type');})();
    if(kind==='number'&&raw&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw))throw Error('Invalid SpreadsheetML number');
    const cellPath=`${path}/Row[${rowOrdinal+1}]/Cell[${cellOrdinal+1}]`,ownStyle=e.attr('ss:StyleID'),columnStyle=columnStyles.get(ci),id=ownStyle??rowStyle??columnStyle?.id??tableStyle??'Default',base=resolve(id);
    const evidence:NativeFormatField[]=[{path:cellPath+'/@ss:StyleID',rawValue:ownStyle??null}];if(ownStyle===undefined&&rowStyle!==undefined)evidence.push({path:`${path}/Row[${rowOrdinal+1}]/@ss:StyleID`,rawValue:rowStyle});else if(ownStyle===undefined&&columnStyle)evidence.push({path:columnStyle.path,rawValue:columnStyle.id});else if(ownStyle===undefined&&tableStyle!==undefined)evidence.push({path:path+'/@ss:StyleID',rawValue:tableStyle});
    const numberFormat:NativeNumberFormat={...base,evidence:[...evidence,...base.evidence,...(base.dateStyle?[dateField]:[])]};row[ci]={...cell(columnName(ci)+(ri+1),raw,kind,numberFormat.dateStyle),numberFormat};ci++;
   });rows[ri]=row;ri++;
  });tables.push({format:'xls',sheet:name,rows,date1904});
 });if(!tables.length)throw Error('SpreadsheetML has no worksheets');return tables;
}
/** Date-only conversion for explicit date columns; serial 60 is Excel's nonexistent 1900 leap day. */
export function excelDate(raw:string,date1904=false):string {const serial=Number(raw);if(!Number.isInteger(serial)||serial<0||serial>2958465||(!date1904&&serial===60))throw Error('Invalid Excel date serial');const days=date1904?serial:serial-(serial>60?1:0);return new Date(Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:31)+days*86400000).toISOString().slice(0,10);}
