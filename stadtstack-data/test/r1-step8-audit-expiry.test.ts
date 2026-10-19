import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {digest} from '../src/district-adapter-contract.ts';
import {readCurrentImportDispositionDecision} from '../src/r1-step8-import-dispositions.ts';

// A synthetic control-only fixture. No source bytes, receipt, issued production
// authority or successful whole-pipeline audit is represented by this record.
test('final audit decision gate rejects a decision that expires after initial authentication',async t=>{
 const started=Date.now(),expiry=started+1000,pin={path:'/synthetic/control.json',sha256:digest('synthetic referenced control')};
 const decision={schemaVersion:'stadtstack-r1-import-disposition-decision-v1',id:'synthetic-expiry-boundary',issuedBy:'owner',issuedAt:new Date(started-1000).toISOString(),expiresAt:new Date(expiry).toISOString(),nativeSealSelection:pin,catalogue:pin,policy:{kind:'permanent_only',enabledReasons:['unsupported_mime','scope_mismatch']},sources:[{municipalityId:'synthetic',sourceId:'synthetic',corpus:pin,sealResult:pin,manifest:pin,importResult:pin,documents:[{documentId:'synthetic',sourceSha256:digest('synthetic original identity'),reasonCode:'unsupported_mime'}]}]};
 const bytes=Buffer.from(JSON.stringify(decision)),decisionPin={path:'/synthetic/decision.json',sha256:digest(bytes)};
 let now=started;
 t.mock.method(Date,'now',()=>now);
 const read=async()=>bytes;
 assert.equal((await readCurrentImportDispositionDecision(decisionPin,read)).id,decision.id,'The decision is valid at audit entry');
 await Promise.resolve();now=expiry;
 await assert.rejects(readCurrentImportDispositionDecision(decisionPin,read),/decision is future-issued or expired/,'The identical pinned decision cannot authorize a compatible final report after it expires');
 await assert.rejects(readCurrentImportDispositionDecision({...decisionPin,sha256:pin.sha256},read),/evidence pin mismatch/);
});

test('standalone audit gates the report after both epoch fences, not only in the execute callback',async()=>{
 const path=new URL('../src/r1-step8-audit.ts',import.meta.url),text=await readFile(path,'utf8'),source=ts.createSourceFile(path.pathname,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const audit=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='auditStep8');assert.ok(audit?.body);
 const outer=audit.body.statements.find(ts.isTryStatement);assert.ok(outer);
 const stages=outer.tryBlock.statements;
 const stageIndex=(name:string)=>stages.findIndex(statement=>ts.isExpressionStatement(statement)&&ts.isAwaitExpression(statement.expression)&&ts.isCallExpression(statement.expression.expression)&&ts.isIdentifier(statement.expression.expression.expression)&&statement.expression.expression.expression.text==='attempt'&&ts.isStringLiteral(statement.expression.expression.arguments[0])&&statement.expression.expression.arguments[0].text===name);
 const current=stageIndex('import-disposition-current'),authority=stageIndex('authority-epoch'),native=stageIndex('native-provenance-epoch');
 const report=stages.findIndex(statement=>ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text==='report'));
 assert.ok(authority>=0&&native>=0&&current>authority&&current>native&&report>current,'The final decision check must run unconditionally after the epoch fences and before status is chosen');
 let checks=0;
 const visit=(node:ts.Node):void=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='readCurrentImportDispositionDecision'){checks++;assert.equal(node.arguments[0].getText(source),'input.importDispositionDecision');}ts.forEachChild(node,visit);};
 visit(stages[current]);assert.equal(checks,1,'The final audit stage must invoke the same pinned-byte/current-clock verifier as initial authentication');
});
