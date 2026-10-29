import test from 'node:test';
import assert from 'node:assert/strict';
import {CODE_GATES} from '../shared/task-completion.ts';
import {defaultCompletionPolicy,readCompletionPolicies} from '../server/project-progress.ts';
const policy=()=>({...defaultCompletionPolicy('code'),dependencyRelease:'quality_passed' as const,gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,['full']]))});
const parse=(p:unknown)=>readCompletionPolicies(JSON.stringify([{projectPath:'/project',policy:p}]),()=>[{id:'full'}]);
test('operational policy validates commands and preserves missing-policy wait',()=>{
 assert.deepEqual(readCompletionPolicies(undefined),[]);
 assert.equal(defaultCompletionPolicy('code').dependencyRelease,'wait');
 assert.equal(parse(policy())[0].policy.dependencyRelease,'quality_passed');
});
for(const defect of ['missing gate','unknown command','empty mapping','duplicate NA','general map','path control'] as const)test(`operational configuration rejects ${defect}`,()=>{
 const p=policy();
 if(defect==='missing gate')p.requiredGates.pop();
 if(defect==='unknown command')p.gateCommandMap.unit=['absent'];
 if(defect==='empty mapping')p.gateCommandMap.unit=[];
 if(defect==='duplicate NA')p.notApplicable=[{gate:'unit',reason:'approved exception',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'},{gate:'unit',reason:'duplicate',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}];
 if(defect==='general map')Object.assign(p,{projectKind:'general',requiredGates:['artifact_format','numeric_source','semantic_review']});
 assert.throws(()=>defect==='path control'?readCompletionPolicies(JSON.stringify([{projectPath:'/project\n',policy:p}])):parse(p),/INVALID_COMPLETION_CONFIGURATION/);
});

for(const raw of ['not json','{}','null',JSON.stringify([{projectPath:'relative',policy:policy()}]),JSON.stringify([{projectPath:'/project',policy:{...policy(),verifiedDone:true}}])])test('malformed host configuration fails closed: '+raw.slice(0,25),()=>{
 assert.throws(()=>readCompletionPolicies(raw),/INVALID_COMPLETION_CONFIGURATION/);
});
test('NA needs approved reason and permits an unmapped category only with approval',()=>{
 const p=policy();delete p.gateCommandMap.e2e;
 p.notApplicable=[{gate:'e2e',reason:'No UI in this library',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}];
 assert.equal(parse(p)[0].policy.notApplicable.length,1);
 for(const key of ['reason','approvedBy','approvedAt'] as const){const invalid=structuredClone(p);invalid.notApplicable[0][key]='';assert.throws(()=>parse(invalid),/INVALID_COMPLETION_CONFIGURATION/);}
});
