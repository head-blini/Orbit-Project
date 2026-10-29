import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {listDeliverables,previewDeliverable} from '../server/deliverables.ts';

function folder(){
  const root=mkdtempSync(join(tmpdir(),'orbit-deliverables-'));
  writeFileSync(join(root,'README.md'),'# Project\n');
  writeFileSync(join(root,'task-2d5a1ea8.md'),'# R1: 자료 수집\n\n- 출처 3개\n');
  writeFileSync(join(root,'empty.md'),'');
  writeFileSync(join(root,'table.csv'),'a,b\n1,2\n');
  writeFileSync(join(root,'image.png'),Buffer.from([0x89,0x50,0x4e,0x47,0,0,0,0]));
  writeFileSync(join(root,'.env'),'SECRET=1');
  mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub','notes.txt'),'note');
  return root;
}
const tasks=[{id:'2d5a1ea8-1fa3-4b35-aa49-b187c9d76610',title:'R1'}];

test('lists files with size, digest and producing task, skipping hidden files, links and sensitive names',()=>{
  const root=folder();try{
    const outside=mkdtempSync(join(tmpdir(),'orbit-outside-'));writeFileSync(join(outside,'secret.md'),'x');
    symlinkSync(join(outside,'secret.md'),join(root,'link.md'));
    const list=listDeliverables(root,tasks);
    assert.deepEqual(list.items.map(i=>i.path),['README.md','empty.md','image.png','sub/notes.txt','table.csv','task-2d5a1ea8.md']);
    const report=list.items.find(i=>i.path==='task-2d5a1ea8.md')!;
    assert.equal(report.taskId,tasks[0].id);assert.match(report.sha256,/^[a-f0-9]{64}$/);assert.equal(report.mediaType,'text/markdown');
    assert.equal(list.items.find(i=>i.path==='README.md')!.taskId,null);
    assert.equal(list.skipped,2,'.env and the symlink are skipped, never followed');
    rmSync(outside,{recursive:true,force:true});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('format checks separate existence and readable structure from meaning',()=>{
  const root=folder();try{
    const items=listDeliverables(root,tasks).items,by=(p:string)=>items.find(i=>i.path===p)!;
    assert.deepEqual(by('task-2d5a1ea8.md').checks,{exists:true,readable:true,nonEmpty:true,format:'passed',meaning:'unverified',evidence:{status:'unverified',numbers:0,matched:0,unmatched:[],results:[],inputPaths:[]}});
    assert.equal(by('empty.md').checks.nonEmpty,false);assert.equal(by('empty.md').checks.format,'failed');
    assert.equal(by('table.csv').checks.format,'passed');
    assert.equal(by('image.png').checks.format,'unsupported');assert.equal(by('image.png').previewable,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('preview returns sanitized text only for supported types inside the folder',()=>{
  const root=folder();try{
    writeFileSync(join(root,'leak.md'),'# Note\nkey sk-abcdefghijklmnopqrstuv\n<script>alert(1)</script>');
    const preview=previewDeliverable(root,'leak.md');
    assert.equal(preview.kind,'text');assert.doesNotMatch(preview.kind==='text'?preview.text:'',/sk-abcdefghijklmnopqrstuv/);
    assert.match(preview.kind==='text'?preview.text:'',/<script>/,'returned as text; rendering escapes it');
    assert.deepEqual(previewDeliverable(root,'image.png'),{kind:'unsupported',mediaType:'image/png'});
    for(const bad of ['../x.md','/etc/passwd','sub/../../x','.env','sub','missing.md','a\u0000b.md'])assert.throws(()=>previewDeliverable(root,bad),/DELIVERABLE_NOT_FOUND|INVALID_PATH/,bad);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('large text previews are truncated and flagged',()=>{
  const root=folder();try{
    writeFileSync(join(root,'big.txt'),'a'.repeat(200_000));
    const preview=previewDeliverable(root,'big.txt');
    assert.equal(preview.kind,'text');if(preview.kind==='text'){assert.equal(preview.truncated,true);assert.ok(preview.text.length<=64_000);}
  }finally{rmSync(root,{recursive:true,force:true});}
});
