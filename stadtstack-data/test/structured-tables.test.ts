import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {columnName,excelDate,nativePercentValue,NATIVE_NUMBER_FORMAT_VERSION,readCsv,readSpreadsheetXml,readXlsx,readZip} from '../src/adapters/structured-tables.ts';

// Synthetic format/security fixtures; not claimed downloaded publisher distributions.
function zip(entries:Array<{name:string;text:string;deflate?:boolean;mode?:number;flags?:number}>):Buffer {
 const chunks:Buffer[]=[],directory:Buffer[]=[];let offset=0;
 for(const entry of entries){const name=Buffer.from(entry.name),data=Buffer.from(entry.text),packed=entry.deflate?deflateRawSync(data):data;let crc=0xffffffff;for(const byte of data){crc^=byte;for(let k=0;k<8;k++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(entry.flags??0,6);local.writeUInt16LE(entry.deflate?8:0,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(entry.flags??0,8);central.writeUInt16LE(entry.deflate?8:0,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(((entry.mode??0o100600)<<16)>>>0,38);central.writeUInt32LE(offset,42);chunks.push(local,name,packed);directory.push(central,name);offset+=local.length+name.length+packed.length;
 }
 const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,dir,end]);
}
function workbook(sheet:string,extras:Array<{name:string;text:string}>=[]):Buffer {return zip([
 {name:'[Content_Types].xml',text:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'},
 {name:'xl/workbook.xml',text:'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="Native" sheetId="1" r:id="rId1"/></sheets></workbook>'},
 {name:'xl/_rels/workbook.xml.rels',text:'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'},
 {name:'xl/worksheets/sheet1.xml',text:sheet},...extras,
 ]);}
test('native CSV retains quoted newlines, empty cells, Unicode, leading zeroes and coordinates',()=>{
 const t=readCsv(Buffer.from('\uFEFFid;description;empty\r\n001;"hello; \"\"world\"\"\nnext";\r\n'),{delimiter:';'});
 assert.equal(t.rows.length,2);assert.equal(t.rows[1][0].raw,'001');assert.equal(t.rows[1][1].raw,'hello; "world"\nnext');assert.equal(t.rows[1][2].raw,'');assert.equal(t.rows[1][2].address,'C2');assert.equal(t.format,'csv');
 assert.equal(readCsv(Buffer.from('a\n\n')).rows.length,2);assert.equal(readCsv(Buffer.from('')).rows.length,0);
});
test('CSV malformed quoting, encoding and explicit bounds fail rather than truncate',()=>{
 for(const raw of ['a;"unterminated','a;"closed"junk','a;ab"cd'])assert.throws(()=>readCsv(Buffer.from(raw)));
 assert.throws(()=>readCsv(new Uint8Array([0xff])));assert.throws(()=>readCsv(Buffer.from('a\nb\n'),{limits:{rows:1}}),/row limit/);
 assert.throws(()=>readCsv(Buffer.from('a'),{limits:{inputBytes:0}}),/resource limit/);assert.throws(()=>readCsv(Buffer.from('a'),{limits:{rows:3000000}}),/resource limit/);
 assert.equal(readCsv(new Uint8Array([0x80]),{encoding:'windows-1252'}).rows[0][0].raw,'€');
});
test('OOXML keeps sparse native positions, strings, numeric lexemes and date styles',()=>{
 const bytes=workbook('<worksheet><sheetData><row r="2"><c r="B2" t="s"><v>0</v></c><c r="D2" s="1"><v>46265</v></c><c r="E2"><v>001.2300</v></c></row></sheetData></worksheet>',[
 {name:'xl/sharedStrings.xml',text:'<sst><si><r><t>Ä</t></r><r><t> native</t></r></si></sst>'},
 {name:'xl/styles.xml',text:'<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'},
 ]);const t=readXlsx(bytes)[0];assert.equal(t.sheet,'Native');assert.equal(t.rows[0],undefined);assert.equal(t.rows[1][0],undefined);assert.equal(t.rows[1][1].raw,'Ä native');assert.equal(t.rows[1][3].dateStyle,true);assert.equal(t.rows[1][4].raw,'001.2300');assert.equal(t.rows[1][4].type,'number');
});
test('ZIP rejects traversal, symlink, duplicate paths, corruption, encryption and over-expansion',()=>{
 assert.equal(Buffer.from(readZip(zip([{name:'ok.csv',text:'abc',deflate:true}])).get('ok.csv')!).toString(),'abc');
 for(const name of ['../escape','/absolute','C:/escape','a\\b','a/./b'])assert.throws(()=>readZip(zip([{name,text:'x'}])),/Unsafe/);
 assert.throws(()=>readZip(zip([{name:'link',text:'target',mode:0o120777}])),/Unsafe/);assert.throws(()=>readZip(zip([{name:'a',text:'x'},{name:'a',text:'y'}])),/Unsafe/);
 assert.throws(()=>readZip(zip([{name:'a',text:'x',flags:1}])),/encryption/);const corrupt=zip([{name:'a',text:'abc'}]);corrupt[31]^=1;assert.throws(()=>readZip(corrupt),/CRC/);
 assert.throws(()=>readZip(zip([{name:'a',text:'a'.repeat(10000),deflate:true}])),/expansion/);
 assert.throws(()=>readZip(zip([{name:'a',text:'abc'}]),{memberBytes:2}),/limit/);assert.throws(()=>readZip(Buffer.alloc(0)),/directory/);
});
test('OOXML rejects DTD, external references, formulas and ambiguous native cells',()=>{
 assert.throws(()=>readXlsx(workbook('<!DOCTYPE worksheet [<!ENTITY e SYSTEM "file:///secret">]><worksheet/>')),/DTD/);
 assert.throws(()=>readXlsx(workbook('<worksheet/>',[{name:'xl/external.rels',text:'<Relationships><Relationship TargetMode="External" Target="https://secret/"/></Relationships>'}])),/External/);
 assert.throws(()=>readXlsx(workbook('<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>')),/Formula/);
 assert.throws(()=>readXlsx(workbook('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row></sheetData></worksheet>')),/duplicates/);
 assert.equal(readXlsx(workbook('<worksheet><sheetData/></worksheet>'))[0].rows.length,0);
});
test('SpreadsheetML XLS preserves original typed cells; binary BIFF remains unsupported',()=>{
 const bytes=Buffer.from('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Export"><Table><Row ss:Index="2"><Cell ss:Index="3"><Data ss:Type="String">00123</Data></Cell></Row></Table></Worksheet></Workbook>');const t=readSpreadsheetXml(bytes)[0];assert.equal(t.format,'xls');assert.equal(t.rows[1][2].raw,'00123');assert.equal(t.rows[1][2].address,'C2');assert.throws(()=>readSpreadsheetXml(new Uint8Array([0xd0,0xcf,0x11,0xe0])));
});
test('Excel date conversion handles both epochs without accepting the fake leap day',()=>{
 assert.equal(excelDate('1'),'1900-01-01');assert.equal(excelDate('61'),'1900-03-01');assert.equal(excelDate('0',true),'1904-01-01');assert.throws(()=>excelDate('60'));assert.throws(()=>excelDate('1.5'));assert.equal(columnName(26),'AA');
});
test('CSV dialect selection ignores quoted delimiters and honors original sep directives',()=>{
 assert.deepEqual(readCsv(Buffer.from('"header;with;semicolons",second\nvalue,other\n')).rows[0].map(c=>c.raw),['header;with;semicolons','second']);
 assert.deepEqual(readCsv(Buffer.from('sep=;\nfirst;second\n')).rows[0].map(c=>c.raw),['first','second']);
 assert.throws(()=>readCsv(Buffer.from('first;second,third\n')),/Ambiguous CSV delimiter/);
});
test('OOXML number-format receipts preserve native percentage scaling and literal percent masks',()=>{
 const sheet='<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>0.6</v></c><c r="B1" s="2"><v>3.5</v></c><c r="C1" s="3"><v>1.25</v></c><c r="D1"><v>0.6</v></c><c r="E1" s="4"><v>0.6</v></c><c r="F1" s="5"><v>0.6</v></c><c r="G1" s="6"><v>2026</v></c><c r="H1" s="1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>';
 const styles='<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.00%"/><numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/><numFmt numFmtId="166" formatCode="0.00\\%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="14"/></cellXfs></styleSheet>';
 const row=readXlsx(workbook(sheet,[{name:'xl/styles.xml',text:styles}]))[0].rows[0];
 assert.deepEqual(row.map(nativePercentValue),['60','350','125','0.6','0.6','0.6','2026','x']);assert.equal(row[0].raw,'0.6');assert.equal(row[3].dateStyle,false);assert.equal(row[6].dateStyle,true);
 assert.equal(row[0].numberFormat!.mappingVersion,NATIVE_NUMBER_FORMAT_VERSION);assert.equal(row[0].numberFormat!.numFmtId,'9');assert.ok(row[0].numberFormat!.evidence.some(e=>e.path.endsWith('/@numFmtId')&&e.rawValue==='9'));assert.ok(row[2].numberFormat!.evidence.some(e=>e.path.endsWith('/@formatCode')&&e.rawValue==='0.00%'));assert.ok(row[6].numberFormat!.evidence.some(e=>e.path.endsWith('/@date1904')&&e.rawValue===null));
});
test('effective implicit/base percent styles and decimal exponents do not rely on value magnitude',()=>{
 const sheet='<worksheet><sheetData><row r="1"><c r="A1"><v>0.6E1</v></c><c r="B1"><v>3.50e0</v></c><c r="C1"><v>-0.006</v></c><c r="D1"><v>0.00</v></c></row></sheetData></worksheet>';
 const row=readXlsx(workbook(sheet,[{name:'xl/styles.xml',text:'<styleSheet><cellStyleXfs><xf numFmtId="10"/></cellStyleXfs><cellXfs><xf xfId="0" numFmtId="0" applyNumberFormat="0"/></cellXfs></styleSheet>'}]))[0].rows[0];
 assert.deepEqual(row.map(nativePercentValue),['600','350','-0.6','0']);assert.equal(row[0].numberFormat!.numFmtId,'10');assert.ok(row[0].numberFormat!.evidence.some(e=>e.path.includes('cellStyleXfs')&&e.rawValue==='10'));assert.equal(row[0].numberFormat!.evidence[0].rawValue,null);
 assert.throws(()=>readXlsx(workbook(sheet,[{name:'xl/styles.xml',text:'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0%;0"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>'}])),/Mixed/);
});
test('SpreadsheetML native styles inherit number formats and bind date system without treating General years as dates',()=>{
 const source='<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><Date1904/></ExcelWorkbook><Styles><Style ss:ID="Default"><NumberFormat ss:Format="General"/></Style><Style ss:ID="Percent"><NumberFormat ss:Format="0.00%"/></Style><Style ss:ID="Inherited" ss:Parent="Percent"/><Style ss:ID="Date"><NumberFormat ss:Format="Short Date"/></Style></Styles><Worksheet ss:Name="Export"><Table><Row><Cell ss:StyleID="Inherited"><Data ss:Type="Number">0.6</Data></Cell><Cell><Data ss:Type="Number">2026</Data></Cell><Cell ss:StyleID="Date"><Data ss:Type="Number">0</Data></Cell></Row></Table></Worksheet></Workbook>';
 const table=readSpreadsheetXml(Buffer.from(source))[0],row=table.rows[0];assert.equal(table.date1904,true);assert.equal(nativePercentValue(row[0]),'60');assert.equal(row[1].dateStyle,false);assert.equal(row[2].dateStyle,true);assert.ok(row[0].numberFormat!.evidence.some(e=>e.path.endsWith('/@ss:Parent')&&e.rawValue==='Percent'));assert.ok(row[0].numberFormat!.evidence.some(e=>e.path.endsWith('/@ss:Format')&&e.rawValue==='0.00%'));assert.ok(row[2].numberFormat!.evidence.some(e=>e.path.includes('Date1904')&&e.rawValue===''));
 assert.throws(()=>readSpreadsheetXml(Buffer.from(source.replace('ss:Parent="Percent"','ss:Parent="Inherited"'))),/Cyclic/);
});
test('benign external hyperlinks are ignored, external workbook resources and DTD remain forbidden',()=>{
 const sheet='<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
 const hyper={name:'xl/worksheets/_rels/sheet1.xml.rels',text:'<Relationships><Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid/never-fetched"/></Relationships>'};
 assert.equal(readXlsx(workbook(sheet,[hyper]))[0].rows[0][0].raw,'1');
 assert.throws(()=>readXlsx(workbook(sheet,[{...hyper,text:hyper.text.replace('/hyperlink','/externalLinkPath')}])),/External/);
 assert.throws(()=>readXlsx(workbook('<!DOCTYPE worksheet [<!ENTITY hidden SYSTEM "https://example.invalid/">]><worksheet/>',[hyper])),/DTD/);
});
