import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTdmRules,tdmRuleForUrl,inspectResourcePolicy,matchesPolicyPattern} from '../src/source-policy.ts';

test('TDMRep uses ordered specific rules and encoded path matching',()=>{
 const rules=parseTdmRules([{location:'/public/*','tdm-reservation':0},{location:'/','tdm-reservation':1}]);
 assert.equal(tdmRuleForUrl(rules,'https://stadt.de/public/plan.pdf')?.['tdm-reservation'],0);
 assert.equal(tdmRuleForUrl(rules,'https://stadt.de/private/plan.pdf')?.['tdm-reservation'],1);
 assert.equal(tdmRuleForUrl(parseTdmRules([{location:'/~plans/*.pdf$','tdm-reservation':1}]),'https://stadt.de/%7Eplans/a.pdf')?.['tdm-reservation'],1);
 assert.throws(()=>parseTdmRules([{location:'/', 'tdm-reservation':'yes'}]),/Invalid/);
});
test('Policy wildcards match literal segments without remote regex backtracking',{timeout:1000},()=>{
 for(const [pattern,value,expected] of [['/a*b$','/axbb',true],['/ab*bc$','/abc',false],['/a**b*c$','/abZZc',true],['/a*b','/abtail',true],['/a.b','/axb',false],['/a*$','/a',true]] as const)assert.equal(matchesPolicyPattern(pattern,value),expected);
 const hostile='/'+'a*'.repeat(1000)+'b$',target='/'+'a'.repeat(4000);
 assert.equal(matchesPolicyPattern(hostile,target),false);
 assert.equal(tdmRuleForUrl([{location:hostile,'tdm-reservation':0},{location:'/','tdm-reservation':1}],'https://stadt.de'+target)?.['tdm-reservation'],1);
});
test('HTTP and HTML meta reservations are recorded without granting copyright permission',()=>{
 const header=inspectResourcePolicy('https://stadt.de/a.pdf',{'tdm-reservation':'1','tdm-policy':'https://stadt.de/policy.json'},Buffer.from('%PDF-1.7'),'application/pdf');
 assert.equal(header.reservation,1);assert.equal(header.evidence[0].locator,'HTTP TDM-Reservation');
 const meta=inspectResourcePolicy('https://stadt.de/page',{},Buffer.from('<meta name="tdm-reservation" content="1"><h1>Plan</h1>'),'text/html');assert.equal(meta.reservation,1);
 const absent=inspectResourcePolicy('https://stadt.de/page',{},Buffer.from('<h1>Öffentliche Bekanntmachung</h1>'),'text/html');assert.equal(absent.reservation,null);assert.equal(absent.access,'public');
});
test('access barriers do not become municipal source content',()=>{
 const cases=[['<title>Login</title><input type="password">','authentication'],['<title>Just a moment</title><form id="challenge-form"></form>','captcha'],['<h1>Zahlung erforderlich</h1>','paywall']] as const;
 for(const [html,expected] of cases)assert.equal(inspectResourcePolicy('https://stadt.de/',{},Buffer.from(html),'text/html').access,expected);
 assert.equal(inspectResourcePolicy('https://stadt.de/',{},Buffer.from('<h1>Bauleitplanung</h1><footer><a href="/login">Login</a></footer>'),'text/html').access,'public');
});
