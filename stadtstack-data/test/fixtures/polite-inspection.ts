import {inspectResourcePolicy} from '../../src/source-policy.ts';
import {classifyDocumentOriginRules,inspectDocumentOriginPdf} from '../../src/document-origin-rules.ts';
import {PDF_TDM_POLICY_VERSION} from '../../src/pdf-tdm-policy.ts';
import type {FixturePolicyInspection} from '../../src/polite-fetch.ts';
import {metadataPdf,reservedXmp} from './tdm-pdf.ts';

/** Synthetic transport assertions only; constructor requires a real pinned isolated fixture realm. */
export const fixturePolicyInspection:FixturePolicyInspection={
 async resource(url,headers,body,mimeType){return inspectResourcePolicy(url,headers,body,mimeType);},
 async origin(input){
  return classifyDocumentOriginRules(input,async()=>inspectDocumentOriginPdf(async(tool)=>{
   if(tool==='pdfinfo')return 'Pages: 1\nEncrypted: no\n';
   if(tool==='pdftotext')return '';
   throw Error('Unexpected synthetic origin tool');
  }));
 },
 async pdf(bytes,sha256){
  let finding;
  if(bytes.equals(metadataPdf(reservedXmp)))finding={state:'checked' as const,reservation:1 as const,policyPresent:true,metadataPresent:true};
  else if(bytes.equals(metadataPdf()))finding={state:'checked' as const,reservation:null,policyPresent:false,metadataPresent:false};
  else if(bytes.equals(Buffer.from('%PDF-invalid')))finding={state:'unavailable' as const,reason:'parse_error'};
  else throw Error('Unknown synthetic PDF transport fixture; use reviewed sandbox metadata tests');
  return {schemaVersion:1,policyVersion:PDF_TDM_POLICY_VERSION,pdfjsVersion:'fixture',sha256,checkedAt:new Date().toISOString(),finding,fromCache:false};
 },
};
