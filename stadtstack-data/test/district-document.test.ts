import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractDocumentText} from '../src/district-document.ts';
import {CivicPolicyStateError,HostOptedOutError} from '../src/civic-opt-out.ts';
import {ParserIsolationError} from '../src/district-parser-isolation.ts';

// Isolation, enrolled original bytes, cleanup and diagnostic bounds are exercised
// by district-parser-isolation and the durable Docker lifecycle suites. These
// synthetic executors cover orchestration without invoking host native tools.
test('PDF/OCR orchestration uses only the fixed isolated input and internal page paths',async()=>{
 const text='Synthetic municipal source text with enough words to exercise deterministic document extraction. '.repeat(3),calls:string[]=[];
 const result=await extractDocumentText(Buffer.from('%PDF-synthetic-source'),'application/pdf',undefined,async(file,args)=>{
  calls.push(file);
  if(file==='pdfinfo'){assert.equal(args.at(-1),'/input/document');return 'Pages: 1';}
  if(file==='pdftotext'){assert.deepEqual(args.slice(-2),['/input/document','-']);return '';}
  if(file==='pdftoppm'){assert.deepEqual(args.slice(-2),['/input/document','/scratch/page-1']);return '';}
  assert.equal(file,'tesseract');assert.equal(args[0],'/scratch/page-1.png');return text;
 });
 assert.equal(result.ocrUsed,true);assert.equal(result.text,text.trim());assert.deepEqual(calls,['pdfinfo','pdftotext','pdftoppm','tesseract']);
});

test('policy and isolation interruptions propagate unchanged through PDF orchestration',async()=>{
 for(const error of [new CivicPolicyStateError('SYNTHETIC_POLICY_FAILURE'),new HostOptedOutError('council.test'),new ParserIsolationError('request_rejected')]){
  await assert.rejects(extractDocumentText(Buffer.from('%PDF-fixture'),'application/pdf',undefined,async()=>{throw error;}),observed=>observed===error);
 }
});
