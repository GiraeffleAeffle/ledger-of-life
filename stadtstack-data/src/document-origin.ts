import {join} from 'node:path';
import {runDocumentCommand,type DocumentCommand} from './district-document.ts';
import {withManagedSourceScratch,CivicPolicyStateError,type ManagedSourceContext} from './civic-opt-out.ts';
import {DOCUMENT_ORIGIN_INPUT_TOKEN,type DocumentOriginInput,type DocumentOriginClassification} from './document-origin-contract.ts';
import {classifyDocumentOriginRules,inspectDocumentOriginPdf} from './document-origin-rules.ts';

export interface DocumentOriginOptions {
  scratch?: ManagedSourceContext;
  command?: DocumentCommand;
}

/** Host producer: bind actual bytes to one durable managed scope before any native inspection. */
export async function classifyDocumentOrigin(input:DocumentOriginInput,options:DocumentOriginOptions={}):Promise<DocumentOriginClassification>{
  return classifyDocumentOriginRules(input,async sourceSha256=>{
    const context=options.scratch;
    if(!context)throw new CivicPolicyStateError('MANAGED_SCRATCH_REQUIRED');
    if(!context.bindings.some(binding=>binding.url===input.url&&'sourceSha256' in binding&&binding.sourceSha256===sourceSha256))throw new CivicPolicyStateError('SCRATCH_SOURCE_BINDING_REQUIRED');
    const command=options.command??runDocumentCommand;
    return withManagedSourceScratch(context.root,context.bindings,async scope=>{
      const path=join(scope.directory,'source.pdf');
      await scope.writeSource('source.pdf',input.bytes);
      return inspectDocumentOriginPdf(async(file,args)=>{
        await scope.assertActive();
        const output=await command(file,args.map(argument=>argument===DOCUMENT_ORIGIN_INPUT_TOKEN?path:argument),scope);
        await scope.assertActive();
        return output;
      });
    },{decisionId:context.decisionId,kind:context.kind,purpose:'classification',stateDir:context.stateDir,authorityId:context.authorityId,authoritySha256:context.authoritySha256});
  });
}
